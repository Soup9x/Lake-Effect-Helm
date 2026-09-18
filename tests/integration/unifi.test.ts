/**
 * UniFi Network integration: isolation, authority, and the preservation
 * guarantee.
 *
 * Six things are established, and they are different in kind:
 *
 *   ISOLATION     tenant A cannot see tenant B's network assets, by any query.
 *
 *   AUTHORITY     integration:network:manage and nothing else. A holder of
 *                 tenant:write alone — the tenant's most powerful permission —
 *                 is refused, which is the separation the whole design exists
 *                 for.
 *
 *   PRESERVATION  a sync updates telemetry and leaves every user-edited field
 *                 exactly as a person left it.
 *
 *   MATCHING      the blind index recognises a device it has seen before, so a
 *                 re-sync updates one row instead of inserting a second.
 *
 *   CONCURRENCY   two runs against one mapping cannot both proceed.
 *
 *   CUSTODY       the controller API key goes into `secret` and comes back out
 *                 through reveal_secret(), leaving an audit row — not through a
 *                 bespoke column that quietly bypasses all of it.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import { BlindIndex } from '../../src/lib/crypto/blind-index';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { GET as getMappings, PUT as putMapping } from '../../src/app/api/network/mappings/route';
import { unifiSyncJob } from '../../src/workers/unifi-sync';
import { openAssetField } from '../../src/lib/unifi/fields';
import { FakeUnifi } from '../support/fake-unifi';
import type { JobContext, JobLogger } from '../../src/workers/runtime';
import { DELETE as deleteMapping } from '../../src/app/api/network/mappings/[mappingId]/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

/**
 * A FIXED blind-index key, supplied the way a deployment supplies one.
 *
 * Set through the environment rather than injected, because HELM_BLIND_INDEX_KEY_B64
 * is the documented configuration path and this integration makes it a HARD
 * REQUIREMENT — the upsert key IS the MAC blind index, so without a key there
 * is no way to recognise a device seen before. Reaching past the env var would
 * test a path no deployment uses.
 *
 * Fixed rather than random because the whole point is that one MAC produces one
 * index across two separate syncs.
 */
const BLIND_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.HELM_BLIND_INDEX_KEY_B64 = BLIND_KEY;
const blindIndex = new BlindIndex(BLIND_KEY);

const API_KEY = 'unifi-api-key-that-must-never-appear-in-a-response';

const request = (method: string, payload?: unknown, path = 'https://helm.test/api/network/mappings') =>
  new NextRequest(
    new Request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }),
  );

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

const MAPPING = {
  organizationId: IDS.orgAcme,
  name: 'ACME HQ',
  controllerUrl: 'https://unifi.acme.test',
  unifiSiteId: 'site-1',
  isActive: false,
  pollIntervalSeconds: 300,
  apiKey: API_KEY,
};

