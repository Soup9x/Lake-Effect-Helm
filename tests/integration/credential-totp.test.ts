/**
 * TOTP on a credential, end to end through the routes.
 *
 * The property that matters most here is a negative one: the seed must never
 * reach a client. It is a permanent code-generating key, so a single leak hands
 * over every future code for the account with nothing in the audit log after the
 * first. Three tests below exist purely to assert that it does not — through the
 * store response, through the code response, and through the generic reveal
 * route a browser could call directly.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { base32Decode, base32Encode, verifyTotp } from '../../src/lib/crypto/totp';
import {
  buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql, type Harness,
} from './harness';

import { POST as createCredential } from '../../src/app/api/secrets/route';
import { PUT as putTotp, DELETE as deleteTotp } from '../../src/app/api/assets/[nodeId]/totp/route';
import { POST as postCode } from '../../src/app/api/assets/[nodeId]/totp/code/route';
import { POST as revealSecret } from '../../src/app/api/secrets/[secretId]/reveal/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => { currentUser = { id, email }; };

/** RFC 6238's SHA1 seed, so a generated code can be checked independently. */
const RFC_SEED_BYTES = Buffer.from('12345678901234567890', 'ascii');
const RFC_SEED = base32Encode(RFC_SEED_BYTES);

const request = (method: string, payload?: unknown) =>
  new NextRequest(new Request('https://helm.test/api/x', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));

const body = async (r: Response) => (await r.json()) as Record<string, unknown>;
const nodeParams = (nodeId: string) => ({ params: Promise.resolve({ nodeId }) });
const secretParams = (secretId: string) => ({ params: Promise.resolve({ secretId }) });

/** A credential with a password and, optionally, a seed in the same request. */
async function makeCredential(
  label: string,
  extra: Record<string, unknown> = {},
): Promise<{ credentialId: string; secretId: string; totpSecretId?: string }> {
  const response = await createCredential(request('POST', {
    organizationId: IDS.orgAcme,
    label,
    value: 'a-password-that-is-long-enough',
    credentialType: 'service_account',
    ...extra,
  }));
  expect(response.status).toBe(200);
  const payload = await body(response);
  return payload as { credentialId: string; secretId: string; totpSecretId?: string };
}

/** The seed as actually stored, read with superuser rights. */
async function storedSeed(totpSecretId: string): Promise<string> {
  const sql = superuserSql();
  try {
    const [row] = await sql<{ kind: string }[]>`
      SELECT kind::text FROM secret WHERE id = ${totpSecretId}::uuid
    `;
    expect(row!.kind).toBe('totp_seed');
  } finally {
    await sql.end({ timeout: 5 });
  }
  // Through the service, which is the only thing that can decrypt it.
  const revealed = await h.secrets.reveal(
    { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
    totpSecretId,
    { purpose: 'view' },
  );
  try {
    return revealed.value.expose();
  } finally {
    revealed.value.dispose();
  }
}

/*
 * No teardown between tests, deliberately.
 *
 * secret_version refuses DELETE by trigger — it is append-only, which is what
 * makes "what did this credential look like in March" answerable — so a suite
 * cannot tidy up after itself even as superuser. Each test makes its own
 * credential with its own label instead, the same way secrets.test.ts does.
 */

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'totp tests' });
  await h.keys.provision(IDS.tenant2, IDS.admin2, { reason: 'totp tests' });
}, 180_000);

afterAll(async () => {
  await disconnectPools();
});

