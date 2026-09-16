/**
 * Creating and renaming sites and assets.
 *
 * An asset is two rows — the node that takes part in the graph and the subtype
 * row holding what is true only of that kind — and the interesting property is
 * that they are written together or not at all. A node without its subtype row
 * appears in every list and opens to nothing, which is worse than the write
 * having failed.
 *
 * The rest is refusals: node_type and organization_id cannot be edited, a
 * client you cannot reach is indistinguishable from one that does not exist,
 * and `is_primary` is a claim about the client rather than about one row.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { GET as listSites, POST as createSite } from '../../src/app/api/sites/route';
import { PATCH as patchSite } from '../../src/app/api/sites/[siteId]/route';
import { POST as createAsset } from '../../src/app/api/assets/route';
import { PATCH as patchAsset } from '../../src/app/api/assets/[nodeId]/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const request = (url: string, init: RequestInit = {}) =>
  new NextRequest(new Request(`http://helm.test${url}`, init));

const send = (method: string) => (url: string, payload: unknown) =>
  request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
const post = send('POST');
const patch = send('PATCH');

const body = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const withParams = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'test provisioning' });
}, 120_000);

afterEach(() => {
  currentUser = null;
});

afterAll(async () => {
  await disconnectPools();
});

describe('POST /api/sites', () => {
  it('adds a site that then appears in the list', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await createSite(
      post('/api/sites', {
        organizationId: IDS.orgAcme,
        name: 'Buffalo HQ',
        code: 'BUF-HQ',
        city: 'Buffalo',
        region: 'NY',
      }),
    );
    expect(created.status).toBe(200);

    asUser(IDS.admin1, 'admin@northwind.test');
    const listed = await listSites(request(`/api/sites?organizationId=${IDS.orgAcme}`));
    const sites = (await body(listed)).sites as { name: string; code: string | null }[];
    expect(sites.map((s) => s.name)).toContain('Buffalo HQ');
  });

  it('demotes the previous primary rather than refusing the second one', async () => {
    // "Which of these is the head office" has one answer. Making the caller
    // demote the old one first would turn a rename into a two-step dance.
    asUser(IDS.admin1, 'admin@northwind.test');
    const first = await createSite(
      post('/api/sites', { organizationId: IDS.orgAcme, name: 'First HQ', isPrimary: true }),
    );
    expect(first.status).toBe(200);

    asUser(IDS.admin1, 'admin@northwind.test');
    const second = await createSite(
      post('/api/sites', { organizationId: IDS.orgAcme, name: 'Second HQ', isPrimary: true }),
    );
    expect(second.status).toBe(200);

    const sql = superuserSql();
    try {
      const rows = await sql<{ name: string }[]>`
        SELECT name FROM site
        WHERE organization_id = ${IDS.orgAcme}::uuid AND is_primary AND deleted_at IS NULL
      `;
      expect(rows.map((r) => r.name)).toEqual(['Second HQ']);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses a client the actor cannot reach', async () => {
    asUser(IDS.acmeAdmin, 'admin@acme.test');
    const response = await createSite(
      post('/api/sites', { organizationId: IDS.orgGlobex, name: 'Out of scope' }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM site WHERE name = 'Out of scope'
      `;
      expect(row!.n).toBe('0');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses a role without asset:write', async () => {
    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await createSite(
      post('/api/sites', { organizationId: IDS.orgAcme, name: 'Read only' }),
    );
    expect(response.status).toBe(403);
  });
});

describe('PATCH /api/sites/[siteId]', () => {
  it('renames a site', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await createSite(
      post('/api/sites', { organizationId: IDS.orgAcme, name: 'Before', code: 'OLD' }),
    );
    const siteId = ((await body(created)).site as { id: string }).id;

    asUser(IDS.admin1, 'admin@northwind.test');
    const renamed = await patchSite(
      patch(`/api/sites/${siteId}`, { name: 'After' }),
      withParams({ siteId }),
    );
    expect(renamed.status).toBe(200);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ name: string; code: string | null }[]>`
        SELECT name, code FROM site WHERE id = ${siteId}::uuid
      `;
      expect(row!.name).toBe('After');
      // Untouched fields survive a rename.
      expect(row!.code).toBe('OLD');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses an empty patch', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await createSite(
      post('/api/sites', { organizationId: IDS.orgAcme, name: 'Empty patch target' }),
    );
    const siteId = ((await body(created)).site as { id: string }).id;

    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchSite(patch(`/api/sites/${siteId}`, {}), withParams({ siteId }));
    expect(response.status).toBe(400);
  });
});

describe('POST /api/assets', () => {
  it('writes the node and its subtype row together', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await createAsset(
      post('/api/assets', {
        organizationId: IDS.orgAcme,
        nodeType: 'device',
        name: 'DC02',
        deviceType: 'server',
      }),
    );
    expect(created.status).toBe(200);
    const assetId = ((await body(created)).asset as { id: string }).id;

    const sql = superuserSql();
    try {
      const [node] = await sql<{ node_type: string }[]>`
        SELECT node_type::text FROM asset_node WHERE id = ${assetId}::uuid
      `;
      const [device] = await sql<{ device_type: string }[]>`
        SELECT device_type::text FROM device WHERE id = ${assetId}::uuid
      `;
      expect(node!.node_type).toBe('device');
      expect(device!.device_type).toBe('server');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('leaves no orphan node when the subtype field is missing', async () => {
    // A device with no device_type cannot be written. The node must not be
    // left behind on its own: it would list everywhere and open to nothing.
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await createAsset(
      post('/api/assets', {
        organizationId: IDS.orgAcme,
        nodeType: 'device',
        name: 'Orphan candidate',
      }),
    );
    expect(response.status).toBe(400);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM asset_node WHERE name = 'Orphan candidate'
      `;
      expect(row!.n).toBe('0');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('rolls the node back when the SUBTYPE insert is what fails', async () => {
    // The previous test passes because validation runs before the node is
    // written. This one gets past validation and fails on the second insert:
    // "not-an-ip" is inside the length limit but is not an inet. The node must
    // not survive its own subtype row failing — that is the transaction's job,
    // not the validator's, and it is what covers every case the validator does
    // not know about.
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await createAsset(
      post('/api/assets', {
        organizationId: IDS.orgAcme,
        nodeType: 'ip_address',
        name: 'Rollback candidate',
        address: 'not-an-ip',
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM asset_node WHERE name = 'Rollback candidate'
      `;
      expect(row!.n).toBe('0');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('creates every type that needs no extra field', async () => {
    for (const nodeType of ['vendor', 'application', 'contract', 'license', 'isp_circuit']) {
      asUser(IDS.admin1, 'admin@northwind.test');
      const response = await createAsset(
        post('/api/assets', {
          organizationId: IDS.orgAcme,
          nodeType,
          name: `Test ${nodeType}`,
        }),
      );
      expect(response.status, `${nodeType} should be creatable`).toBe(200);
    }
  });

  it('creates each type that needs exactly one extra field', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['network', { networkKind: 'vlan' }],
      ['directory_service', { directoryKind: 'active_directory' }],
      ['ip_address', { address: '10.10.4.7' }],
      ['domain', { domainName: 'acme-test.example' }],
      ['ssl_certificate', { commonName: 'www.acme-test.example' }],
    ];
    for (const [nodeType, extra] of cases) {
      asUser(IDS.admin1, 'admin@northwind.test');
      const response = await createAsset(
        post('/api/assets', {
          organizationId: IDS.orgAcme,
          nodeType,
          name: `Test ${nodeType}`,
          ...extra,
        }),
      );
      expect(response.status, `${nodeType} should be creatable`).toBe(200);
    }
  });

  it('will not create a credential, SOP or flexible asset through this route', async () => {
    // Each is a node, and each is created by the flow that owns its payload. A
    // credential created here would be a graph entry with no encrypted value
    // behind it.
    for (const nodeType of ['credential', 'sop', 'flexible_asset']) {
      asUser(IDS.admin1, 'admin@northwind.test');
      const response = await createAsset(
        post('/api/assets', { organizationId: IDS.orgAcme, nodeType, name: 'Nope' }),
      );
      expect(response.status, `${nodeType} must not be creatable here`).toBe(400);
    }
  });
});

describe('PATCH /api/assets/[nodeId]', () => {
  it('renames an asset', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchAsset(
      patch(`/api/assets/${IDS.firewall}`, { name: 'Perimeter firewall' }),
      withParams({ nodeId: IDS.firewall }),
    );
    expect(response.status).toBe(200);
    expect(((await body(response)).asset as { name: string }).name).toBe('Perimeter firewall');
  });

  it('cannot change the node type, so the subtype row is never orphaned', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchAsset(
      patch(`/api/assets/${IDS.firewall}`, { nodeType: 'domain', node_type: 'domain' }),
      withParams({ nodeId: IDS.firewall }),
    );
    // Unknown keys are stripped, so this is a patch with no recognised field.
    expect(response.status).toBe(400);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ node_type: string }[]>`
        SELECT node_type::text FROM asset_node WHERE id = ${IDS.firewall}::uuid
      `;
      expect(row!.node_type).toBe('device');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('cannot move an asset to another client', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchAsset(
      patch(`/api/assets/${IDS.firewall}`, {
        organizationId: IDS.orgGlobex,
        organization_id: IDS.orgGlobex,
      }),
      withParams({ nodeId: IDS.firewall }),
    );
    expect(response.status).toBe(400);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ organization_id: string }[]>`
        SELECT organization_id::text FROM asset_node WHERE id = ${IDS.firewall}::uuid
      `;
      expect(row!.organization_id).toBe(IDS.orgAcme);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("cannot reach another tenant's asset", async () => {
    asUser(IDS.admin2, 'admin@contoso.test');
    const response = await patchAsset(
      patch(`/api/assets/${IDS.firewall}`, { name: 'Taken over' }),
      withParams({ nodeId: IDS.firewall }),
    );
    expect(response.status).toBe(400);
  });
});