async function setRole(userId: string, roleKey: string): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`
      UPDATE membership SET role_key = ${roleKey}
      WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${userId}::uuid
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Give a role exactly one permission set, so "tenant:write alone" can be tested
 * as the brief asks rather than approximated.
 */
async function setRolePermissions(roleKey: string, keys: string[]): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`DELETE FROM role_permission WHERE role_key = ${roleKey}`;
    if (keys.length > 0) {
      await sql`
        INSERT INTO role_permission (role_key, permission_key)
        SELECT ${roleKey}, unnest(${keys}::text[])
      `;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function wipeUnifi(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`DELETE FROM asset_ip_history`;
    await sql`DELETE FROM network_assets`;
    await sql`DELETE FROM unifi_site_mapping`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'unifi tests' });
  await h.keys.provision(IDS.tenant2, IDS.admin2, { reason: 'unifi tests' });
}, 180_000);

afterEach(async () => {
  currentUser = null;
  await wipeUnifi();
});

afterAll(async () => {
  await disconnectPools();
});

/** Configure a mapping through the real route, returning its id. */
async function createMapping(overrides: Partial<typeof MAPPING> = {}): Promise<string> {
  asUser(IDS.admin1, 'admin@northwind.test');
  const response = await putMapping(request('PUT', { ...MAPPING, ...overrides }));
  expect(response.status).toBe(200);
  const mappings = (await body(response)).mappings as { id: string; name: string }[];
  return mappings.find((m) => m.name === (overrides.name ?? MAPPING.name))!.id;
}

describe('who may point Helm at a controller', () => {
  it('lets a holder of integration:network:manage configure one', async () => {
    const id = await createMapping();
    expect(id).toBeTruthy();
  });

  it('REFUSES a holder of tenant:write alone', async () => {
    // The separation the design exists for. tenant:write is the tenant's most
    // powerful permission — it configures how everybody authenticates — and it
    // still does not reach a network controller.
    await setRolePermissions('tier1', ['organization:read', 'asset:read', 'tenant:write']);
    await setRole(IDS.tech1, 'tier1');

    asUser(IDS.tech1, 'tech@northwind.test');
    const response = await putMapping(request('PUT', MAPPING));
    expect(response.status).toBe(403);
  });

  it('REFUSES a holder of a general integration permission', async () => {
    // integration:manage covers the notification webhooks. It must not carry
    // the network scope with it, or the granularity is decorative.
    await setRolePermissions('tier1', ['organization:read', 'asset:read', 'integration:manage']);
    await setRole(IDS.tech1, 'tier1');

    asUser(IDS.tech1, 'tech@northwind.test');
    expect((await putMapping(request('PUT', MAPPING))).status).toBe(403);
  });

  it('accepts the same user once the specific permission is granted', async () => {
    // The mirror of the two refusals above: the gate is this permission, not
    // seniority or a coincidence of the role table.
    //
    // secret:write is in the set because storing the API key goes through the
    // VAULT, which is the whole point of not giving it a column — so
    // configuring a controller needs both the network permission and the
    // ordinary permission to write a credential. Every technician role in the
    // shipped ladder already holds secret:write, so this is not an extra
    // hurdle in practice; it is named here so the requirement is visible.
    await setRolePermissions('tier1', [
      'organization:read', 'asset:read', 'secret:write', 'integration:network:manage',
    ]);
    await setRole(IDS.tech1, 'tier1');

    asUser(IDS.tech1, 'tech@northwind.test');
    expect((await putMapping(request('PUT', MAPPING))).status).toBe(200);
  });

  it('refuses removal without the permission', async () => {
    const id = await createMapping();

    await setRolePermissions('tier1', ['organization:read', 'asset:read', 'tenant:write']);
    await setRole(IDS.tech1, 'tier1');
    asUser(IDS.tech1, 'tech@northwind.test');

    const response = await deleteMapping(request('DELETE'), {
      params: Promise.resolve({ mappingId: id }),
    });
    expect(response.status).toBe(403);
  });

  it('lets any tenant-wide role READ, because a support call needs to', async () => {
    await createMapping();

    await setRolePermissions('tier1', ['organization:read', 'asset:read']);
    await setRole(IDS.tech1, 'tier1');
    asUser(IDS.tech1, 'tech@northwind.test');

    const response = await getMappings(request('GET'));
    expect(response.status).toBe(200);
    expect((await body(response)).mappings).toHaveLength(1);
  });

  afterEach(async () => {
    // Put the seeded ladder back, so one test's permission surgery cannot leak
    // into the next file.
    const sql = superuserSql();
    try {
      await sql`DELETE FROM role_permission WHERE role_key = 'tier1'`;
      await sql`
        INSERT INTO role_permission (role_key, permission_key) VALUES
          ('tier1','organization:read'),('tier1','asset:read'),('tier1','asset:write'),
          ('tier1','asset:link'),('tier1','secret:read'),('tier1','secret:reveal'),
          ('tier1','secret:write'),('tier1','sop:read'),('tier1','sop:execute'),
          ('tier1','user:read'),('tier1','audit:read')
        ON CONFLICT DO NOTHING
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }
    await setRole(IDS.tech1, 'tier2');
  });
});

