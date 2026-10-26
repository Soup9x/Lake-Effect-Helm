/**
 * NinjaOne device sync (0980), through the real routes, the real worker and a
 * stub NinjaOne.
 *
 *   AUTHORITY     integration:rmm:manage, and nothing less.
 *   NOTHING BAD   a secret NinjaOne refuses is not saved.
 *   CONTAINMENT   the secret can only go to NinjaOne's hosts, and only an API
 *                 key kept in the MSP's own organisation can be used.
 *   MAPPING       only organisations a person mapped are imported.
 *   PRESERVATION  a re-sync updates what NinjaOne observes and leaves a field
 *                 somebody edited exactly as they left it.
 *   ADOPTION      a machine already documented by hand is linked, not doubled.
 *   CUSTODY       the secret is revealed through the audited path.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import {
  IDS, buildHarness, connectPools, disconnectPools, resetDatabase, superuserSql, type Harness,
} from './harness';
import { GET as getNinja, PUT as putNinja } from '../../src/app/api/integrations/ninja/route';
import { PUT as putOrganizations } from '../../src/app/api/integrations/ninja/organizations/route';
import { DELETE as deleteOrganization } from '../../src/app/api/organizations/[organizationId]/route';
import { POST as syncNow } from '../../src/app/api/integrations/ninja/sync/route';
import { ninjaSyncJob } from '../../src/workers/ninja-sync';
import { useNinjaTransport } from '../../src/lib/ninja/client';
import type { NinjaSettings } from '../../src/lib/ninja/queries';
import type { JobContext, JobLogger } from '../../src/workers/runtime';
import { FakeNinja } from '../support/fake-ninja';

let h: Harness;
let ninja: FakeNinja;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};
const asAdmin = () => asUser(IDS.admin1, 'admin@northwind.test');

const SECRET = 'ninja-client-secret-that-must-never-appear-in-a-response';
const BASE = 'https://app.ninjarmm.com';
const CONNECTION = {
  baseUrl: BASE,
  clientId: 'ninja-client-id-0001',
  clientSecret: SECRET,
  syncEnabled: true,
  intervalMinutes: 60,
};

const req = (method: string, path: string, payload?: unknown) =>
  new NextRequest(new Request(`https://helm.test${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));

const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;

const SERVER = {
  id: 501,
  organizationId: 11,
  nodeClass: 'WINDOWS_SERVER',
  displayName: 'ACME-FS01',
  systemName: 'ACME-FS01',
  dnsName: 'acme-fs01.acme.local',
  lastContact: 1_760_000_000,
  ipAddresses: ['10.2.0.10'],
  macAddresses: ['00:15:5d:00:00:10'],
  os: { name: 'Windows Server 2022 Standard', buildNumber: '20348', releaseId: '21H2' },
  system: { manufacturer: 'Dell Inc.', model: 'PowerEdge R650', serialNumber: 'FS01SER' },
  memory: { capacity: 68_719_476_736 },
};
const LAPTOP = {
  id: 502,
  organizationId: 11,
  nodeClass: 'WINDOWS_WORKSTATION',
  displayName: 'Reception laptop',
  systemName: 'ACME-LT-04',
  lastContact: 1_760_000_100,
  system: { manufacturer: 'Lenovo', model: 'ThinkPad T14', serialNumber: 'LT04SER', chassisType: 'LAPTOP' },
};
const GLOBEX_PC = {
  id: 601,
  organizationId: 12,
  nodeClass: 'WINDOWS_WORKSTATION',
  displayName: 'GLOBEX-PC-01',
  system: { serialNumber: 'GX01SER' },
};

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

async function runSync(): Promise<Record<string, number>> {
  const ctx: JobContext = { log: recordingLogger([]), stopping: () => false };
  const result = await ninjaSyncJob().run(ctx);
  return result.counts ?? {};
}

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Make the connection due again, as an interval passing would. */
const makeDue = () => su((sql) => sql`UPDATE integration_connection SET last_sync_at = NULL WHERE provider = 'ninja_one'`);

