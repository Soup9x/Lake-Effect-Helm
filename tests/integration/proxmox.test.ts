/**
 * Proxmox sync (1110), through the real routes, the real worker and a stub
 * Proxmox serving a self-signed certificate over real TLS.
 *
 *   AUTHORITY     integration:hypervisor:manage, and nothing less.
 *   NOTHING BAD   a token or certificate that does not work is not saved.
 *   CERTIFICATES  a self-signed one is refused unless pinned; a pinned one is
 *                 the only one accepted, and the token is never sent to another.
 *   CONTAINMENT   the address and pin only change with the secret; the secret
 *                 is an API key in the MSP's own organisation.
 *   IMPORT        hosts as hypervisors, VMs and containers as virtual machines
 *                 of the connection's client, each on its host; no templates.
 *   PRESERVATION  a re-sync leaves a field somebody edited as they left it.
 *   ADOPTION      a machine already documented is linked, not doubled.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import {
  IDS, buildHarness, connectPools, disconnectPools, resetDatabase, superuserSql, type Harness,
} from './harness';
import { GET as getProxmox, PUT as putProxmox } from '../../src/app/api/integrations/proxmox/route';
import { DELETE as deleteProxmox } from '../../src/app/api/integrations/proxmox/[connectionId]/route';
import { POST as syncNow } from '../../src/app/api/integrations/proxmox/[connectionId]/sync/route';
import { POST as postCertificate } from '../../src/app/api/integrations/proxmox/certificate/route';
import { proxmoxSyncJob } from '../../src/workers/proxmox-sync';
import type { ProxmoxConnection } from '../../src/lib/proxmox/queries';
import type { JobContext, JobLogger } from '../../src/workers/runtime';
import { FakeProxmox } from '../support/fake-proxmox';

let h: Harness;
let pve: FakeProxmox;
let other: FakeProxmox;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};
const asAdmin = () => asUser(IDS.admin1, 'admin@northwind.test');

const TOKEN_ID = 'helm@pve!helm';
const SECRET = '0f6b2c1e-9d3a-4c5b-8e7f-proxmox-secret-never-shown';

const req = (method: string, path: string, payload?: unknown) =>
  new NextRequest(new Request(`https://helm.test${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));
const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;
const params = (connectionId: string) => ({ params: Promise.resolve({ connectionId }) });

const connection = () => ({
  organizationId: IDS.orgInternal,
  baseUrl: pve.url,
  tokenId: TOKEN_ID,
  tokenSecret: SECRET,
  tlsSha256: pve.sha256,
  syncEnabled: true,
  intervalMinutes: 60,
});

const DC = {
  id: 'qemu/100', type: 'qemu', vmid: 100, name: 'pve-test-dc01', node: 'pve1', status: 'running',
  maxmem: 8 * 1024 ** 3, maxdisk: 80 * 1024 ** 3, uptime: 3600, tags: 'prod', template: 0,
};
const WEB = { id: 'qemu/101', type: 'qemu', vmid: 101, name: 'pve-test-web01', node: 'pve2', status: 'stopped', template: 0 };
const CT = { id: 'lxc/200', type: 'lxc', vmid: 200, name: 'pve-test-dns', node: 'pve1', status: 'running', template: 0 };
const TEMPLATE = { id: 'qemu/9000', type: 'qemu', vmid: 9000, name: 'ubuntu-template', node: 'pve1', status: 'stopped', template: 1 };

function stockCluster(guests: Record<string, unknown>[] = [DC, WEB, CT, TEMPLATE]) {
  const r = pve.routes;
  r.set('/version', { version: '8.2.4', release: '8.2' });
  r.set('/cluster/status', [
    { type: 'cluster', name: 'lake-cluster', nodes: 2, quorate: 1 },
    { type: 'node', name: 'pve1', ip: '10.0.0.11', online: 1 },
    { type: 'node', name: 'pve2', ip: '10.0.0.12', online: 1 },
  ]);
  r.set('/nodes', [{ node: 'pve1', status: 'online' }, { node: 'pve2', status: 'online' }]);
  for (const node of ['pve1', 'pve2']) {
    r.set(`/nodes/${node}/status`, {
      cpuinfo: { model: 'AMD EPYC 7302P', sockets: 1, cores: 16, cpus: 32 },
      memory: { total: 128 * 1024 ** 3 }, pveversion: 'pve-manager/8.2.4/faa83925', uptime: 100_000,
    });
  }
  r.set('/cluster/resources?type=vm', guests);
  r.set('/cluster/resources?type=storage', [
    { storage: 'local-lvm', node: 'pve1', plugintype: 'lvmthin', maxdisk: 1024 ** 4, disk: 1024 ** 3, content: 'images,rootdir' },
    { storage: 'pbs', node: 'pve1', plugintype: 'pbs', maxdisk: 1024 ** 4, disk: 1024 ** 3, shared: 1, content: 'backup' },
    { storage: 'pbs', node: 'pve2', plugintype: 'pbs', maxdisk: 1024 ** 4, disk: 1024 ** 3, shared: 1, content: 'backup' },
  ]);
  r.set('/nodes/pve1/storage/pbs/content?content=backup', [
    { volid: 'pbs:backup/vm/100/2026-10-25', vmid: 100, ctime: 1_761_350_400 },
  ]);
  r.set('/nodes/pve1/qemu/100/config', {
    name: 'pve-test-dc01', cores: 2, sockets: 1, memory: '8192', ostype: 'win11', agent: '1',
    net0: 'virtio=BC:24:11:00:01:00,bridge=vmbr0,tag=20', scsi0: 'local-lvm:vm-100-disk-0,size=80G',
  });
  r.set('/nodes/pve1/qemu/100/snapshot', [{ name: 'current' }, { name: 'pre-update', snaptime: 1_761_000_000 }]);
  r.set('/nodes/pve1/qemu/100/agent/network-get-interfaces', { result: [
    { name: 'Ethernet', 'hardware-address': 'bc:24:11:00:01:00', 'ip-addresses': [{ 'ip-address': '10.0.20.10' }] },
  ] });
  r.set('/nodes/pve1/qemu/100/agent/get-osinfo', { result: { 'pretty-name': 'Windows Server 2022 Standard', 'version-id': '2022' } });
  r.set('/nodes/pve1/qemu/100/agent/get-host-name', { result: { 'host-name': 'DC01' } });
  r.set('/nodes/pve2/qemu/101/config', {
    name: 'pve-test-web01', cores: 4, memory: 4096, ostype: 'l26',
    net0: 'virtio=BC:24:11:00:01:01,bridge=vmbr0', scsi0: 'local-lvm:vm-101-disk-0,size=32G',
  });
  r.set('/nodes/pve2/qemu/101/snapshot', [{ name: 'current' }]);
  r.set('/nodes/pve1/lxc/200/config', {
    hostname: 'dns', cores: 1, memory: 512, ostype: 'debian',
    net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:02:00,ip=10.0.0.53/24,gw=10.0.0.1',
    rootfs: 'local-lvm:vm-200-disk-0,size=8G',
  });
  r.set('/nodes/pve1/lxc/200/snapshot', [{ name: 'current' }]);
  r.set('/nodes/pve1/lxc/200/interfaces', [{ name: 'eth0', hwaddr: 'bc:24:11:00:02:00', inet: '10.0.0.53/24' }]);
}

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
  const result = await proxmoxSyncJob().run(ctx);
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

const makeDue = () => su((sql) => sql`UPDATE integration_connection SET last_sync_at = NULL WHERE provider = 'proxmox'`);

async function configure(): Promise<ProxmoxConnection> {
  asAdmin();
  const response = await putProxmox(req('PUT', '/api/integrations/proxmox', connection()));
  expect(response.status).toBe(200);
  return (await json<{ connections: ProxmoxConnection[] }>(response)).connections[0]!;
}

interface Machine {
  id: string; name: string; organization_id: string; device_type: string; hostname: string | null;
  operating_system: string | null; os_version: string | null; cpu: string | null; memory_gb: string | null;
  storage_gb: string | null; primary_ip: string | null; primary_mac: string | null; parent: string | null;
  external_type: string; external_id: string; profile: Record<string, unknown> | null;
}

const machines = () => su((sql) => sql<Machine[]>`
  SELECT n.id, n.name, n.organization_id, d.device_type::text AS device_type, d.hostname::text AS hostname,
         d.operating_system, d.os_version, d.cpu, d.memory_gb::text AS memory_gb, d.storage_gb::text AS storage_gb,
         host(d.primary_ip) AS primary_ip, d.primary_mac::text AS primary_mac,
         (SELECT p.name FROM asset_node p WHERE p.id = d.parent_device_id) AS parent,
         ei.external_type, ei.external_id, ei.profile
  FROM external_identity ei
  JOIN asset_node n ON n.id = ei.node_id
  JOIN device d ON d.id = n.id
  WHERE ei.external_type LIKE 'proxmox\\_%'
  ORDER BY ei.external_type, ei.external_id
`);
const byExternal = (rows: Machine[], id: string) => rows.find((m) => m.external_id === id)!;

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'proxmox tests' });
  pve = await FakeProxmox.start(TOKEN_ID, SECRET);
  other = await FakeProxmox.start(TOKEN_ID, SECRET);
}, 180_000);

afterEach(async () => {
  currentUser = null;
  pve.reset();
  other.reset();
  await su(async (sql) => {
    await sql`DELETE FROM asset_node WHERE id IN (
      SELECT node_id FROM external_identity WHERE external_type LIKE 'proxmox\\_%')`;
    await sql`DELETE FROM asset_node WHERE name LIKE 'Hand-documented%'`;
    await sql`DELETE FROM integration_connection WHERE provider = 'proxmox'`;
  });
});

afterAll(async () => {
  pve.stop();
  other.stop();
  await disconnectPools();
});

describe('connecting a cluster', () => {
  it('tries the token through the pinned certificate, and stores the secret in the vault', async () => {
    stockCluster();
    asAdmin();
    const response = await putProxmox(req('PUT', '/api/integrations/proxmox', connection()));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text) as { connections: ProxmoxConnection[]; tested: Record<string, unknown> };
    expect(body.tested).toEqual({ version: '8.2.4', cluster: 'lake-cluster', hosts: 2 });
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({
      name: 'lake-cluster', organizationId: IDS.orgInternal, baseUrl: pve.url, tokenId: TOKEN_ID,
      tlsSha256: pve.sha256, secretSet: true, status: 'configured',
    });
    expect(pve.authorizations[0]).toBe(`PVEAPIToken=${TOKEN_ID}=${SECRET}`);

    const [stored] = await su((sql) => sql<{ kind: string; organization_id: string; sensitivity: string }[]>`
      SELECT s.kind::text AS kind, s.organization_id, s.sensitivity::text AS sensitivity
      FROM integration_connection c
      JOIN secret s ON s.id = (c.credential_secret_ids ->> 'token_secret')::uuid
      WHERE c.provider = 'proxmox'
    `);
    expect(stored).toEqual({ kind: 'api_key', organization_id: IDS.orgInternal, sensitivity: 'elevated' });
  });

  it('refuses a self-signed certificate nobody pinned, and saves nothing', async () => {
    stockCluster();
    asAdmin();
    const response = await putProxmox(req('PUT', '/api/integrations/proxmox', { ...connection(), tlsSha256: null }));
    expect(response.status).toBe(400);
    const body = await json<{ error: { message: string; details?: { kind?: string } } }>(response);
    expect(body.error.details?.kind).toBe('tls_untrusted');
    expect(pve.authorizations).toHaveLength(0);
    const [row] = await su((sql) => sql<{ n: number }[]>`SELECT count(*)::int AS n FROM integration_connection WHERE provider = 'proxmox'`);
    expect(row?.n).toBe(0);
  });

  it('never sends the token to a certificate other than the pinned one', async () => {
    stockCluster();
    asAdmin();
    // The other server's certificate, pinned against this address.
    const response = await putProxmox(req('PUT', '/api/integrations/proxmox', { ...connection(), tlsSha256: other.sha256 }));
    expect(response.status).toBe(400);
    expect((await json<{ error: { details?: { kind?: string } } }>(response)).error.details?.kind).toBe('tls_pin_mismatch');
    expect(pve.authorizations).toHaveLength(0);
  });

  it('saves nothing when Proxmox refuses the token', async () => {
    stockCluster();
    asAdmin();
    const response = await putProxmox(req('PUT', '/api/integrations/proxmox', { ...connection(), tokenSecret: 'wrong-secret-value' }));
    expect(response.status).toBe(400);
    expect((await json<{ error: { message: string } }>(response)).error.message).toMatch(/refused the API token/);
  });

  it('shows the certificate an address presents, without sending anything', async () => {
    asAdmin();
    const response = await postCertificate(req('POST', '/api/integrations/proxmox/certificate', { baseUrl: pve.url }));
    expect(response.status).toBe(200);
    const { certificate } = await json<{ certificate: { sha256: string; selfSigned: boolean; trusted: boolean } }>(response);
    expect(certificate).toMatchObject({ sha256: pve.sha256, selfSigned: true, trusted: false });
    expect(pve.requests).toHaveLength(0);
  });

  it('asks for the secret again when the address or certificate changes', async () => {
    stockCluster();
    const saved = await configure();
    asAdmin();
    const { tokenSecret: _omit, ...rest } = connection();
    const intervalOnly = await putProxmox(req('PUT', '/api/integrations/proxmox', { ...rest, id: saved.id, intervalMinutes: 240 }));
    expect(intervalOnly.status).toBe(200);
    const moved = await putProxmox(req('PUT', '/api/integrations/proxmox', { ...rest, id: saved.id, baseUrl: other.url, tlsSha256: other.sha256 }));
    expect(moved.status).toBe(400);
    expect(other.requests).toHaveLength(0);
  });

  it('refuses somebody without integration:hypervisor:manage, and lets them read', async () => {
    stockCluster();
    const saved = await configure();
    asUser(IDS.tech1, 'tech1@northwind.test');
    expect((await putProxmox(req('PUT', '/api/integrations/proxmox', connection()))).status).toBe(403);
    expect((await syncNow(req('POST', `/api/integrations/proxmox/${saved.id}/sync`), params(saved.id))).status).toBe(403);
    expect((await deleteProxmox(req('DELETE', `/api/integrations/proxmox/${saved.id}`), params(saved.id))).status).toBe(403);
    expect((await postCertificate(req('POST', '/api/integrations/proxmox/certificate', { baseUrl: pve.url }))).status).toBe(403);
    const read = await getProxmox(req('GET', '/api/integrations/proxmox'));
    expect(read.status).toBe(200);
  });
});

describe('where the token may go', () => {
  const admin = { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' as const };

  it('refuses moving the address or the pin without a new secret, by any path', async () => {
    stockCluster();
    await configure();
    await expect(withTenant(admin, async (tx) => tx`
      UPDATE integration_connection SET base_url = 'https://collector.evil.test' WHERE provider = 'proxmox'`))
      .rejects.toThrow(/changes only with its token secret/);
    await expect(withTenant(admin, async (tx) => tx`
      UPDATE integration_connection SET config = config - 'tls_sha256' WHERE provider = 'proxmox'`))
      .rejects.toThrow(/changes only with its token secret/);
  });

  it('refuses a credential that is not an API key in the MSP\'s own organisation', async () => {
    stockCluster();
    await configure();
    const created = await h.secrets.create(admin,
      { organizationId: IDS.orgAcme, kind: 'api_key', label: 'Acme API key', sensitivity: 'standard' },
      'acme-api-key-value');
    await expect(withTenant(admin, async (tx) => tx`
      UPDATE integration_connection
      SET credential_secret_ids = jsonb_build_object('token_secret', ${created.secretId}::text)
      WHERE provider = 'proxmox'`)).rejects.toThrow(/only use an API key kept in the MSP/);
  });

  it('refuses an address with a path', async () => {
    asAdmin();
    const response = await putProxmox(req('PUT', '/api/integrations/proxmox', { ...connection(), baseUrl: `${pve.url}/elsewhere` }));
    expect(response.status).toBe(400);
    expect(pve.requests).toHaveLength(0);
  });
});

describe('the sync worker', () => {
  it('imports hosts and guests to the connection\'s client, each on its host, without templates', async () => {
    stockCluster();
    await configure();
    const counts = await runSync();
    expect(counts).toMatchObject({ connections: 1, created: 5, skipped: 1, failed: 0 });

    const rows = await machines();
    expect(rows).toHaveLength(5);
    expect(rows.every((m) => m.organization_id === IDS.orgInternal)).toBe(true);

    expect(byExternal(rows, 'pve1')).toMatchObject({
      name: 'pve1', device_type: 'hypervisor', hostname: 'pve1', operating_system: 'Proxmox VE',
      os_version: '8.2.4', cpu: 'AMD EPYC 7302P', memory_gb: '128.00', primary_ip: '10.0.0.11',
      profile: expect.objectContaining({ kind: 'node', cluster: 'lake-cluster', guests: { running: 2, total: 2 } }),
    });
    expect(byExternal(rows, '100')).toMatchObject({
      name: 'pve-test-dc01', device_type: 'virtual_machine', hostname: 'DC01',
      operating_system: 'Windows Server 2022 Standard', os_version: '2022', cpu: '2 vCPU', memory_gb: '8.00',
      storage_gb: '80.00', primary_ip: '10.0.20.10', primary_mac: 'bc:24:11:00:01:00', parent: 'pve1',
      profile: expect.objectContaining({
        kind: 'qemu', status: 'running', agent: 'answered', tags: ['prod'],
        snapshots: expect.objectContaining({ count: 1, latestName: 'pre-update' }),
        lastBackupAt: new Date(1_761_350_400_000).toISOString(),
      }),
    });
    expect(byExternal(rows, '101')).toMatchObject({
      device_type: 'virtual_machine', operating_system: 'Linux', parent: 'pve2', primary_ip: null,
    });
    expect(byExternal(rows, '200')).toMatchObject({
      name: 'pve-test-dns', hostname: 'dns', operating_system: 'Debian', primary_ip: '10.0.0.53', parent: 'pve1',
      profile: expect.objectContaining({ kind: 'lxc' }),
    });
    // A stopped VM's agent is not asked.
    expect(pve.requests.some((p) => p.includes('/qemu/101/agent/'))).toBe(false);

    // The secret was revealed through the audited path, once per run.
    const reveals = await su((sql) => sql<{ actor_type: string; metadata: { purpose?: string } }[]>`
      SELECT actor_type::text AS actor_type, metadata FROM audit_log
      WHERE action = 'secret.revealed' AND tenant_id = ${IDS.tenant1}::uuid
        AND entity_id = (SELECT (credential_secret_ids ->> 'token_secret')::uuid
                         FROM integration_connection WHERE provider = 'proxmox')
    `);
    expect(reveals).toHaveLength(1);
    expect(reveals[0]).toMatchObject({ actor_type: 'service_account', metadata: { purpose: 'integration' } });
  });

  it('leaves a field somebody edited, and follows a VM to its new host', async () => {
    stockCluster();
    await configure();
    await runSync();
    const dc = byExternal(await machines(), '100');
    await su((sql) => sql`UPDATE device SET operating_system = 'Windows Server 2022 Datacenter (licensed)' WHERE id = ${dc.id}::uuid`);

    pve.routes.set('/cluster/resources?type=vm', [{ ...DC, node: 'pve2' }, WEB, CT, TEMPLATE]);
    pve.routes.set('/nodes/pve2/qemu/100/config', pve.routes.get('/nodes/pve1/qemu/100/config'));
    pve.routes.set('/nodes/pve2/qemu/100/snapshot', []);
    await makeDue();
    const counts = await runSync();
    expect(counts.failed).toBe(0);

    const after = byExternal(await machines(), '100');
    expect(after.operating_system).toBe('Windows Server 2022 Datacenter (licensed)');
    expect(after.parent).toBe('pve2');
    expect(after.id).toBe(dc.id);
  });

  it('leaves a VM where a person put it', async () => {
    stockCluster();
    await configure();
    await runSync();
    const rows = await machines();
    await su((sql) => sql`UPDATE device SET parent_device_id = ${byExternal(rows, 'pve2').id}::uuid
                          WHERE id = ${byExternal(rows, '200').id}::uuid`);
    pve.routes.set('/cluster/resources?type=vm', [DC, WEB, { ...CT, maxmem: 2 * 1024 ** 3 }, TEMPLATE]);
    pve.routes.set('/nodes/pve1/lxc/200/config', { ...(pve.routes.get('/nodes/pve1/lxc/200/config') as object), memory: 2048 });
    await makeDue();
    await runSync();
    const ct = byExternal(await machines(), '200');
    expect(ct.parent).toBe('pve2');
    expect(ct.memory_gb).toBe('2.00');
  });

  it('adopts a machine already documented with the same MAC rather than doubling it', async () => {
    stockCluster();
    const [hand] = await su((sql) => sql<{ id: string }[]>`
      INSERT INTO asset_node (tenant_id, organization_id, node_type, name, status)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgInternal}::uuid, 'device', 'Hand-documented DC', 'active') RETURNING id`);
    await su((sql) => sql`INSERT INTO device (id, tenant_id, node_type, device_type, primary_mac, operating_system)
                          VALUES (${hand!.id}::uuid, ${IDS.tenant1}::uuid, 'device', 'server', 'bc:24:11:00:01:00', 'Windows')`);
    await configure();
    const counts = await runSync();
    expect(counts.created).toBe(4);

    const dc = byExternal(await machines(), '100');
    expect(dc).toMatchObject({ id: hand!.id, name: 'Hand-documented DC', device_type: 'server', operating_system: 'Windows', parent: 'pve1' });
  });

  it('says once that the token may not ask guest agents, and syncs everything else', async () => {
    stockCluster();
    pve.refuse.add('/nodes/pve1/qemu/100/agent/network-get-interfaces');
    await configure();
    const counts = await runSync();
    expect(counts).toMatchObject({ created: 5, failed: 0 });
    const [run] = await su((sql) => sql<{ status: string; error_summary: string | null }[]>`
      SELECT r.status::text AS status, r.error_summary FROM integration_sync_run r
      JOIN integration_connection c ON c.id = r.connection_id WHERE c.provider = 'proxmox'
      ORDER BY r.started_at DESC LIMIT 1`);
    expect(run?.status).toBe('partial');
    expect(run?.error_summary).toMatch(/VM\.Monitor/);
  });

  it('imports nothing for a client somebody archived', async () => {
    stockCluster();
    await configure();
    await su((sql) => sql`UPDATE organization SET archived_at = now() WHERE id = ${IDS.orgInternal}::uuid`);
    pve.requests.length = 0;
    try {
      const counts = await runSync();
      expect(counts.created).toBe(0);
      expect(pve.requests).toHaveLength(0);
    } finally {
      await su((sql) => sql`UPDATE organization SET archived_at = NULL WHERE id = ${IDS.orgInternal}::uuid`);
    }
  });

  it('records a failure that names the fix when the certificate changes', async () => {
    stockCluster();
    await configure();
    // As if Proxmox's certificate were replaced: the pin no longer matches.
    // Written past the trigger, which would otherwise (rightly) refuse it.
    await su((sql) => sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE integration_connection SET base_url = ${other.url} WHERE provider = 'proxmox'`;
    }));
    const counts = await runSync();
    expect(counts.failed).toBe(1);
    expect(other.authorizations).toHaveLength(0);
    const [row] = await su((sql) => sql<{ last_error: string | null }[]>`
      SELECT last_error FROM integration_connection WHERE provider = 'proxmox'`);
    expect(row?.last_error).toMatch(/does not match/);
  });

  it('keeps what it imported when the cluster is disconnected', async () => {
    stockCluster();
    const saved = await configure();
    await runSync();
    asAdmin();
    const response = await deleteProxmox(req('DELETE', `/api/integrations/proxmox/${saved.id}`), params(saved.id));
    expect(response.status).toBe(200);
    const [row] = await su((sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM asset_node WHERE name IN ('pve1', 'pve2', 'pve-test-dc01')`);
    expect(row?.n).toBe(3);
    await su((sql) => sql`DELETE FROM asset_node WHERE name IN ('pve1', 'pve2', 'pve-test-dc01', 'pve-test-web01', 'pve-test-dns')
                          AND organization_id = ${IDS.orgInternal}::uuid`);
  });
});