describe('custody of the controller API key', () => {
  it('stores it in `secret`, not in a column on the mapping', async () => {
    await createMapping();

    const sql = superuserSql();
    try {
      // The mapping references a secret...
      const [mapping] = await sql<{ api_key_secret_id: string | null }[]>`
        SELECT api_key_secret_id FROM unifi_site_mapping
      `;
      expect(mapping!.api_key_secret_id).toBeTruthy();

      // ...and that secret is a real one, with a version holding ciphertext.
      const versions = await sql<{ blob: string }[]>`
        SELECT encode(ciphertext, 'escape') AS blob
        FROM secret_version WHERE secret_id = ${mapping!.api_key_secret_id}::uuid
      `;
      expect(versions).toHaveLength(1);
      expect(versions[0]!.blob).not.toContain(API_KEY);

      // And the mapping table has no credential column at all.
      const columns = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'unifi_site_mapping'
      `;
      expect(columns.map((c) => c.column_name)).not.toContain('api_key_enc');
      expect(columns.map((c) => c.column_name)).not.toContain('credentials_enc');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('writes an audit row when the key is stored', async () => {
    await createMapping();

    const rows = await withTenant(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      async (tx) => tx<{ action: string }[]>`
        SELECT action FROM audit_log
        WHERE action IN ('secret.created', 'integration.network_mapping_created')
        ORDER BY chain_seq DESC LIMIT 5
      `,
    );
    const actions = rows.map((r) => r.action);
    // Both: the credential entering the vault, and the mapping being made.
    expect(actions).toContain('secret.created');
    expect(actions).toContain('integration.network_mapping_created');
  });

  it('is revealable through reveal_secret, which the sync depends on', async () => {
    // helm.is_integration_credential() only knew about integration_connection
    // until 0430. Without the extension there, this reveal is refused
    // 'not_an_integration_credential' and EVERY poll fails.
    await createMapping();

    const sql = superuserSql();
    let secretId = '';
    try {
      const [row] = await sql<{ api_key_secret_id: string }[]>`
        SELECT api_key_secret_id FROM unifi_site_mapping
      `;
      secretId = row!.api_key_secret_id;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const revealed = await h.secrets.reveal(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      secretId,
      { purpose: 'integration', reason: 'checking the credential path end to end' },
    );
    try {
      expect(revealed.value.expose()).toBe(API_KEY);
    } finally {
      revealed.value.dispose();
    }
  });

  it('NEVER returns the key to the browser', async () => {
    await createMapping();
    asUser(IDS.admin1, 'admin@northwind.test');
    const payload = JSON.stringify(await body(await getMappings(request('GET'))));
    expect(payload).not.toContain(API_KEY);
    expect(payload).toContain('"apiKeySet":true');
  });
});

describe('TLS is verified unless a specific certificate is pinned', () => {
  it('refuses a pin that is not a sha256', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putMapping(
      request('PUT', { ...MAPPING, tlsPinnedSha256: 'not-a-fingerprint' }),
    );
    expect(response.status).toBe(400);
  });

  it('records WHO accepted a pin, and when', async () => {
    const pin = 'a'.repeat(64);
    await createMapping({ tlsPinnedSha256: pin } as Partial<typeof MAPPING>);

    const sql = superuserSql();
    try {
      const [row] = await sql<{
        tls_verify: boolean;
        tls_pinned_sha256: string;
        tls_exception_ack_by: string;
        tls_exception_ack_at: Date;
      }[]>`SELECT tls_verify, tls_pinned_sha256, tls_exception_ack_by, tls_exception_ack_at
           FROM unifi_site_mapping`;
      expect(row!.tls_pinned_sha256).toBe(pin);
      expect(row!.tls_verify).toBe(false);
      // Stamped from the session, not passed in, so it cannot be forged.
      expect(row!.tls_exception_ack_by).toBe(IDS.admin1);
      expect(row!.tls_exception_ack_at).toBeInstanceOf(Date);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('cannot disable verification without pinning something', async () => {
    // Unrepresentable, not discouraged: the database refuses the row.
    const sql = superuserSql();
    try {
      await expect(
        sql`
          INSERT INTO unifi_site_mapping (tenant_id, organization_id, name, controller_url,
                                          unifi_site_id, tls_verify)
          VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'blanket',
                  'https://unifi.acme.test', 'site-1', false)
        `,
      ).rejects.toThrow(/no_blanket_disable/);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('cannot pin without an acknowledgment', async () => {
    const sql = superuserSql();
    try {
      await expect(
        sql`
          INSERT INTO unifi_site_mapping (tenant_id, organization_id, name, controller_url,
                                          unifi_site_id, tls_verify, tls_pinned_sha256)
          VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'unacknowledged',
                  'https://unifi.acme.test', 'site-1', false, ${'b'.repeat(64)})
        `,
      ).rejects.toThrow(/pin_acknowledged/);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

/* ------------------------------------------------------------------------- *
 * Driving the real sync worker against a real controller
 * ------------------------------------------------------------------------- */

/** A logger that records rather than prints, so a test can assert on it. */
function recordingLogger(lines: string[]): JobLogger {
  const make = (): JobLogger => ({
    debug: (m) => lines.push(`debug ${m}`),
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
    child: () => make(),
  });
  return make();
}

async function runSync(lines: string[] = []): Promise<Record<string, number>> {
  const ctx: JobContext = { log: recordingLogger(lines), stopping: () => false };
  const result = await unifiSyncJob().run(ctx);
  return result.counts ?? {};
}

const running: FakeUnifi[] = [];
async function controller(options?: Parameters<typeof FakeUnifi.start>[0]): Promise<FakeUnifi> {
  const c = await FakeUnifi.start(options);
  running.push(c);
  return c;
}

/**
 * Point a mapping at a live stub, active and due.
 *
 * Written through the real route so the credential goes through the vault, then
 * activated and pinned directly — the route would refuse to pin a fingerprint
 * the operator has not seen, and the connection test that shows it is a
 * separate act from configuring the mapping.
 */
async function activeMappingFor(c: FakeUnifi): Promise<string> {
  const id = await createMapping({ controllerUrl: c.url, unifiSiteId: 'site-1' });
  const sql = superuserSql();
  try {
    await sql`
      UPDATE unifi_site_mapping
      SET is_active = true,
          tls_verify = false,
          tls_pinned_sha256 = ${c.sha256},
          tls_exception_ack_by = ${IDS.admin1}::uuid,
          tls_exception_ack_at = now(),
          next_poll_at = now() - interval '1 minute'
      WHERE id = ${id}::uuid
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
  return id;
}

const AP = {
  macAddress: 'aa:bb:cc:dd:ee:01',
  ipAddress: '10.2.0.47',
  name: 'acme-ap-lobby',
  model: 'U6-Pro',
  firmwareVersion: '6.6.65',
  state: 'ONLINE',
  uptimeSec: 100_000,
  serialNumber: 'SN-0001',
};

describe('the sync worker', () => {
  afterEach(() => {
    while (running.length) running.pop()!.stop();
  });

  it('imports what the controller reports', async () => {
    const c = await controller({ devices: [AP] });
    await activeMappingFor(c);

    const counts = await runSync();
    expect(counts.polled).toBe(1);
    expect(counts.inserted).toBe(1);

    const sql = superuserSql();
    try {
      const [row] = await sql<{
        model: string; firmware_version: string; is_online: boolean; asset_type: string;
      }[]>`SELECT model, firmware_version, is_online, asset_type FROM network_assets`;
      expect(row!.model).toBe('U6-Pro');
      expect(row!.firmware_version).toBe('6.6.65');
      expect(row!.is_online).toBe(true);
      expect(row!.asset_type).toBe('unifi_device');
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it('MATCHES a device it has seen before, on the blind index', async () => {
    // The upsert key. If the index did not reproduce, every poll would insert a
    // second row for the same hardware, forever.
    const c = await controller({ devices: [AP] });
    await activeMappingFor(c);

    await runSync();

    // Make it due again and poll with changed telemetry.
    const sql = superuserSql();
    try {
      await sql`UPDATE unifi_site_mapping SET next_poll_at = now() - interval '1 minute'`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const c2 = await controller({
      devices: [{ ...AP, firmwareVersion: '6.7.00', uptimeSec: 200_000 }],
    });
    // Repoint the mapping at the second stub, which is a different certificate.
    const sql2 = superuserSql();
    try {
      await sql2`
        UPDATE unifi_site_mapping
        SET controller_url = ${c2.url}, tls_pinned_sha256 = ${c2.sha256}
      `;
    } finally {
      await sql2.end({ timeout: 5 });
    }

    const counts = await runSync();
    expect(counts.updated).toBe(1);
    expect(counts.inserted).toBe(0);

    const sql3 = superuserSql();
    try {
      const rows = await sql3<{ firmware_version: string }[]>`
        SELECT firmware_version FROM network_assets
      `;
      // ONE row, updated — not two.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.firmware_version).toBe('6.7.00');
    } finally {
      await sql3.end({ timeout: 5 });
    }
  }, 30_000);

  it('PRESERVES every user-edited field across a telemetry update', async () => {
    const c = await controller({ devices: [AP] });
    await activeMappingFor(c);
    await runSync();

    // A technician documents the device.
    const sql = superuserSql();
    try {
      await sql`
        UPDATE network_assets SET
          asset_tag = 'ACME-0042',
          department = 'Reception',
          notes = 'Mounted above the front desk. Do not move.',
          maintenance_status = 'maintenance',
          custom_name_enc = ${Buffer.alloc(40, 9)}
      `;
      await sql`UPDATE unifi_site_mapping SET next_poll_at = now() - interval '1 minute'`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const c2 = await controller({
      devices: [{ ...AP, firmwareVersion: '7.0.0', uptimeSec: 999, state: 'UPGRADING' }],
    });
    const sql2 = superuserSql();
    try {
      await sql2`
        UPDATE unifi_site_mapping
        SET controller_url = ${c2.url}, tls_pinned_sha256 = ${c2.sha256}
      `;
    } finally {
      await sql2.end({ timeout: 5 });
    }

    await runSync();

    const sql3 = superuserSql();
    try {
      const [row] = await sql3<{
        firmware_version: string; device_state: string;
        asset_tag: string; department: string; notes: string;
        maintenance_status: string; custom_name_enc: Buffer;
      }[]>`SELECT firmware_version, device_state, asset_tag, department, notes,
                  maintenance_status, custom_name_enc FROM network_assets`;

      // Telemetry moved...
      expect(row!.firmware_version).toBe('7.0.0');
      expect(row!.device_state).toBe('UPGRADING');
      // ...and everything a person wrote is untouched.
      expect(row!.asset_tag).toBe('ACME-0042');
      expect(row!.department).toBe('Reception');
      expect(row!.notes).toBe('Mounted above the front desk. Do not move.');
      expect(row!.maintenance_status).toBe('maintenance');
      expect(row!.custom_name_enc).toEqual(Buffer.alloc(40, 9));
    } finally {
      await sql3.end({ timeout: 5 });
    }
  }, 30_000);

  it('records an IP change in history, and does not re-record a stable one', async () => {
    const c = await controller({ devices: [AP] });
    await activeMappingFor(c);
    await runSync();

    const rerun = async (devices: Record<string, unknown>[]) => {
      const next = await controller({ devices });
      const sql = superuserSql();
      try {
        await sql`
          UPDATE unifi_site_mapping
          SET controller_url = ${next.url}, tls_pinned_sha256 = ${next.sha256},
              next_poll_at = now() - interval '1 minute'
        `;
      } finally {
        await sql.end({ timeout: 5 });
      }
      await runSync();
    };

    // Same address: extends the open row rather than opening another.
    await rerun([AP]);
    // Moved: a new row.
    await rerun([{ ...AP, ipAddress: '10.2.0.99' }]);

    const sql = superuserSql();
    try {
      const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM asset_ip_history`;
      expect(Number(rows[0]!.n)).toBe(2);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 45_000);

  it('marks a device the controller stopped reporting as offline', async () => {
    const c = await controller({ devices: [AP, { ...AP, macAddress: 'aa:bb:cc:dd:ee:02' }] });
    await activeMappingFor(c);
    await runSync();

    const c2 = await controller({ devices: [AP] });
    const sql = superuserSql();
    try {
      await sql`
        UPDATE unifi_site_mapping
        SET controller_url = ${c2.url}, tls_pinned_sha256 = ${c2.sha256},
            next_poll_at = now() - interval '1 minute'
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const counts = await runSync();
    expect(counts.offline).toBe(1);

    const sql2 = superuserSql();
    try {
      const rows = await sql2<{ is_online: boolean }[]>`
        SELECT is_online FROM network_assets ORDER BY is_online DESC
      `;
      expect(rows.map((r) => r.is_online)).toEqual([true, false]);
    } finally {
      await sql2.end({ timeout: 5 });
    }
  }, 45_000);

  it('CONCURRENT claims on one mapping: exactly one wins', async () => {
    // The guard itself, with the interleaving forced rather than hoped for.
    // Transaction A takes the claim and is held open; B asks for the same
    // mapping while A still holds the row lock. FOR UPDATE SKIP LOCKED means B
    // is refused immediately instead of queueing behind A and polling the
    // controller a second time once A commits.
    const c = await controller({ devices: [AP] });
    const mappingId = await activeMappingFor(c);

    const aSql = superuserSql();
    const bSql = superuserSql();
    try {
      let announceA!: (claimed: boolean) => void;
      const aClaimed = new Promise<boolean>((resolve) => {
        announceA = resolve;
      });
      let releaseA!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseA = resolve;
      });

      const aFinished = aSql.begin(async (tx) => {
        const [row] = await tx<{ claimed: boolean }[]>`
          SELECT helm.claim_unifi_poll(${mappingId}::uuid, 600) AS claimed
        `;
        announceA(row!.claimed);
        // Still inside the transaction: the row lock is held right here.
        await held;
      });

      expect(await aClaimed).toBe(true);

      const [bRow] = await bSql<{ claimed: boolean }[]>`
        SELECT helm.claim_unifi_poll(${mappingId}::uuid, 600) AS claimed
      `;
      expect(bRow!.claimed).toBe(false);

      releaseA();
      await aFinished;
    } finally {
      await aSql.end({ timeout: 5 });
      await bSql.end({ timeout: 5 });
    }
  }, 45_000);

  it('CONCURRENT sync runs leave one row, not two', async () => {
    // This project has shipped a bug of exactly this shape before. Two runs
    // started together must not both poll and both upsert.
    const c = await controller({ devices: [AP] });
    await activeMappingFor(c);

    const [a, b] = await Promise.all([runSync(), runSync()]);

    // Exactly one run polled. Which way the loser was turned away depends on
    // where its backlog query landed relative to the winner's commit — it
    // either saw the mapping and lost the claim, or never saw it due at all.
    // Both are correct and neither is worth pinning a test to; what must hold
    // is that the poll happened once.
    expect((a.polled ?? 0) + (b.polled ?? 0)).toBe(1);
    expect((a.failed ?? 0) + (b.failed ?? 0)).toBe(0);

    const sql = superuserSql();
    try {
      const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM network_assets`;
      // One device, one row — not two, and not a half-written one.
      expect(Number(rows[0]!.n)).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 45_000);

  it('backs off a failing controller without touching anybody else', async () => {
    const dead = await controller({ mode: 'unauthorized' });
    await activeMappingFor(dead);

    const counts = await runSync();
    expect(counts.failed).toBe(1);

    const sql = superuserSql();
    try {
      const [row] = await sql<{
        consecutive_failures: number; last_poll_ok: boolean; last_poll_error: string;
        due_in_seconds: number;
      }[]>`
        SELECT consecutive_failures, last_poll_ok, last_poll_error,
               extract(epoch FROM next_poll_at - now())::int AS due_in_seconds
        FROM unifi_site_mapping
      `;
      expect(row!.consecutive_failures).toBe(1);
      expect(row!.last_poll_ok).toBe(false);
      // The platform's own words, and where to fix it.
      expect(row!.last_poll_error).toMatch(/rejected the API key/);
      // Backed off past the configured interval rather than retrying at once.
      expect(row!.due_in_seconds).toBeGreaterThan(300);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it('decrypts back to what the controller reported', async () => {
    // The columns are ciphertext; this proves they are ciphertext OF something,
    // bound to this tenant and this asset.
    const c = await controller({ devices: [AP] });
    await activeMappingFor(c);
    await runSync();

    const sql = superuserSql();
    try {
      const [row] = await sql<{
        id: string; mac_address_enc: Buffer; hostname_enc: Buffer; data_key_id: string;
      }[]>`SELECT id, mac_address_enc, hostname_enc, data_key_id FROM network_assets`;

      const raw = row!.mac_address_enc.toString('utf8');
      expect(raw).not.toContain('aa:bb:cc');

      const dek = await h.dekCache.get(
        await withTenant(
          { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
          async (tx) => {
            const [k] = await tx<{
              id: string; wrapped_dek: Buffer; kek_id: string; wrap_context: Record<string, string>;
            }[]>`SELECT id, wrapped_dek, kek_id, wrap_context FROM tenant_data_key
                 WHERE id = ${row!.data_key_id}::uuid`;
            return {
              dataKeyId: k!.id,
              wrappedDek: k!.wrapped_dek,
              kekId: k!.kek_id,
              context: k!.wrap_context,
            };
          },
        ),
      );

      expect(openAssetField(dek, IDS.tenant1, row!.id, 'mac_address', row!.mac_address_enc))
        .toBe('aa:bb:cc:dd:ee:01');
      expect(openAssetField(dek, IDS.tenant1, row!.id, 'hostname', row!.hostname_enc))
        .toBe('acme-ap-lobby');
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);
});

describe('tenant isolation', () => {
  it('tenant A cannot read tenant B\u2019s network assets, by any query', async () => {
    const c = await controller({ devices: [AP] });
    running.push(c);
    await activeMappingFor(c);
    await runSync();
    c.stop();

    // A second tenant's admin, through the ordinary application role.
    const visible = await withTenant(
      { tenantId: IDS.tenant2, actorId: IDS.admin2, actorType: 'user' },
      async (tx) => {
        const assets = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM network_assets`;
        const history = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM asset_ip_history`;
        const mappings = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM unifi_site_mapping`;
        return {
          assets: Number(assets[0]!.n),
          history: Number(history[0]!.n),
          mappings: Number(mappings[0]!.n),
        };
      },
    );

    expect(visible).toEqual({ assets: 0, history: 0, mappings: 0 });

    // And tenant 1 does see its own, so the zeroes above are isolation rather
    // than an empty database.
    const own = await withTenant(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      async (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM network_assets`,
    );
    expect(Number(own[0]!.n)).toBe(1);
  }, 30_000);

  it('a blind index from one tenant does not match another\u2019s', async () => {
    // The per-tenant subkey. Without it, one tenant's captured index could be
    // used to probe another's inventory for a known MAC.
    const a = blindIndex.compute(IDS.tenant1, Buffer.from('aa:bb:cc:dd:ee:01', 'utf8'));
    const b = blindIndex.compute(IDS.tenant2, Buffer.from('aa:bb:cc:dd:ee:01', 'utf8'));
    expect(a.equals(b)).toBe(false);
  });
});
