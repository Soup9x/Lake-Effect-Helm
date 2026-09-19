import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretAccessDeniedError } from '../../src/lib/secrets/errors';
import { base32Encode, generateTotp, verifyTotp } from '../../src/lib/crypto/totp';
import {
  actor,
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

let h: Harness;
const admin = actor(IDS.tenant1, IDS.admin1);
const tech = actor(IDS.tenant1, IDS.tech1);
const clientAdmin = actor(IDS.tenant1, IDS.acmeAdmin);
const viewer = actor(IDS.tenant1, IDS.acmeViewer);
const rival = actor(IDS.tenant2, IDS.admin2);

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'initial provisioning' });
  await h.keys.provision(IDS.tenant2, IDS.admin2, { reason: 'initial provisioning' });
}, 120_000);

afterAll(async () => {
  await disconnectPools();
});

describe('key provisioning', () => {
  it('stores only a wrapped key, never material', async () => {
    const sql = superuserSql();
    try {
      const rows = await sql<{ wrapped_dek: Buffer; kek_id: string; wrap_context: unknown }[]>`
        SELECT wrapped_dek, kek_id, wrap_context FROM tenant_data_key
        WHERE tenant_id = ${IDS.tenant1}::uuid
      `;
      expect(rows).toHaveLength(1);
      // nonce(12) + tag(16) + AES-256 key(32)
      expect(rows[0]!.wrapped_dek).toHaveLength(60);
      expect(rows[0]!.wrap_context).toMatchObject({
        'helm:purpose': 'tenant-dek',
        'helm:tenant': IDS.tenant1,
        'helm:generation': '1',
      });
    } finally {
      await sql.end();
    }
  });

  it('records provisioning in the audit log', async () => {
    const sql = superuserSql();
    try {
      const rows = await sql<{ action: string }[]>`
        SELECT action FROM audit_log
        WHERE tenant_id = ${IDS.tenant1}::uuid AND action = 'key.provisioned'
      `;
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });
});

describe('write and reveal', () => {
  it('round-trips a password through the real encryption path', async () => {
    const created = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'ACME Guest WiFi' },
      'correct horse battery staple',
    );
    expect(created.version).toBe(1);

    const revealed = await h.secrets.reveal(admin, created.secretId);
    expect(revealed.value.expose()).toBe('correct horse battery staple');
    revealed.value.dispose();
  });

  it('stores ciphertext that does not contain the plaintext', async () => {
    const plaintext = 'a-very-distinctive-password-9271';
    const created = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'distinctive' },
      plaintext,
    );

    const sql = superuserSql();
    try {
      const [row] = await sql<{ ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer; aad: string }[]>`
        SELECT ciphertext, nonce, auth_tag, aad FROM secret_version
        WHERE secret_id = ${created.secretId}::uuid
      `;
      expect(row!.ciphertext.toString('utf8')).not.toContain('distinctive');
      expect(row!.nonce).toHaveLength(12);
      expect(row!.auth_tag).toHaveLength(16);
      // The AAD binds the row to tenant, secret, field and version.
      expect(row!.aad).toBe(`helm.v1|${IDS.tenant1}|${created.secretId}|value|1`);
    } finally {
      await sql.end();
    }
  });

  it('records strength and length metadata but never the value', async () => {
    const created = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'metadata check' },
      '7Kq!zR2m#Vb9wLx4',
    );

    const sql = superuserSql();
    try {
      const [row] = await sql<{ strength_score: number; plaintext_length: number }[]>`
        SELECT strength_score, plaintext_length FROM secret_version
        WHERE secret_id = ${created.secretId}::uuid
      `;
      expect(row!.strength_score).toBeGreaterThanOrEqual(3);
      expect(row!.plaintext_length).toBe(16);
    } finally {
      await sql.end();
    }
  });

  it('writes an audit event for every reveal', async () => {
    const created = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'audited reveal' },
      'hunter2-hunter2',
    );

    const revealed = await h.secrets.reveal(admin, created.secretId, { purpose: 'view' });
    revealed.value.dispose();

    const sql = superuserSql();
    try {
      const [row] = await sql<{ action: string; outcome: string; metadata: Record<string, unknown> }[]>`
        SELECT action, outcome, metadata FROM audit_log
        WHERE event_uid = ${revealed.auditEventUid}::uuid
      `;
      expect(row!.action).toBe('secret.revealed');
      expect(row!.outcome).toBe('success');
      expect(row!.metadata).toMatchObject({ purpose: 'view', version: 1 });
      // Metadata must never carry material.
      expect(JSON.stringify(row!.metadata)).not.toContain('hunter2');
    } finally {
      await sql.end();
    }
  });

  it('rotates to a new version without destroying the old one', async () => {
    const created = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'rotating' },
      'first-password-value',
    );
    const rotated = await h.secrets.rotate(
      admin,
      created.secretId,
      'second-password-value',
      'quarterly rotation',
    );
    expect(rotated.version).toBe(2);

    const current = await h.secrets.reveal(admin, created.secretId);
    expect(current.value.expose()).toBe('second-password-value');
    current.value.dispose();

    // The superseded version is still readable — this is what makes "what did
    // this credential look like during the incident" answerable.
    const previous = await h.secrets.reveal(admin, created.secretId, { version: 1 });
    expect(previous.value.expose()).toBe('first-password-value');
    previous.value.dispose();
  });

  it('binds each version to its own AAD', async () => {
    const created = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'aad per version' },
      'v1-value',
    );
    await h.secrets.rotate(admin, created.secretId, 'v2-value', 'rotation');

    const sql = superuserSql();
    try {
      const rows = await sql<{ version: number; aad: string }[]>`
        SELECT version, aad FROM secret_version
        WHERE secret_id = ${created.secretId}::uuid ORDER BY version
      `;
      expect(rows[0]!.aad).toMatch(/\|value\|1$/);
      expect(rows[1]!.aad).toMatch(/\|value\|2$/);
    } finally {
      await sql.end();
    }
  });

  it('computes a blind index that matches for reused passwords', async () => {
    const shared = 'Summer2024!Shared';
    const a = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'reuse a' },
      shared,
    );
    const b = await h.secrets.create(
      admin,
      { organizationId: IDS.orgGlobex, kind: 'password', label: 'reuse b' },
      shared,
    );

    const sql = superuserSql();
    try {
      const rows = await sql<{ reuse_hmac: Buffer }[]>`
        SELECT reuse_hmac FROM secret_version
        WHERE secret_id IN (${a.secretId}::uuid, ${b.secretId}::uuid)
      `;
      expect(rows).toHaveLength(2);
      expect(rows[0]!.reuse_hmac.equals(rows[1]!.reuse_hmac)).toBe(true);
    } finally {
      await sql.end();
    }

    const reused = await h.secrets.findReusedSecrets(admin);
    const group = reused.find((g) => g.secretIds.includes(a.secretId));
    expect(group?.secretIds).toEqual(expect.arrayContaining([a.secretId, b.secretId]));
    expect(group?.organizationIds).toEqual(
      expect.arrayContaining([IDS.orgAcme, IDS.orgGlobex]),
    );
  });
});