async function configure(): Promise<NinjaSettings> {
  asAdmin();
  const response = await putNinja(req('PUT', '/api/integrations/ninja', CONNECTION));
  expect(response.status).toBe(200);
  return json<NinjaSettings>(response);
}

async function mapOrg(ninjaOrgId: string, organizationId: string | null) {
  asAdmin();
  const response = await putOrganizations(req('PUT', '/api/integrations/ninja/organizations', {
    mappings: [{ ninjaOrgId, organizationId }],
  }));
  expect(response.status).toBe(200);
  return json<NinjaSettings>(response);
}

interface SyncedDevice {
  id: string; name: string; organization_id: string; device_type: string; hostname: string | null;
  operating_system: string | null; os_version: string | null; model: string | null;
  serial_number: string | null; primary_ip: string | null; primary_mac: string | null;
  memory_gb: string | null; rmm_device_id: string | null; last_seen_at: Date | null; notes: string | null;
}

const devices = () => su((sql) => sql<SyncedDevice[]>`
  SELECT n.id, n.name, n.organization_id, d.device_type::text AS device_type, d.hostname::text AS hostname,
         d.operating_system, d.os_version, d.model, d.serial_number, host(d.primary_ip) AS primary_ip,
         d.primary_mac::text AS primary_mac, d.memory_gb::text AS memory_gb, d.rmm_device_id, d.last_seen_at,
         n.notes
  FROM external_identity ei
  JOIN asset_node n ON n.id = ei.node_id
  JOIN device d ON d.id = n.id
  WHERE ei.external_type = 'ninja_device'
  ORDER BY d.rmm_device_id
`);

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'ninja tests' });
  await h.keys.provision(IDS.tenant2, IDS.admin2, { reason: 'ninja tests' });
  ninja = await FakeNinja.start(SECRET);
  useNinjaTransport(ninja.transport());
}, 180_000);

afterEach(async () => {
  currentUser = null;
  ninja.mode = 'ok';
  ninja.organizations = [];
  ninja.devices = [];
  ninja.requests.length = 0;
  await su(async (sql) => {
    await sql`DELETE FROM asset_node WHERE id IN (
      SELECT node_id FROM external_identity WHERE external_type = 'ninja_device')`;
    await sql`DELETE FROM asset_node WHERE name = 'Hand-documented file server'`;
    await sql`DELETE FROM integration_connection WHERE provider = 'ninja_one'`;
    await sql`DELETE FROM role_permission WHERE role_key = 'tier1' AND permission_key = 'integration:rmm:manage'`;
  });
});

afterAll(async () => {
  useNinjaTransport(null);
  ninja.stop();
  await disconnectPools();
});