// ---------------------------------------------------------------------------
describe('storing a seed', () => {
  it('captures one alongside the password, in the same request', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Registrar with MFA', { totpSeed: RFC_SEED });

    expect(created.totpSecretId).toBeTruthy();
    expect(await storedSeed(created.totpSecretId!)).toBe(RFC_SEED);

    // It is a SEPARATE secret of the pinned kind, not the password's own row —
    // 0070's composite FK refuses anything else in that slot.
    expect(created.totpSecretId).not.toBe(created.secretId);

    const sql = superuserSql();
    try {
      const [row] = await sql<{
        totp_secret_id: string; totp_algorithm: string; totp_digits: number;
        totp_period_seconds: number; totp_secret_kind: string;
      }[]>`
        SELECT totp_secret_id::text, totp_algorithm, totp_digits, totp_period_seconds,
               totp_secret_kind::text
        FROM credential WHERE id = ${created.credentialId}::uuid
      `;
      expect(row).toMatchObject({
        totp_secret_id: created.totpSecretId,
        totp_algorithm: 'SHA1',
        totp_digits: 6,
        totp_period_seconds: 30,
        // The generated discriminator that carries the FK.
        totp_secret_kind: 'totp_seed',
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('never echoes the seed back to the caller', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await createCredential(request('POST', {
      organizationId: IDS.orgAcme,
      label: 'No echo',
      value: 'a-password-that-is-long-enough',
      credentialType: 'service_account',
      totpSeed: RFC_SEED,
    }));
    const raw = JSON.stringify(await body(response));
    expect(raw).not.toContain(RFC_SEED);
    expect(raw).not.toContain(RFC_SEED.toLowerCase());
  });

  it('takes an otpauth URI and believes its parameters', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Eight digit vendor');
    const response = await putTotp(
      request('PUT', {
        seed:
          'otpauth://totp/Acme:admin@acme.test?secret=' + RFC_SEED +
          '&issuer=Acme&algorithm=SHA256&digits=8&period=60',
      }),
      nodeParams(created.credentialId),
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      algorithm: 'SHA256', digits: 8, periodSeconds: 60,
      issuer: 'Acme', account: 'admin@acme.test',
    });

    const sql = superuserSql();
    try {
      const [row] = await sql<{ totp_algorithm: string; totp_digits: number }[]>`
        SELECT totp_algorithm, totp_digits FROM credential
        WHERE id = ${created.credentialId}::uuid
      `;
      expect(row).toMatchObject({ totp_algorithm: 'SHA256', totp_digits: 8 });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses a seed that is not base32, storing nothing', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await createCredential(request('POST', {
      organizationId: IDS.orgAcme,
      label: 'Bad seed',
      value: 'a-password-that-is-long-enough',
      credentialType: 'service_account',
      totpSeed: 'JBSWY3DP0HPK3PXP',
    }));
    expect(response.status).toBe(400);

    // The whole request refused: no credential, no password secret, nothing to
    // clean up. A half-stored credential is worse than a rejected form.
    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM asset_node WHERE name = 'Bad seed'
      `;
      expect(row!.n).toBe('0');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  /*
   * Replacing rotates the existing secret rather than creating a second one. Two
   * rows for one slot would orphan the first — nothing references it and nothing
   * lists it, while it still holds live key material.
   */
  it('replaces a seed as a rotation of the same secret', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Re-enrolled', { totpSeed: RFC_SEED });
    const first = created.totpSecretId!;

    const replacement = base32Encode(Buffer.from('98765432109876543210', 'ascii'));
    const response = await putTotp(
      request('PUT', { seed: replacement, reason: 'vendor reset MFA' }),
      nodeParams(created.credentialId),
    );
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.totpSecretId).toBe(first);
    expect(payload.version).toBe(2);
    expect(await storedSeed(first)).toBe(replacement);

    // Append-only: version 1 is superseded, not gone.
    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM secret_version WHERE secret_id = ${first}::uuid
      `;
      expect(row!.n).toBe('2');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('detaches a seed without destroying its history', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Detach me', { totpSeed: RFC_SEED });

    const response = await deleteTotp(request('DELETE'), nodeParams(created.credentialId));
    expect(response.status).toBe(200);

    const sql = superuserSql();
    try {
      const [cred] = await sql<{ totp_secret_id: string | null }[]>`
        SELECT totp_secret_id::text FROM credential WHERE id = ${created.credentialId}::uuid
      `;
      expect(cred!.totp_secret_id).toBeNull();
      const [versions] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM secret_version
        WHERE secret_id = ${created.totpSecretId!}::uuid
      `;
      expect(versions!.n).toBe('1');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

// ---------------------------------------------------------------------------
describe('generating a code', () => {
  it('produces a code that verifies against the seed, server-side', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Codes please', { totpSeed: RFC_SEED });

    const response = await postCode(request('POST', {}), nodeParams(created.credentialId));
    expect(response.status).toBe(200);
    const payload = await body(response);

    expect(payload.code).toMatch(/^\d{6}$/);
    expect(payload.periodSeconds).toBe(30);
    expect(typeof payload.secondsRemaining).toBe('number');
    expect(payload.secondsRemaining as number).toBeGreaterThanOrEqual(0);
    expect(payload.secondsRemaining as number).toBeLessThanOrEqual(30);

    // Independently verified against the RFC seed, so this is the real
    // algorithm over the real stored bytes and not a plausible-looking number.
    expect(verifyTotp(RFC_SEED_BYTES, payload.code as string, { window: 1 }).valid).toBe(true);
  });

  it('honours the stored digit count and period', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Eight digits');
    await putTotp(
      request('PUT', { seed: RFC_SEED, digits: 8, periodSeconds: 60 }),
      nodeParams(created.credentialId),
    );

    const payload = await body(await postCode(request('POST', {}), nodeParams(created.credentialId)));
    expect(payload.code).toMatch(/^\d{8}$/);
    expect(payload.periodSeconds).toBe(60);
    expect(payload.digits).toBe(8);
  });

  it('never returns the seed, nor anything it could be recovered from', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('No seed in the body', { totpSeed: RFC_SEED });

    const raw = JSON.stringify(await body(
      await postCode(request('POST', {}), nodeParams(created.credentialId)),
    ));
    expect(raw).not.toContain(RFC_SEED);
    expect(raw).not.toContain(RFC_SEED.toLowerCase());
    // Nor the raw bytes in any obvious encoding.
    expect(raw).not.toContain(RFC_SEED_BYTES.toString('hex'));
    expect(raw).not.toContain(RFC_SEED_BYTES.toString('base64'));
    expect(raw).not.toContain('12345678901234567890');
  });

  it('audits every generation as a secret access', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Audited', { totpSeed: RFC_SEED });

    const first = await body(await postCode(request('POST', {}), nodeParams(created.credentialId)));
    const second = await body(await postCode(request('POST', {}), nodeParams(created.credentialId)));

    // Two generations, two audit rows: a technician who watched the code roll
    // over accessed the credential twice, and the trail has to say so.
    expect(first.auditEventUid).not.toBe(second.auditEventUid);

    const sql = superuserSql();
    try {
      const rows = await sql<{ action: string; entity_id: string }[]>`
        SELECT action, entity_id::text FROM audit_log
        WHERE event_uid IN (${first.auditEventUid as string}::uuid,
                            ${second.auditEventUid as string}::uuid)
      `;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.action).toBe('secret.revealed');
        expect(row.entity_id).toBe(created.totpSecretId);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('404s on a credential with no seed', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Password only');
    const response = await postCode(request('POST', {}), nodeParams(created.credentialId));
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('who may do what', () => {
  it('refuses a code to a user without secret:reveal', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Gated', { totpSeed: RFC_SEED });

    // A read-only client user holds secret:read but not secret:reveal.
    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await postCode(request('POST', {}), nodeParams(created.credentialId));
    expect(response.status).toBe(403);

  });

  it('refuses to store a seed for a user without secret:write', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Not yours to enrol');

    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await putTotp(
      request('PUT', { seed: RFC_SEED }),
      nodeParams(created.credentialId),
    );
    expect(response.status).toBe(403);

  });

  it('hides another tenant’s credential entirely', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Tenant one only', { totpSeed: RFC_SEED });

    // RLS matches no row, so "not there" and "not yours" are one answer.
    asUser(IDS.admin2, 'admin@contoso.test');
    expect((await postCode(request('POST', {}), nodeParams(created.credentialId))).status).toBe(404);
    expect((await putTotp(request('PUT', { seed: RFC_SEED }),
      nodeParams(created.credentialId))).status).toBe(404);

  });
});

// ---------------------------------------------------------------------------
describe('the seed is not revealable through the browser door', () => {
  /*
   * The load-bearing test.
   *
   * /api/secrets/{id}/reveal is the route the credential page's RevealButton
   * calls, and it returns plaintext for any secret it is given. Before this
   * feature there was no way to store a totp_seed, so nothing could be pulled
   * through it; the moment seeds exist, that route would hand over a permanent
   * code-generating key to anybody with secret:reveal — making the gate on the
   * code endpoint decorative, since every future code becomes computable
   * off the record.
   */
  it('refuses a totp_seed even to somebody who may reveal the password', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Seed is not readable', { totpSeed: RFC_SEED });

    // The same actor CAN reveal the password on the same credential, so this is
    // the kind being refused rather than the permission.
    const password = await revealSecret(
      request('POST', { purpose: 'view' }),
      secretParams(created.secretId),
    );
    expect(password.status).toBe(200);
    expect((await body(password)).value).toBe('a-password-that-is-long-enough');

    const seed = await revealSecret(
      request('POST', { purpose: 'view' }),
      secretParams(created.totpSecretId!),
    );
    expect(seed.status).toBe(403);
    const refused = JSON.stringify(await body(seed));
    expect(refused).not.toContain(RFC_SEED);
  });

  /*
   * The attempt is still audited. Refusing after the reveal rather than before
   * means somebody probing for seeds through the browser route leaves a trail,
   * which is worth more than saving one decryption.
   */
  it('records the attempt rather than silently turning it away', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Audited refusal', { totpSeed: RFC_SEED });

    const before = await countReveals(created.totpSecretId!);
    expect((await revealSecret(
      request('POST', { purpose: 'view' }),
      secretParams(created.totpSecretId!),
    )).status).toBe(403);
    expect(await countReveals(created.totpSecretId!)).toBe(before + 1);
  });

  /*
   * The refusal is in the ROUTE, not in the service or the database — and that
   * distinction is the design, not an accident of where the check landed.
   *
   * The offboarding export has to emit seeds: a client taking their accounts back
   * cannot re-enrol without them. That path calls SecretService.reveal from the
   * export worker and never passes through the HTTP route, so blocking the
   * browser door must not also block it. (The export's own 'export' purpose is
   * granted only inside a live export job, which is why this asserts the service
   * is reachable at all rather than driving a whole export.)
   */
  it('still lets a server-side caller read one', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Exportable', { totpSeed: RFC_SEED });

    const revealed = await h.secrets.reveal(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      created.totpSecretId!,
      { purpose: 'view' },
    );
    try {
      // Decodes to the bytes the vendor enrolled, which is what makes an
      // offboarding bundle usable.
      expect(base32Decode(revealed.value.expose())).toEqual(RFC_SEED_BYTES);
    } finally {
      revealed.value.dispose();
    }
  });
});

async function countReveals(secretId: string): Promise<number> {
  const sql = superuserSql();
  try {
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM audit_log
      WHERE entity_id = ${secretId}::uuid AND action = 'secret.revealed'
    `;
    return Number(row!.n);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
