/**
 * Action1 endpoint sync (1160), through the real routes, the real worker and a
 * stub Action1 answering through the client's transport seam.
 *
 *   AUTHORITY     integration:rmm:manage, and nothing less.
 *   NOTHING BAD   a secret Action1 refuses is not saved.
 *   CONTAINMENT   the secret can only go to Action1's hosts, and only an API
 *                 key kept in the MSP's own organisation can be used.
 *   MAPPING       only organizations a person mapped are imported.
 *   PRESERVATION  a re-sync updates what Action1 observes and leaves a field
 *                 somebody edited exactly as they left it.
 *   ADOPTION      a machine already documented is linked, not doubled.
 *   COEXISTENCE   NinjaOne's id column is never touched, and a check-in only
 *                 ever moves forward.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import {
  IDS, buildHarness, connectPools, disconnectPools, resetDatabase, superuserSql, type Harness,
} from './harness';
import { GET as getAction1, PUT as putAction1 } from '../../src/app/api/integrations/action1/route';
import { PUT as putOrganizations } from '../../src/app/api/integrations/action1/organizations/route';
import { POST as syncNow } from '../../src/app/api/integrations/action1/sync/route';
import { action1SyncJob } from '../../src/workers/action1-sync';
import { useAction1Transport, type Action1Request } from '../../src/lib/action1/client';
import type { Action1Settings } from '../../src/lib/action1/queries';
import type { JobContext, JobLogger } from '../../src/workers/runtime';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};
const asAdmin = () => asUser(IDS.admin1, 'admin@northwind.test');

const SECRET = 'action1-client-secret-that-must-never-appear-in-a-response';
const BASE = 'https://app.action1.com';
const CONNECTION = {
  baseUrl: BASE,
  clientId: 'api-key-0001@action1.com',
  clientSecret: SECRET,
  syncEnabled: true,
  intervalMinutes: 60,
};

const ACME = 'a0000000-0000-4000-8000-0000000000a1';
const GLOBEX = 'a0000000-0000-4000-8000-0000000000b2';

/** A stub Action1: what it lists, and every request it was sent. */
const action1 = {
  mode: 'ok' as 'ok' | 'bad-credentials',
  organizations: [] as Record<string, unknown>[],
  endpoints: [] as Record<string, unknown>[],
  requests: [] as { url: string; request: Action1Request }[],
};

function stubTransport(url: string, request: Action1Request) {
  action1.requests.push({ url, request });
  const u = new URL(url);
  const page = (items: unknown[]) => {
    const from = Number(u.searchParams.get('from') ?? 0);
    const limit = Number(u.searchParams.get('limit') ?? 50);
    return { status: 200, body: JSON.stringify({ type: 'ResultPage', items: items.slice(from, from + limit), total_items: String(items.length) }) };
  };
  if (u.pathname === '/api/3.0/oauth2/token') {
    const body = JSON.parse(request.body ?? '{}') as { client_secret?: string };
    return action1.mode === 'ok' && body.client_secret === SECRET
      ? { status: 200, body: JSON.stringify({ access_token: 'jwt', expires_in: 3600, token_type: 'Bearer' }) }
      : { status: 400, body: JSON.stringify({ error: 'invalid_client' }) };
  }
  if (request.headers.authorization !== 'Bearer jwt') return { status: 401, body: '{}' };
  if (u.pathname === '/api/3.0/organizations') return page(action1.organizations);
  if (u.pathname === '/api/3.0/endpoints/managed/all') return page(action1.endpoints);
  const one = /^\/api\/3\.0\/endpoints\/managed\/([^/]+)$/.exec(u.pathname);
  if (one) {
    const orgId = decodeURIComponent(one[1]!);
    // An org's own list carries no organization_id, as the fallback assumes.
    return page(action1.endpoints
      .filter((e) => e.organization_id === orgId || e.__org === orgId)
      .map(({ organization_id: _o, __org: _x, ...rest }) => rest));
  }
  return { status: 404, body: '{}' };
}