describe('setting NinjaOne up', () => {
  it('tries the secret, stores it in the vault, and lists the organisations', async () => {
    ninja.organizations = [{ id: 11, name: 'Acme Corp' }, { id: 12, name: 'Globex' }];
    const response = await (async () => {
      asAdmin();
      return putNinja(req('PUT', '/api/integrations/ninja', CONNECTION));
    })();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    const settings = JSON.parse(text) as NinjaSettings & { tested: { organizations: number } };

    expect(settings.tested.organizations).toBe(2);
    expect(settings.connection).toMatchObject({
      baseUrl: BASE, clientId: CONNECTION.clientId, secretSet: true, syncEnabled: true, status: 'configured',
    });
    expect(settings.organizations.map((o) => [o.name, o.organizationId])).toEqual([
      ['Acme Corp', null], ['Globex', null],
    ]);

    // The token request carried the grant NinjaOne expects, to the region chosen.
    const token = ninja.requests.find((r) => r.path === '/ws/oauth/token')!;
    expect(token.host).toBe('app.ninjarmm.com');
    expect(token.form).toMatchObject({ grant_type: 'client_credentials', scope: 'monitoring', client_id: CONNECTION.clientId });

    // In `secret`, in the MSP's own organisation, as an elevated API key.
    const [stored] = await su((sql) => sql<{ kind: string; organization_id: string; sensitivity: string }[]>`
      SELECT s.kind::text AS kind, s.organization_id, s.sensitivity::text AS sensitivity
      FROM integration_connection c
      JOIN secret s ON s.id = (c.credential_secret_ids ->> 'client_secret')::uuid
      WHERE c.provider = 'ninja_one'
    `);
    expect(stored).toEqual({ kind: 'api_key', organization_id: IDS.orgInternal, sensitivity: 'elevated' });
  });

  it('saves nothing when NinjaOne refuses the secret', async () => {
    ninja.mode = 'bad-credentials';
    asAdmin();
    const response = await putNinja(req('PUT', '/api/integrations/ninja', CONNECTION));
    expect(response.status).toBe(400);
    const body = await json<{ error: { message: string; details?: { remedy?: string } } }>(response);
    expect(body.error.message).toMatch(/refused the client id and secret/);
    expect(body.error.details?.remedy).toMatch(/Monitoring scope/);

    const [row] = await su((sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM integration_connection WHERE provider = 'ninja_one'`);
    expect(row?.n).toBe(0);
  });

  it('refuses a region that is not NinjaOne', async () => {
    asAdmin();
    const response = await putNinja(req('PUT', '/api/integrations/ninja', { ...CONNECTION, baseUrl: 'https://ninja.evil.test' }));
    expect(response.status).toBe(400);
    expect(ninja.requests).toHaveLength(0);
  });

  it('keeps the stored secret when only the interval changes', async () => {
    await configure();
    asAdmin();
    const { clientSecret: _omit, ...rest } = CONNECTION;
    const response = await putNinja(req('PUT', '/api/integrations/ninja', { ...rest, intervalMinutes: 240 }));
    expect(response.status).toBe(200);
    const settings = await json<NinjaSettings>(response);
    expect(settings.connection).toMatchObject({ secretSet: true, intervalMinutes: 240 });
  });

  it('refuses somebody without integration:rmm:manage, and lets them read', async () => {
    await configure();
    asUser(IDS.tech1, 'tech1@northwind.test');
    expect((await putNinja(req('PUT', '/api/integrations/ninja', CONNECTION))).status).toBe(403);
    expect((await putOrganizations(req('PUT', '/api/integrations/ninja/organizations', {
      mappings: [{ ninjaOrgId: '11', organizationId: IDS.orgAcme }],
    }))).status).toBe(403);
    expect((await syncNow(req('POST', '/api/integrations/ninja/sync'))).status).toBe(403);

    const read = await getNinja(req('GET', '/api/integrations/ninja'));
    expect(read.status).toBe(200);
    expect((await json<NinjaSettings>(read)).connection?.secretSet).toBe(true);
  });

  it('is invisible to another MSP', async () => {
    await configure();
    asUser(IDS.admin2, 'admin@rival.test');
    const read = await getNinja(req('GET', '/api/integrations/ninja'));
    expect((await json<NinjaSettings>(read)).connection).toBeNull();
  });
});

describe('where the secret may go', () => {
  it('refuses pointing the connection at another host, by any path', async () => {
    await configure();
    await expect(withTenant(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      async (tx) => tx`UPDATE integration_connection SET base_url = 'https://collector.evil.test'
                       WHERE provider = 'ninja_one'`,
    )).rejects.toThrow(/not a NinjaOne region/);
  });

  it('refuses pointing it at a credential that is not its own', async () => {
    await configure();
    // A client's credential: an api_key kind would still be refused, because
    // it is not in the MSP's own organisation.
    const created = await h.secrets.create(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      { organizationId: IDS.orgAcme, kind: 'api_key', label: 'Acme API key', sensitivity: 'standard' },
      'acme-api-key-value',
    );
    await expect(withTenant(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      async (tx) => tx`UPDATE integration_connection
                       SET credential_secret_ids = jsonb_build_object('client_secret', ${created.secretId}::text)
                       WHERE provider = 'ninja_one'`,
    )).rejects.toThrow(/only use an API key kept in the MSP/);
  });
});

describe('the sync worker', () => {
  it('imports only organisations a person mapped, as the right kind of configuration', async () => {
    ninja.organizations = [{ id: 11, name: 'Acme Corp' }, { id: 12, name: 'Globex' }];
    ninja.devices = [SERVER, LAPTOP, GLOBEX_PC];
    await configure();
    await mapOrg('11', IDS.orgAcme);

    const counts = await runSync();
    expect(counts).toMatchObject({ connections: 1, created: 2, skipped: 1, failed: 0 });

    const rows = await devices();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: 'ACME-FS01', organization_id: IDS.orgAcme, device_type: 'server', hostname: 'ACME-FS01',
      operating_system: 'Windows Server 2022 Standard', os_version: '21H2 (20348)', model: 'PowerEdge R650',
      serial_number: 'FS01SER', primary_ip: '10.2.0.10', primary_mac: '00:15:5d:00:00:10',
      memory_gb: '64.00', rmm_device_id: '501',
    });
    expect(rows[0]!.last_seen_at?.toISOString()).toBe(new Date(1_760_000_000_000).toISOString());
    expect(rows[1]).toMatchObject({ name: 'Reception laptop', device_type: 'laptop' });

    asAdmin();
    const settings = await json<NinjaSettings>(await getNinja(req('GET', '/api/integrations/ninja')));
    expect(settings.connection).toMatchObject({ status: 'active', deviceCount: 2, lastError: null });
    expect(settings.runs[0]).toMatchObject({ status: 'success', seen: 3, created: 2, skipped: 1 });
    expect(settings.organizations.find((o) => o.ninjaOrgId === '11')).toMatchObject({
      organizationName: 'Acme Manufacturing', deviceCount: 2,
    });
  });

  it('reveals the secret through the audited path, once per run', async () => {
    ninja.organizations = [{ id: 11, name: 'Acme Corp' }];
    await configure();
    await runSync();

    const rows = await su((sql) => sql<{ actor_type: string; metadata: { purpose?: string } }[]>`
      SELECT actor_type::text AS actor_type, metadata FROM audit_log
      WHERE action = 'secret.revealed' AND tenant_id = ${IDS.tenant1}::uuid
        AND entity_id = (SELECT (credential_secret_ids ->> 'client_secret')::uuid
                         FROM integration_connection WHERE provider = 'ninja_one')
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_type).toBe('service_account');
    expect(rows[0]!.metadata.purpose).toBe('integration');
  });

  it('updates what NinjaOne observes and leaves what a person edited', async () => {
    ninja.organizations = [{ id: 11, name: 'Acme Corp' }];
    ninja.devices = [SERVER];
    await configure();
    await mapOrg('11', IDS.orgAcme);
    await runSync();
    const [first] = await devices();

    // A person renames it, notes it, reclassifies it and corrects the model.
    await withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, async (tx) => {
      await tx`UPDATE asset_node SET name = 'File server (main)', notes = 'Racked in comms room'
               WHERE id = ${first!.id}::uuid`;
      await tx`UPDATE device SET model = 'PowerEdge R650xs', device_type = 'hypervisor'
               WHERE id = ${first!.id}::uuid`;
    });

    // NinjaOne now reports a new OS build, a new address, and its own model.
    ninja.devices = [{
      ...SERVER,
      lastContact: 1_760_003_600,
      ipAddresses: ['10.2.0.11'],
      os: { ...SERVER.os, buildNumber: '20349' },
      system: { ...SERVER.system, model: 'PowerEdge R650 (rev B)' },
    }];
    await makeDue();
    const counts = await runSync();
    expect(counts).toMatchObject({ updated: 1, created: 0 });

    const [after] = await devices();
    expect(after).toMatchObject({
      id: first!.id,
      name: 'File server (main)',
      notes: 'Racked in comms room',
      device_type: 'hypervisor',
      model: 'PowerEdge R650xs',
      os_version: '21H2 (20349)',
      primary_ip: '10.2.0.11',
    });
    expect(after!.last_seen_at?.toISOString()).toBe(new Date(1_760_003_600_000).toISOString());

    // The change history says it was the sync, and what it changed.
    const history = await su((sql) => sql<{ actor_type: string; changes: Record<string, unknown> }[]>`
      SELECT actor_type, changes FROM entity_change
      WHERE entity_id = ${first!.id}::uuid AND actor_type = 'service_account' AND kind = 'updated'
    `);
    const second = history.find((h) =>
      (h.changes.os_version as unknown[] | undefined)?.[1] === '21H2 (20349)');
    expect(second).toBeDefined();
    expect(second!.changes).toHaveProperty('primary_ip');
    expect(second!.changes).not.toHaveProperty('model');
  });

  it('makes NinjaOne authoritative when manual edits are not respected', async () => {
    ninja.organizations = [{ id: 11, name: 'Acme Corp' }];
    ninja.devices = [SERVER];
    await configure();
    await mapOrg('11', IDS.orgAcme);
    await runSync();
    const [first] = await devices();
    await su((sql) => sql`UPDATE device SET model = 'Hand typed' WHERE id = ${first!.id}::uuid`);
    await su((sql) => sql`UPDATE integration_connection SET respect_manual_edits = false WHERE provider = 'ninja_one'`);

    ninja.devices = [{ ...SERVER, os: { ...SERVER.os, buildNumber: '20350' } }];
    await makeDue();
    await runSync();
    const [after] = await devices();
    expect(after!.model).toBe('PowerEdge R650');
  });

  it('costs nothing for a machine that only checked in', async () => {
    ninja.organizations = [{ id: 11, name: 'Acme Corp' }];
    ninja.devices = [SERVER];
    await configure();
    await mapOrg('11', IDS.orgAcme);
    await runSync();

    ninja.devices = [{ ...SERVER, lastContact: 1_760_007_200 }];
    await makeDue();
    const counts = await runSync();
    expect(counts).toMatchObject({ unchanged: 1, updated: 0, created: 0 });
    const [after] = await devices();
    expect(after!.last_seen_at?.toISOString()).toBe(new Date(1_760_007_200_000).toISOString());
  });

  it('adopts a machine already documented by hand instead of doubling it', async () => {
    const [existing] = await withTenant(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      async (tx) => {
        const [node] = await tx<{ id: string }[]>`
          INSERT INTO asset_node (tenant_id, organization_id, node_type, name)
          VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'device', 'Hand-documented file server')
          RETURNING id`;
        await tx`INSERT INTO device (id, tenant_id, node_type, device_type, serial_number)
                 VALUES (${node!.id}::uuid, ${IDS.tenant1}::uuid, 'device', 'server', 'fs01ser')`;
        return [node!];
      },
    );

    ninja.organizations = [{ id: 11, name: 'Acme Corp' }];
    ninja.devices = [SERVER];
    await configure();
    await mapOrg('11', IDS.orgAcme);
    const counts = await runSync();
    expect(counts).toMatchObject({ created: 0, updated: 1 });

    const rows = await devices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: existing!.id,
      name: 'Hand-documented file server',
      // Not empty, and a person typed it: kept, though the case differs.
      serial_number: 'fs01ser',
      hostname: 'ACME-FS01',
      rmm_device_id: '501',
    });
  });

  it('pages through every device', async () => {
    ninja.organizations = [{ id: 11, name: 'Acme Corp' }];
    ninja.devices = Array.from({ length: 1203 }, (_, i) => ({
      id: 10_000 + i, organizationId: 11, nodeClass: 'WINDOWS_WORKSTATION', systemName: `PC-${i}`,
    }));
    await configure();
    const counts = await runSync();
    expect(counts).toMatchObject({ connections: 1, skipped: 1203 });
    const pages = ninja.requests.filter((r) => r.path.startsWith('/api/v2/devices-detailed'));
    expect(pages).toHaveLength(3);
    expect(pages[1]!.path).toContain('after=10499');
  });

  it('records a failure on the connection and backs off', async () => {
    ninja.organizations = [{ id: 11, name: 'Acme Corp' }];
    await configure();
    ninja.mode = 'forbidden';
    const counts = await runSync();
    expect(counts).toMatchObject({ failed: 1 });

    asAdmin();
    const settings = await json<NinjaSettings>(await getNinja(req('GET', '/api/integrations/ninja')));
    expect(settings.connection).toMatchObject({ status: 'degraded', consecutiveFailures: 1 });
    expect(settings.connection?.lastError).toMatch(/Monitoring scope/);
    expect(settings.runs[0]).toMatchObject({ status: 'failed' });

    // Not due again straight away.
    expect(await runSync()).toEqual({});
  });

  it('runs again when somebody asks', async () => {
    ninja.organizations = [{ id: 11, name: 'Acme Corp' }];
    await configure();
    await runSync();
    expect(await runSync()).toEqual({});

    asAdmin();
    expect((await syncNow(req('POST', '/api/integrations/ninja/sync'))).status).toBe(200);
    expect(await runSync()).toMatchObject({ connections: 1 });
  });

  it('stops importing an organisation when it is unmapped, and keeps what it imported', async () => {
    ninja.organizations = [{ id: 11, name: 'Acme Corp' }];
    ninja.devices = [SERVER];
    await configure();
    await mapOrg('11', IDS.orgAcme);
    await runSync();
    await mapOrg('11', null);

    ninja.devices = [SERVER, LAPTOP];
    await makeDue();
    const counts = await runSync();
    expect(counts).toMatchObject({ created: 0, skipped: 2 });
    expect(await devices()).toHaveLength(1);
  });
});

