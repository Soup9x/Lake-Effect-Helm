/**
 * TOTP on a credential, end to end through the routes.
 *
 * The property that matters most here is a negative one: the seed must never
 * reach a client. It is a permanent code-generating key, so a single leak hands
 * over every future code for the account with nothing in the audit log after the
 * first. Several tests below exist purely to assert that it does not — through
 * the store response, through the code response, and through the generic reveal
 * route a browser could call directly.
 *
 * The last describe block also pins the AUDIT side of that, which 0590 fixed:
 * refusing the seed is not enough if the refusal is recorded as a successful
 * reveal, because then the log cannot distinguish an attempt to steal the key
 * from ordinary use of the feature.
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
  // Through the service, which is the only thing that can decrypt it, and with
  // the only purpose a seed is readable under — see 0590.
  const revealed = await h.secrets.reveal(
    { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
    totpSecretId,
    { purpose: 'totp' },
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
      const rows = await sql<
        { action: string; entity_id: string; metadata: { purpose?: string } | null }[]
      >`
        SELECT action, entity_id::text, metadata FROM audit_log
        WHERE event_uid IN (${first.auditEventUid as string}::uuid,
                            ${second.auditEventUid as string}::uuid)
      `;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.action).toBe('secret.revealed');
        expect(row.entity_id).toBe(created.totpSecretId);
        /*
         * purpose 'totp', which is what makes this row mean something. Before
         * 0590 it read 'view' — the same as the row a REFUSED attempt to pull
         * the raw seed through /api/secrets/{id}/reveal left behind, so the two
         * were indistinguishable in the log. This is the distinction.
         */
        expect(row.metadata?.purpose).toBe('totp');
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
    const refused = await body(seed);
    expect(JSON.stringify(refused)).not.toContain(RFC_SEED);

    /*
     * The wire contract, pinned. 0590 moved the refusal from the route into
     * reveal_secret, and the status and message are deliberately unchanged by
     * that move — the UI reads the message. What the move ADDS is
     * auditEventUid, which every other denial on this route already carried and
     * this one could not: the route had no audit row to cite, because it was
     * refusing something the database had just approved.
     */
    const error = refused.error as {
      code: string;
      message: string;
      details?: { auditEventUid?: string };
    };
    expect(error.code).toBe('forbidden');
    expect(error.message).toBe(
      'a TOTP seed cannot be read directly — request the current code instead',
    );
    expect(error.details?.auditEventUid).toMatch(/^[0-9a-f-]{36}$/);
  });

  /*
   * THE AUDIT-FIDELITY TEST, and the reason 0590 exists.
   *
   * The refusal always worked. What did not work was the record of it: the route
   * refused AFTER helm.reveal_secret had granted the read and written
   * `secret.revealed` / success, so an attempt to walk off with a permanent
   * code-generating key produced the same audit row as a technician glancing at
   * a code. An auditor had no way to tell them apart, which makes the log
   * useless for exactly the event it is there to catch.
   *
   * Now the rule is a rung in reveal_secret's own ladder: one row, named, and no
   * success row to explain away.
   */
  it('records the refusal as a refusal, not as a successful reveal', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Audited refusal', { totpSeed: RFC_SEED });

    const revealsBefore = await countAudit(created.totpSecretId!, 'secret.revealed');
    const deniedBefore = await countAudit(created.totpSecretId!, 'secret.reveal_denied');

    const response = await revealSecret(
      request('POST', { purpose: 'view' }),
      secretParams(created.totpSecretId!),
    );
    expect(response.status).toBe(403);

    // A denial was recorded...
    expect(await countAudit(created.totpSecretId!, 'secret.reveal_denied')).toBe(deniedBefore + 1);
    // ...and no success was, which is the half that used to be wrong.
    expect(await countAudit(created.totpSecretId!, 'secret.revealed')).toBe(revealsBefore);

    const [row] = await auditRows(created.totpSecretId!, 'secret.reveal_denied');
    expect(row!.outcome).toBe('denied');
    expect(row!.metadata?.cause).toBe('seed_not_directly_revealable');
    expect(row!.metadata?.purpose).toBe('view');
  });

  /*
   * And the two events are now distinguishable by the one field that separates
   * them. This is what an auditor would actually run.
   */
  it('leaves a log an auditor can separate', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Separable', { totpSeed: RFC_SEED });

    await postCode(request('POST', {}), nodeParams(created.credentialId));
    await revealSecret(request('POST', { purpose: 'view' }), secretParams(created.totpSecretId!));

    const sql = superuserSql();
    try {
      const rows = await sql<{ action: string; outcome: string; purpose: string | null }[]>`
        SELECT action, outcome::text, metadata->>'purpose' AS purpose
        FROM audit_log
        WHERE entity_id = ${created.totpSecretId!}::uuid
          AND action IN ('secret.revealed', 'secret.reveal_denied')
        -- By action, not by time. Both rows can land in the same occurred_at
        -- tick, and then a chronological order is decided by the tiebreak rather
        -- than by what happened — a flake waiting for a fast machine. What this
        -- asserts is that the two events are separable, which does not depend on
        -- which came first.
        ORDER BY action
      `;
      expect(rows).toEqual([
        { action: 'secret.reveal_denied', outcome: 'denied', purpose: 'view' },
        { action: 'secret.revealed', outcome: 'success', purpose: 'totp' },
      ]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  /*
   * THE RULE IS IN THE DATABASE, not in the route, and that is the point of
   * moving it. A route check binds one door; a rung in reveal_secret binds every
   * caller — a worker, a service account, and whatever is added next.
   *
   * Before 0590 this same call succeeded, because the service was deliberately
   * left open and only the HTTP route refused.
   */
  it('refuses a server-side caller too, purpose being the whole gate', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Service-side', { totpSeed: RFC_SEED });
    const actor = { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' as const };

    await expect(
      h.secrets.reveal(actor, created.totpSecretId!, { purpose: 'view' }),
    ).rejects.toMatchObject({ reason: 'seed_not_directly_revealable' });

    // ...and the purpose that names the legitimate use is granted.
    const revealed = await h.secrets.reveal(actor, created.totpSecretId!, { purpose: 'totp' });
    try {
      expect(base32Decode(revealed.value.expose())).toEqual(RFC_SEED_BYTES);
    } finally {
      revealed.value.dispose();
    }
  });

  /*
   * The inverse rung. Without it 'totp' would be a purpose any caller could
   * attach to a password reveal, and reading a domain admin password would leave
   * a row that reads like somebody checking an MFA code — the same confusion
   * 0590 set out to remove, pointed the other way.
   */
  it('refuses the totp purpose on something that is not a seed', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('Not a seed', { totpSeed: RFC_SEED });
    const actor = { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' as const };

    await expect(
      h.secrets.reveal(actor, created.secretId, { purpose: 'totp' }),
    ).rejects.toMatchObject({ reason: 'not_a_totp_seed' });
  });

  /*
   * THE EXPORT EXCEPTION IS STILL A GATE, not a hole.
   *
   * A seed is readable under purpose 'export' because a client taking their
   * accounts back cannot re-enrol without it. That purpose was already gated on
   * secret:export AND the secret belonging to a live export job, and 0590 must
   * not have turned it into a way around the new rung: asking for 'export'
   * outside a live job is refused for that reason, not granted.
   */
  it('does not let the export purpose become the way around it', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await makeCredential('No live export', { totpSeed: RFC_SEED });
    const actor = { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' as const };

    await expect(
      h.secrets.reveal(actor, created.totpSecretId!, { purpose: 'export' }),
    ).rejects.toMatchObject({ reason: 'not_in_a_live_export' });
  });
});

/** Audit rows for one secret and action, newest first. */
async function auditRows(
  secretId: string,
  action: string,
): Promise<{ outcome: string; metadata: { cause?: string; purpose?: string } | null }[]> {
  const sql = superuserSql();
  try {
    return await sql<{ outcome: string; metadata: { cause?: string; purpose?: string } | null }[]>`
      SELECT outcome::text, metadata FROM audit_log
      WHERE entity_id = ${secretId}::uuid AND action = ${action}
      ORDER BY occurred_at DESC
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function countAudit(secretId: string, action: string): Promise<number> {
  const sql = superuserSql();
  try {
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM audit_log
      WHERE entity_id = ${secretId}::uuid AND action = ${action}
    `;
    return Number(row!.n);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