const req = (method: string, path: string, payload?: unknown) =>
  new NextRequest(new Request(`https://helm.test${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));

const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;

const SERVER = {
  id: 'ep-server-1',
  organization_id: ACME,
  name: 'ACME-FS01',
  device_name: 'ACME-FS01',
  OS: 'Windows Server 2022 (21H2)',
  platform: 'Windows',
  address: '10.2.0.10',
  MAC: '00:15:5d:00:00:10',
  manufacturer: 'Dell Inc.',
  serial: 'FS01SER',
  CPU_name: 'Intel Xeon Silver 4310',
  RAM: '64Gb DDR4',
  last_seen: '2026-10-29_12-00-00',
  status: 'Connected',
  reboot_required: 'No',
  missing_updates: { critical: 1, other: 4 },
  user: 'ACME\\admin',
};
const LAPTOP = {
  id: 'ep-laptop-2',
  organization_id: ACME,
  name: 'Reception laptop',
  device_name: 'ACME-LT-04',
  OS: 'Windows 11 (24H2)',
  serial: 'LT04SER',
  last_seen: '2026-10-29_12-05-00',
};
const GLOBEX_PC = {
  id: 'ep-globex-3',
  organization_id: GLOBEX,
  name: 'GLOBEX-PC-01',
  serial: 'GX01SER',
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
  const result = await action1SyncJob().run(ctx);
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

const makeDue = () => su((sql) => sql`UPDATE integration_connection SET last_sync_at = NULL WHERE provider = 'action1'`);

async function configure(): Promise<Action1Settings> {
  asAdmin();
  const response = await putAction1(req('PUT', '/api/integrations/action1', CONNECTION));
  expect(response.status).toBe(200);
  return json<Action1Settings>(response);
}

async function mapOrg(action1OrgId: string, organizationId: string | null) {
  asAdmin();
  const response = await putOrganizations(req('PUT', '/api/integrations/action1/organizations', {
    mappings: [{ action1OrgId, organizationId }],
  }));
  expect(response.status).toBe(200);
  return json<Action1Settings>(response);
}

interface SyncedDevice {
  id: string; name: string; organization_id: string; device_type: string; hostname: string | null;
  operating_system: string | null; os_version: string | null; manufacturer: string | null;
  serial_number: string | null; primary_ip: string | null; primary_mac: string | null; cpu: string | null;
  memory_gb: string | null; rmm_device_id: string | null; last_seen_at: Date | null; external_id: string;
  profile: Record<string, unknown> | null;
}

const devices = () => su((sql) => sql<SyncedDevice[]>`
  SELECT n.id, n.name, n.organization_id, d.device_type::text AS device_type, d.hostname::text AS hostname,
         d.operating_system, d.os_version, d.manufacturer, d.serial_number, host(d.primary_ip) AS primary_ip,
         d.primary_mac::text AS primary_mac, d.cpu, d.memory_gb::text AS memory_gb, d.rmm_device_id,
         d.last_seen_at, ei.external_id, ei.profile
  FROM external_identity ei
  JOIN asset_node n ON n.id = ei.node_id
  JOIN device d ON d.id = n.id
  WHERE ei.external_type = 'action1_device'
  ORDER BY ei.external_id DESC
`);

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'action1 tests' });
  await h.keys.provision(IDS.tenant2, IDS.admin2, { reason: 'action1 tests' });
  useAction1Transport(async (url, request) => stubTransport(url, request), async () => {});
}, 180_000);

afterEach(async () => {
  currentUser = null;
  action1.mode = 'ok';
  action1.organizations = [];
  action1.endpoints = [];
  action1.requests.length = 0;
  await su(async (sql) => {
    await sql`DELETE FROM asset_node WHERE id IN (
      SELECT node_id FROM external_identity WHERE external_type = 'action1_device')`;
    await sql`DELETE FROM asset_node WHERE name = 'Hand-documented file server'`;
    await sql`DELETE FROM integration_connection WHERE provider = 'action1'`;
  });
});

afterAll(async () => {
  useAction1Transport(null);
  await disconnectPools();
});

describe('setting Action1 up', () => {
  it('tries the secret, stores it in the vault, and lists the organizations', async () => {
    action1.organizations = [{ id: ACME, name: 'Acme Corp' }, { id: GLOBEX, name: 'Globex' }];
    asAdmin();
    const response = await putAction1(req('PUT', '/api/integrations/action1', CONNECTION));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    const settings = JSON.parse(text) as Action1Settings & { tested: { organizations: number } };

    expect(settings.tested.organizations).toBe(2);
    expect(settings.connection).toMatchObject({
      baseUrl: BASE, clientId: CONNECTION.clientId, secretSet: true, syncEnabled: true, status: 'configured',
    });
    expect(settings.organizations.map((o) => [o.name, o.organizationId, o.excludedAt])).toEqual([
      ['Acme Corp', null, null], ['Globex', null, null],
    ]);
    expect(new URL(action1.requests[0]!.url).host).toBe('app.action1.com');

    const [stored] = await su((sql) => sql<{ kind: string; organization_id: string; sensitivity: string }[]>`
      SELECT s.kind::text AS kind, s.organization_id, s.sensitivity::text AS sensitivity
      FROM integration_connection c
      JOIN secret s ON s.id = (c.credential_secret_ids ->> 'client_secret')::uuid
      WHERE c.provider = 'action1'
    `);
    expect(stored).toEqual({ kind: 'api_key', organization_id: IDS.orgInternal, sensitivity: 'elevated' });
  });

  it('saves nothing when Action1 refuses the secret', async () => {
    action1.mode = 'bad-credentials';
    asAdmin();
    const response = await putAction1(req('PUT', '/api/integrations/action1', CONNECTION));
    expect(response.status).toBe(400);
    const body = await json<{ error: { message: string; details?: { remedy?: string } } }>(response);
    expect(body.error.message).toMatch(/refused the client id and secret/);
    expect(body.error.details?.remedy).toMatch(/API Credentials/);
    const [row] = await su((sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM integration_connection WHERE provider = 'action1'`);
    expect(row?.n).toBe(0);
  });

  it('refuses a region that is not Action1', async () => {
    asAdmin();
    const response = await putAction1(req('PUT', '/api/integrations/action1', { ...CONNECTION, baseUrl: 'https://action1.evil.test' }));
    expect(response.status).toBe(400);
    expect(action1.requests).toHaveLength(0);
  });

  it('refuses somebody without integration:rmm:manage, and lets them read', async () => {
    await configure();
    asUser(IDS.tech1, 'tech1@northwind.test');
    expect((await putAction1(req('PUT', '/api/integrations/action1', CONNECTION))).status).toBe(403);
    expect((await putOrganizations(req('PUT', '/api/integrations/action1/organizations', {
      mappings: [{ action1OrgId: ACME, organizationId: IDS.orgAcme }],
    }))).status).toBe(403);
    expect((await syncNow(req('POST', '/api/integrations/action1/sync'))).status).toBe(403);
    const read = await getAction1(req('GET', '/api/integrations/action1'));
    expect((await json<Action1Settings>(read)).connection?.secretSet).toBe(true);
  });

  it('is invisible to another MSP', async () => {
    await configure();
    asUser(IDS.admin2, 'admin@rival.test');
    const read = await getAction1(req('GET', '/api/integrations/action1'));
    expect((await json<Action1Settings>(read)).connection).toBeNull();
  });
});