describe('a client per NinjaOne organisation', () => {
  it('uses the client of the same name, or creates one, and imports into it', async () => {
    ninja.organizations = [{ id: 11, name: 'acme manufacturing' }, { id: 12, name: 'Globex' }, { id: 13, name: 'Globex ' }];
    ninja.devices = [SERVER, GLOBEX_PC];
    await configure();

    asAdmin();
    const response = await putOrganizations(req('PUT', '/api/integrations/ninja/organizations', {
      mappings: [
        { ninjaOrgId: '11', organizationId: 'new' },
        { ninjaOrgId: '12', organizationId: 'new' },
        { ninjaOrgId: '13', organizationId: 'new' },
      ],
    }));
    expect(response.status).toBe(200);
    const settings = await json<NinjaSettings>(response);
    const byId = new Map(settings.organizations.map((o) => [o.ninjaOrgId, o]));
    expect(byId.get('11')?.organizationId).toBe(IDS.orgAcme);
    expect(byId.get('12')?.organizationName).toBe('Globex');
    // Same name, so the same client: not a second Globex.
    expect(byId.get('13')?.organizationId).toBe(byId.get('12')?.organizationId);

    const created = await su((sql) => sql<{ slug: string; relationship: string; is_msp_internal: boolean }[]>`
      SELECT slug, relationship::text AS relationship, is_msp_internal FROM organization
      WHERE id = ${byId.get('12')!.organizationId!}::uuid
    `);
    // The fixtures' Globex Corporation already has 'globex'.
    expect(created).toEqual([{ slug: 'globex-2', relationship: 'client', is_msp_internal: false }]);

    const counts = await runSync();
    expect(counts).toMatchObject({ created: 2, skipped: 0, failed: 0 });
    const rows = await devices();
    expect(rows.find((d) => d.name === 'GLOBEX-PC-01')?.organization_id).toBe(byId.get('12')!.organizationId);
  });

  it('gives a new client a slug nobody has', async () => {
    ninja.organizations = [{ id: 21, name: 'Acme' }];
    await configure();
    await su((sql) => sql`UPDATE organization SET slug = 'acme' WHERE id = ${IDS.orgAcme}::uuid`);

    const settings = await mapOrg('21', 'new');
    const id = settings.organizations[0]!.organizationId!;
    expect(id).not.toBe(IDS.orgAcme);
    const [row] = await su((sql) => sql<{ slug: string }[]>`SELECT slug FROM organization WHERE id = ${id}::uuid`);
    expect(row?.slug).toBe('acme-2');
  });
});