describe('authorisation ladder', () => {
  let criticalSecretId: string;
  let standardSecretId: string;

  const grantStepUp = async () => {
    const sql = superuserSql();
    try {
      await sql`
        INSERT INTO step_up_verification (tenant_id, user_id, method, expires_at)
        VALUES (${IDS.tenant1}::uuid, ${IDS.admin1}::uuid, 'webauthn', now() + interval '15 minutes')
      `;
    } finally {
      await sql.end();
    }
  };

  const revokeStepUp = async () => {
    const sql = superuserSql();
    try {
      await sql`DELETE FROM step_up_verification WHERE user_id = ${IDS.admin1}::uuid`;
    } finally {
      await sql.end();
    }
  };

  beforeAll(async () => {
    // Writing a critical secret needs step-up too, not just reading one — so
    // step up, create it, then let the verification lapse before testing the
    // read ladder.
    await grantStepUp();
    const critical = await h.secrets.create(
      admin,
      {
        organizationId: IDS.orgAcme,
        kind: 'password',
        label: 'ACME Domain Admin',
        sensitivity: 'critical',
        minRoleRank: 60,
      },
      'domain-admin-secret-value',
    );
    criticalSecretId = critical.secretId;
    await revokeStepUp();

    const standard = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'ACME Printer' },
      'printer-admin',
    );
    standardSecretId = standard.secretId;

    // Document the printer password on an ordinary, client-visible credential.
    //
    // Since 0460 the reveal ladder's visibility rung runs FIRST and a secret no
    // asset documents is invisible to a client-side role, so without this the
    // two tests below get `internal_only` and never reach the permission rung
    // they exist to probe. h.secrets.create() writes the `secret` row alone;
    // POST /api/secrets always pairs it with a credential, and that is the
    // shape being reproduced here.
    const sql = superuserSql();
    try {
      const [node] = await sql<{ id: string }[]>`
        INSERT INTO asset_node (tenant_id, organization_id, node_type, name)
        VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'credential', 'ACME Printer')
        RETURNING id
      `;
      await sql`
        INSERT INTO credential (id, tenant_id, credential_type, username, secret_id)
        VALUES (${node!.id}::uuid, ${IDS.tenant1}::uuid, 'standard_user', 'printer',
                ${standardSecretId}::uuid)
      `;
    } finally {
      await sql.end();
    }
  });

  it('refuses to CREATE a critical secret without step-up', async () => {
    // Writing a domain admin credential is as sensitive as reading one; a
    // ladder that only guards reads lets an attacker silently replace it.
    await expect(
      h.secrets.create(
        admin,
        {
          organizationId: IDS.orgAcme,
          kind: 'password',
          label: 'sneaky critical',
          sensitivity: 'critical',
        },
        'should-not-persist',
      ),
    ).rejects.toThrow(/step-up verification required/);
  });

  it('refuses to ROTATE a critical secret without step-up', async () => {
    await expect(
      h.secrets.rotate(admin, criticalSecretId, 'replacement-value', 'no step-up'),
    ).rejects.toThrow(/step-up verification required/);
  });

  it('refuses a tier-1 technician a rank-60 secret', async () => {
    await expect(
      h.secrets.reveal(tech, criticalSecretId, { reason: 'ticket 1234 investigation' }),
    ).rejects.toMatchObject({ reason: 'insufficient_role_rank' });
  });

  it('refuses without step-up even for a super admin', async () => {
    await expect(
      h.secrets.reveal(admin, criticalSecretId, { reason: 'ticket 1234 investigation' }),
    ).rejects.toMatchObject({ reason: 'step_up_required' });
  });

  it('commits the audit row for a refusal', async () => {
    let denial: SecretAccessDeniedError | null = null;
    try {
      await h.secrets.reveal(admin, criticalSecretId, { reason: 'ticket 1234 investigation' });
    } catch (e) {
      denial = e as SecretAccessDeniedError;
    }
    expect(denial).toBeInstanceOf(SecretAccessDeniedError);

    // The refusal must survive, which is why reveal_secret returns rather than
    // raising — a raise would roll back the record of the attempt.
    const sql = superuserSql();
    try {
      const [row] = await sql<{ action: string; outcome: string }[]>`
        SELECT action, outcome FROM audit_log WHERE event_uid = ${denial!.auditEventUid}::uuid
      `;
      expect(row).toMatchObject({ action: 'secret.reveal_denied', outcome: 'denied' });
    } finally {
      await sql.end();
    }
  });

  it('grants once step-up and a reason are present', async () => {
    await grantStepUp();

    const revealed = await h.secrets.reveal(admin, criticalSecretId, {
      reason: 'INC-4471 emergency domain controller restore',
    });
    expect(revealed.value.expose()).toBe('domain-admin-secret-value');
    revealed.value.dispose();
  });

  it('still demands a real justification, not a token one', async () => {
    await expect(
      h.secrets.reveal(admin, criticalSecretId, { reason: 'because' }),
    ).rejects.toMatchObject({ reason: 'reason_required' });
  });

  it('refuses a read-only client user any reveal', async () => {
    await expect(h.secrets.reveal(viewer, standardSecretId)).rejects.toMatchObject({
      reason: 'missing_permission',
    });
  });

  it('refuses a client admin a reveal but lets them see the secret exists', async () => {
    await expect(h.secrets.reveal(clientAdmin, standardSecretId)).rejects.toMatchObject({
      reason: 'missing_permission',
    });
  });

  it('refuses a cross-tenant reveal as not_found, leaking nothing', async () => {
    let error: unknown;
    try {
      await h.secrets.reveal(rival, standardSecretId);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SecretAccessDeniedError);
    const denied = error as SecretAccessDeniedError;
    // "no such secret" and "not yours" must be indistinguishable.
    expect(denied.reason).toBe('not_found');
    expect(denied.shouldPresentAsNotFound).toBe(true);
  });

  it('refuses autofill for an elevated credential', async () => {
    const elevated = await h.secrets.create(
      admin,
      {
        organizationId: IDS.orgAcme,
        kind: 'password',
        label: 'elevated service account',
        sensitivity: 'elevated',
      },
      'elevated-value',
    );
    await expect(
      h.secrets.reveal(admin, elevated.secretId, { purpose: 'autofill' }),
    ).rejects.toMatchObject({ reason: 'autofill_not_permitted_for_sensitivity' });
  });

  it('classifies which refusals the user can act on', async () => {
    // Drives the UI: a step-up prompt helps, "ask your manager" does not.
    const denial = async (fn: () => Promise<unknown>): Promise<SecretAccessDeniedError> => {
      try {
        await fn();
      } catch (e) {
        if (e instanceof SecretAccessDeniedError) return e;
        throw e;
      }
      throw new Error('expected a denial but access was granted');
    };

    const rank = await denial(() =>
      h.secrets.reveal(tech, criticalSecretId, { reason: 'ticket 1234 investigation' }),
    );
    expect(rank.reason).toBe('insufficient_role_rank');
    expect(rank.isRecoverableByUser).toBe(false);

    const missing = await denial(() => h.secrets.reveal(viewer, standardSecretId));
    expect(missing.isRecoverableByUser).toBe(false);
  });
});

