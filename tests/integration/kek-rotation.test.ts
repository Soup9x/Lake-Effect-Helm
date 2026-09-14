/**
 * Master key rotation against the live database.
 *
 * Helm is deployed on-premises with the master key held by the host or by
 * Vault, which makes "what happens when the master key changes" an operational
 * question the customer will actually face — not a hypothetical. The property
 * under test is the one that makes the difference between a routine rotation
 * and an unrecoverable loss of every credential in the system:
 *
 *   a secret written under KEK version 1 must still reveal, unchanged, after
 *   the key ring moves to version 2 and the tenant DEKs are re-wrapped.
 *
 * Runs as the real helm_key_admin role, so the UPDATE is subject to the same
 * grants and RLS policies production has.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DekCache } from '../../src/lib/crypto/dek-cache';
import { LocalMasterKekProvider, parseKeyRing } from '../../src/lib/crypto/kek-local';
import { SecretService } from '../../src/lib/secrets/service';
import { TenantKeyService } from '../../src/lib/secrets/keys';
import { withTenant } from '../../src/lib/db/client';
import { IDS, actor, connectPools, disconnectPools, resetDatabase } from './harness';

const key = () => randomBytes(32).toString('base64');

const ring = (current: string, keys: Record<string, string>) =>
  parseKeyRing(JSON.stringify({ current, keys }), 'file', '/test/master.key');

const V1 = key();
const V2 = key();

/** Rebuild the whole stack around a key ring, as a restart would. */
function stack(provider: LocalMasterKekProvider) {
  const dekCache = new DekCache(provider, { ttlMs: 60_000 });
  return {
    provider,
    dekCache,
    secrets: new SecretService({ dekCache, blindIndex: null }),
    keys: new TenantKeyService(provider),
  };
}

describe('on-premises master key rotation', () => {
  const tenant = IDS.tenant1;
  const admin = IDS.admin1;
  let secretId: string;

  beforeAll(async () => {
    resetDatabase();
    connectPools();

    // Day one: the server boots with a single-version key ring and stores a
    // credential under it.
    const before = stack(new LocalMasterKekProvider(ring('v1', { v1: V1 })));
    await before.keys.provision(tenant, admin, { reason: 'initial provisioning' });

    const created = await before.secrets.create(
      actor(tenant, admin),
      {
        organizationId: IDS.orgAcme,
        kind: 'password',
        label: 'Acme domain admin',
        sensitivity: 'standard',
      },
      'correct horse battery staple',
    );
    secretId = created.secretId;
  }, 120_000);

  afterAll(async () => {
    await disconnectPools();
  });

  it('wraps the tenant DEK under the current key ring version', async () => {
    const custody = await withTenant(actor(tenant, admin), async (tx) => {
      return tx<{ kek_id: string; wrap_provider: string; host_held_kek: boolean }[]>`
        SELECT kek_id, wrap_provider, host_held_kek FROM tenant_data_key WHERE status = 'active'
      `;
    });

    expect(custody[0]).toMatchObject({
      kek_id: 'helm-master/v1',
      wrap_provider: 'local-keyfile',
      // The schema classifies this as host-held without being told: a breach
      // assessment can select on it rather than reconstructing deployment history.
      host_held_kek: true,
    });
  });

  it('re-wraps every DEK onto the new version', async () => {
    // The operator adds v2, points current at it, and restarts. Nothing has
    // touched the database yet.
    const after = stack(new LocalMasterKekProvider(ring('v2', { v1: V1, v2: V2 })));

    const result = await after.keys.rewrapUnderCurrentKek(tenant, admin, 'annual rotation');
    expect(result.rewrapped).toBe(1);
    expect(result.failed).toEqual([]);

    const [row] = await withTenant(actor(tenant, admin), async (tx) => {
      return tx<{ kek_id: string }[]>`
        SELECT kek_id FROM tenant_data_key WHERE status = 'active'
      `;
    });
    expect(row?.kek_id).toBe('helm-master/v2');
  });

  it('still reveals a secret written under the previous KEK version', async () => {
    // The whole point. The DEK never changed, so the ciphertext in
    // secret_version was never touched — only its wrapping moved.
    const after = stack(new LocalMasterKekProvider(ring('v2', { v1: V1, v2: V2 })));

    const revealed = await after.secrets.reveal(actor(tenant, admin), secretId, {
      reason: 'post-rotation verification',
    });
    expect(revealed.value.expose()).toBe('correct horse battery staple');
    revealed.value.dispose();
  });

  it('is idempotent, so an interrupted rotation is resumed by re-running it', async () => {
    const after = stack(new LocalMasterKekProvider(ring('v2', { v1: V1, v2: V2 })));

    const result = await after.keys.rewrapUnderCurrentKek(tenant, admin, 'annual rotation');
    expect(result).toMatchObject({ rewrapped: 0, unchanged: 1, failed: [] });
  });

  it('records the re-wrap in the audit chain', async () => {
    const rows = await withTenant(actor(tenant, admin), async (tx) => {
      return tx<{ action: string; metadata: Record<string, unknown> }[]>`
        SELECT action, metadata FROM audit_log
        WHERE action = 'key.kek_rewrapped'
        ORDER BY occurred_at DESC
      `;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      from_kek_id: 'helm-master/v1',
      to_kek_id: 'helm-master/v2',
      provider: 'local-keyfile',
    });
  });

  it('refuses to strand a DEK when the old key version was dropped too early', async () => {
    // A key ring that no longer holds v2 cannot re-wrap what v2 sealed. The run
    // must report the failure rather than skipping the row silently — the
    // operator is about to delete a key based on this answer.
    const v3 = key();
    const careless = stack(new LocalMasterKekProvider(ring('v3', { v3 })));

    const result = await careless.keys.rewrapUnderCurrentKek(tenant, admin, 'careless rotation');
    expect(result.rewrapped).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toMatch(/not in this server's key ring/);

    // And the row is untouched, so a correctly-configured process can still fix it.
    const [row] = await withTenant(actor(tenant, admin), async (tx) => {
      return tx<{ kek_id: string }[]>`
        SELECT kek_id FROM tenant_data_key WHERE status = 'active'
      `;
    });
    expect(row?.kek_id).toBe('helm-master/v2');
  });

  it('writes an audit row when a rotation completes incompletely', async () => {
    const rows = await withTenant(actor(tenant, admin), async (tx) => {
      return tx<{ outcome: string }[]>`
        SELECT outcome FROM audit_log WHERE action = 'key.kek_rewrap_incomplete'
      `;
    });
    expect(rows[0]?.outcome).toBe('error');
  });

  it('exposes key custody to a compliance reader without exposing key material', async () => {
    const rows = await withTenant(actor(tenant, admin), async (tx) => {
      return tx<{ wrap_provider: string; kek_id: string; host_held_kek: boolean; development_key: boolean }[]>`
        SELECT * FROM helm.key_custody()
      `;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      wrap_provider: 'local-keyfile',
      kek_id: 'helm-master/v2',
      host_held_kek: true,
      development_key: false,
    });
    expect(Object.keys(rows[0] ?? {})).not.toContain('wrapped_dek');
  });
});