describe('deciding what not to import', () => {
  const standing = (settings: NinjaSettings, id: string) => {
    const org = settings.organizations.find((o) => o.ninjaOrgId === id)!;
    return { organizationId: org.organizationId, excluded: org.excludedAt !== null };
  };

  it('tells "nobody has decided" from "somebody chose not to"', async () => {
    ninja.organizations = [{ id: 11, name: 'Acme Corp' }, { id: 12, name: 'Globex' }];
    let settings = await configure();
    expect(standing(settings, '11')).toEqual({ organizationId: null, excluded: false });

    settings = await mapOrg('11', null);
    expect(standing(settings, '11')).toEqual({ organizationId: null, excluded: true });
    expect(standing(settings, '12')).toEqual({ organizationId: null, excluded: false });

    settings = await mapOrg('11', IDS.orgAcme);
    expect(standing(settings, '11')).toEqual({ organizationId: IDS.orgAcme, excluded: false });

    settings = await mapOrg('11', null);
    expect(standing(settings, '11')).toEqual({ organizationId: null, excluded: true });

    // A sync re-lists organisations without forgetting the decision.
    await runSync();
    asAdmin();
    settings = await json<NinjaSettings>(await getNinja(req('GET', '/api/integrations/ninja')));
    expect(standing(settings, '11')).toEqual({ organizationId: null, excluded: true });
  });

  it('stops importing to an archived client, and counts a deleted one as not importing', async () => {
    ninja.organizations = [{ id: 21, name: 'Short-lived' }];
    ninja.devices = [{ ...GLOBEX_PC, organizationId: 21 }];
    await configure();
    let settings = await mapOrg('21', 'new');
    const clientId = settings.organizations[0]!.organizationId!;
    expect((await runSync())).toMatchObject({ created: 1 });

    await su((sql) => sql`UPDATE organization SET archived_at = now() WHERE id = ${clientId}::uuid`);
    await makeDue();
    expect((await runSync())).toMatchObject({ created: 0, updated: 0, unchanged: 0, skipped: 1 });
    asAdmin();
    settings = await json<NinjaSettings>(await getNinja(req('GET', '/api/integrations/ninja')));
    expect(settings.organizations[0]).toMatchObject({ organizationId: clientId, organizationArchived: true });

    asAdmin();
    const deleted = await deleteOrganization(
      new NextRequest(new Request(`https://helm.test/api/organizations/${clientId}`, { method: 'DELETE' })),
      { params: Promise.resolve({ organizationId: clientId }) } as never,
    );
    expect(deleted.status).toBe(200);

    asAdmin();
    settings = await json<NinjaSettings>(await getNinja(req('GET', '/api/integrations/ninja')));
    expect(standing(settings, '21')).toEqual({ organizationId: null, excluded: true });
    await makeDue();
    expect((await runSync())).toMatchObject({ created: 0, skipped: 1 });
  });
});