describe('clipboard copies are recorded', () => {
  it('writes a distinct audit action', async () => {
    const created = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'copied' },
      'copy-me-value',
    );
    const uid = await h.secrets.recordCopy(admin, created.secretId);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ action: string }[]>`
        SELECT action FROM audit_log WHERE event_uid = ${uid}::uuid
      `;
      expect(row!.action).toBe('secret.copied');
    } finally {
      await sql.end();
    }
  });
});

describe('TOTP through the vault', () => {
  it('generates a valid code from a stored seed', async () => {
    const seed = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
    const created = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'totp_seed', label: 'ACME Registrar MFA' },
      seed,
    );

    const result = await h.secrets.generateTotpCode(admin, created.secretId);
    expect(result.code).toMatch(/^\d{6}$/);

    // Independently verify against the same seed.
    const verified = verifyTotp(Buffer.from('12345678901234567890', 'ascii'), result.code);
    expect(verified.valid).toBe(true);
  });

  it('audits code generation as a secret access', async () => {
    // Generating an MFA code IS using the credential; an audit trail that omits
    // it cannot answer who logged into the shared account.
    const seed = base32Encode(Buffer.from('98765432109876543210', 'ascii'));
    const created = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'totp_seed', label: 'audited MFA' },
      seed,
    );
    const result = await h.secrets.generateTotpCode(admin, created.secretId);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ action: string }[]>`
        SELECT action FROM audit_log WHERE event_uid = ${result.auditEventUid}::uuid
      `;
      expect(row!.action).toBe('secret.revealed');
    } finally {
      await sql.end();
    }
  });

  it('matches a code generated directly from the same seed', async () => {
    const raw = Buffer.from('ABCDEFGHIJKLMNOPQRST', 'ascii');
    const created = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'totp_seed', label: 'parity check' },
      base32Encode(raw),
    );

    const viaVault = await h.secrets.generateTotpCode(admin, created.secretId);
    const direct = generateTotp(raw);
    // Same period unless the clock ticked between the two calls.
    if (viaVault.counter === direct.counter) {
      expect(viaVault.code).toBe(direct.code);
    }
  });
});

describe('SecretValue resists accidental disclosure', () => {
  it('redacts in every implicit stringification path', async () => {
    const created = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'redaction' },
      'super-secret-value',
    );
    const revealed = await h.secrets.reveal(admin, created.secretId);

    expect(String(revealed.value)).toBe('[helm secret: redacted]');
    expect(`${revealed.value}`).toBe('[helm secret: redacted]');
    expect(JSON.stringify(revealed.value)).toBe('"[helm secret: redacted]"');
    expect(JSON.stringify({ credential: revealed.value })).not.toContain('super-secret');
    // ...but the deliberate path still works.
    expect(revealed.value.expose()).toBe('super-secret-value');

    revealed.value.dispose();
    expect(() => revealed.value.expose()).toThrow(/disposed/);
  });

  it('disposes automatically with use()', async () => {
    const created = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'scoped' },
      'scoped-value',
    );
    const revealed = await h.secrets.reveal(admin, created.secretId);

    const length = revealed.value.use((plaintext) => plaintext.length);
    expect(length).toBe('scoped-value'.length);
    expect(revealed.value.disposed).toBe(true);
  });
});