describe('where the secret may go', () => {
  it('refuses pointing the connection at another host, by any path', async () => {
    await configure();
    await expect(withTenant(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      async (tx) => tx`UPDATE integration_connection SET base_url = 'https://collector.evil.test'
                       WHERE provider = 'action1'`,
    )).rejects.toThrow(/not an Action1 region/);
  });

  it('refuses pointing it at a credential that is not its own', async () => {
    await configure();
    const created = await h.secrets.create(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      { organizationId: IDS.orgAcme, kind: 'api_key', label: 'Acme API key', sensitivity: 'standard' },
      'acme-api-key-value',
    );
    await expect(withTenant(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      async (tx) => tx`UPDATE integration_connection
                       SET credential_secret_ids = jsonb_build_object('client_secret', ${created.secretId}::text)
                       WHERE provider = 'action1'`,
    )).rejects.toThrow(/only use an API key kept in the MSP/);
  });
});

describe('the sync worker', () => {
  it('imports only organizations a person mapped, with the profile', async () => {
    action1.organizations = [{ id: ACME, name: 'Acme Corp' }, { id: GLOBEX, name: 'Globex' }];
    action1.endpoints = [SERVER, LAPTOP, GLOBEX_PC];
    await configure();
    await mapOrg(ACME, IDS.orgAcme);
    await mapOrg(GLOBEX, null);

    const counts = await runSync();
    expect(counts).toMatchObject({ connections: 1, created: 2, skipped: 1, failed: 0 });

    const rows = await devices();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: 'ACME-FS01', organization_id: IDS.orgAcme, device_type: 'server', hostname: 'ACME-FS01',
      operating_system: 'Windows Server 2022', os_version: '21H2', manufacturer: 'Dell Inc.',
      serial_number: 'FS01SER', primary_ip: '10.2.0.10', primary_mac: '00:15:5d:00:00:10',
      cpu: 'Intel Xeon Silver 4310', memory_gb: '64.00', rmm_device_id: null,
    });
    expect(rows[0]!.last_seen_at?.toISOString()).toBe('2026-10-29T12:00:00.000Z');
    expect(rows[0]!.profile).toMatchObject({
      orgId: ACME, agentStatus: 'Connected', needsReboot: false,
      missingUpdates: { critical: 1, other: 4 }, lastLoggedInUser: 'ACME\\admin',
    });
    expect(rows[1]).toMatchObject({ name: 'Reception laptop', device_type: 'workstation' });

    asAdmin();
    const settings = await json<Action1Settings>(await getAction1(req('GET', '/api/integrations/action1')));
    expect(settings.connection).toMatchObject({ status: 'active', deviceCount: 2, lastError: null });
    expect(settings.runs[0]).toMatchObject({ status: 'success', seen: 3, created: 2, skipped: 1 });
    expect(settings.organizations.find((o) => o.action1OrgId === ACME)).toMatchObject({ deviceCount: 2 });
    expect(settings.organizations.find((o) => o.action1OrgId === GLOBEX)!.excludedAt).not.toBeNull();
  });

  it('reveals the secret through the audited path, once per run', async () => {
    action1.organizations = [{ id: ACME, name: 'Acme Corp' }];
    await configure();
    await runSync();
    const rows = await su((sql) => sql<{ actor_type: string; metadata: { purpose?: string } }[]>`
      SELECT actor_type::text AS actor_type, metadata FROM audit_log
      WHERE action = 'secret.revealed' AND tenant_id = ${IDS.tenant1}::uuid
        AND entity_id = (SELECT (credential_secret_ids ->> 'client_secret')::uuid
                         FROM integration_connection WHERE provider = 'action1')
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.purpose).toBe('integration');
  });

  it('updates what Action1 observes and leaves what a person edited', async () => {
    action1.organizations = [{ id: ACME, name: 'Acme Corp' }];
    action1.endpoints = [SERVER];
    await configure();
    await mapOrg(ACME, IDS.orgAcme);
    await runSync();
    const [first] = await devices();

    await withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, async (tx) => {
      await tx`UPDATE asset_node SET name = 'File server (main)' WHERE id = ${first!.id}::uuid`;
      await tx`UPDATE device SET cpu = 'Xeon (corrected)', device_type = 'hypervisor' WHERE id = ${first!.id}::uuid`;
    });

    action1.endpoints = [{
      ...SERVER, address: '10.2.0.11', CPU_name: 'Intel Xeon Silver 4314', last_seen: '2026-10-29_13-00-00',
      missing_updates: { critical: 0, other: 0 },
    }];
    await makeDue();
    expect(await runSync()).toMatchObject({ updated: 1, created: 0 });

    const [after] = await devices();
    expect(after).toMatchObject({
      id: first!.id, name: 'File server (main)', device_type: 'hypervisor', cpu: 'Xeon (corrected)',
      primary_ip: '10.2.0.11',
    });
    expect(after!.last_seen_at?.toISOString()).toBe('2026-10-29T13:00:00.000Z');
    expect(after!.profile).toMatchObject({ missingUpdates: { critical: 0, other: 0 } });
  });

  it('moves the check-in only forward, and refreshes the profile of an unchanged machine', async () => {
    action1.organizations = [{ id: ACME, name: 'Acme Corp' }];
    action1.endpoints = [SERVER];
    await configure();
    await mapOrg(ACME, IDS.orgAcme);
    await runSync();
    const [first] = await devices();
    // NinjaOne saw it more recently than Action1 will report.
    await su((sql) => sql`UPDATE device SET last_seen_at = '2026-10-30T00:00:00Z' WHERE id = ${first!.id}::uuid`);

    action1.endpoints = [{ ...SERVER, last_seen: '2026-10-29_18-00-00', reboot_required: 'Yes' }];
    await makeDue();
    expect(await runSync()).toMatchObject({ unchanged: 1 });
    const [after] = await devices();
    expect(after!.last_seen_at?.toISOString()).toBe('2026-10-30T00:00:00.000Z');
    expect(after!.profile).toMatchObject({ needsReboot: true });
  });

  it('adopts a machine already documented, by serial, and fills only what is empty', async () => {
    await withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, async (tx) => {
      const [node] = await tx<{ id: string }[]>`
        INSERT INTO asset_node (tenant_id, organization_id, node_type, name)
        VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'device', 'Hand-documented file server')
        RETURNING id`;
      await tx`INSERT INTO device (id, tenant_id, node_type, device_type, serial_number, rmm_device_id, cpu)
               VALUES (${node!.id}::uuid, ${IDS.tenant1}::uuid, 'device', 'server', 'fs01ser', '501', 'Typed by hand')`;
    });

    action1.organizations = [{ id: ACME, name: 'Acme Corp' }];
    action1.endpoints = [SERVER];
    await configure();
    await mapOrg(ACME, IDS.orgAcme);
    expect(await runSync()).toMatchObject({ created: 0, updated: 1 });

    const rows = await devices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Hand-documented file server', serial_number: 'fs01ser', cpu: 'Typed by hand',
      hostname: 'ACME-FS01', rmm_device_id: '501',
    });
  });

  it('reads organization by organization when endpoints come back without one', async () => {
    action1.organizations = [{ id: ACME, name: 'Acme Corp' }, { id: GLOBEX, name: 'Globex' }];
    const strip = ({ organization_id: org, ...rest }: Record<string, unknown>) => ({ ...rest, __org: org });
    action1.endpoints = [strip(SERVER), strip(LAPTOP), strip(GLOBEX_PC)];
    await configure();
    await mapOrg(ACME, IDS.orgAcme);

    expect(await runSync()).toMatchObject({ created: 2, failed: 0 });
    const paths = action1.requests.map((r) => new URL(r.url).pathname);
    expect(paths).toContain(`/api/3.0/endpoints/managed/${ACME}`);
    expect(paths).not.toContain(`/api/3.0/endpoints/managed/${GLOBEX}`);
    const rows = await devices();
    expect(rows.every((r) => r.organization_id === IDS.orgAcme)).toBe(true);
  });

  it('records a refused credential as a failed run', async () => {
    action1.organizations = [{ id: ACME, name: 'Acme Corp' }];
    await configure();
    action1.mode = 'bad-credentials';
    expect(await runSync()).toMatchObject({ failed: 1 });
    asAdmin();
    const settings = await json<Action1Settings>(await getAction1(req('GET', '/api/integrations/action1')));
    expect(settings.runs[0]).toMatchObject({ status: 'failed' });
    expect(settings.connection?.lastError).toMatch(/refused the client id and secret/);
  });
});
