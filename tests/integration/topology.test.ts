/**
 * Per-site network topology: what it isolates, and what it lets a person
 * change.
 *
 * A person is the only writer (0580 removed the UniFi seeding), so what is
 * worth asserting here is tenant and organisation isolation, the shape of a
 * partial update, and that the permission ladder is enforced by the database
 * rather than only by the route.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import {
  buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql, type Harness,
} from './harness';

import { GET as getTopology } from '../../src/app/api/sites/[siteId]/topology/route';
import { POST as postNode } from '../../src/app/api/sites/[siteId]/topology/nodes/route';
import {
  PATCH as patchNode, DELETE as deleteNode,
} from '../../src/app/api/sites/[siteId]/topology/nodes/[nodeId]/route';
import { POST as postLink } from '../../src/app/api/sites/[siteId]/topology/links/route';
import { DELETE as deleteLink } from '../../src/app/api/sites/[siteId]/topology/links/[linkId]/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => { currentUser = { id, email }; };

// The harness builds the full service set, which includes the blind-index
// service. Topology stores no blind indexes itself (0580), but constructing the
// services without a key would fail before any test ran.
process.env.HELM_BLIND_INDEX_KEY_B64 = Buffer.alloc(32, 7).toString('base64');

const SITE = '1e900000-0000-0000-0000-000000000001';
const SITE_B = '1e900000-0000-0000-0000-000000000002';
/** Tenant 2's site, for the isolation tests. */
const SITE_T2 = '2e900000-0000-0000-0000-000000000001';

const request = (method: string, payload?: unknown) =>
  new NextRequest(new Request('https://helm.test/api/sites/x/topology', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));

const body = async (r: Response) => (await r.json()) as Record<string, unknown>;
const siteParams = (siteId = SITE) => ({ params: Promise.resolve({ siteId }) });
const nodeParams = (nodeId: string, siteId = SITE) =>
  ({ params: Promise.resolve({ siteId, nodeId }) });
const linkParams = (linkId: string, siteId = SITE) =>
  ({ params: Promise.resolve({ siteId, linkId }) });

async function seedSites(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`
      INSERT INTO site (id, tenant_id, organization_id, name) VALUES
        (${SITE}::uuid,    ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid,    'Acme HQ'),
        (${SITE_B}::uuid,  ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid,    'Acme Annexe'),
        (${SITE_T2}::uuid, ${IDS.tenant2}::uuid, ${IDS.orgContoso}::uuid, 'Contoso HQ')
      ON CONFLICT (id) DO NOTHING
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Create a manual node through the real route. */
async function makeNode(label: string, extra: Record<string, unknown> = {}, siteId = SITE) {
  const response = await postNode(request('POST', { label, ...extra }), siteParams(siteId));
  expect(response.status).toBe(200);
  return (await body(response)).nodeId as string;
}

async function wipe(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`DELETE FROM topology_link`;
    await sql`DELETE FROM topology_node`;
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
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'topology tests' });
  await h.keys.provision(IDS.tenant2, IDS.admin2, { reason: 'topology tests' });
  await seedSites();
}, 180_000);

afterEach(async () => {
  currentUser = null;
  await wipe();
});

afterAll(async () => {
  await disconnectPools();
});

// ---------------------------------------------------------------------------
describe('tenant isolation', () => {
  it('keeps one tenant’s diagram out of another tenant’s reach', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const a = await makeNode('Acme core switch');
    const b = await makeNode('Acme firewall');
    await postLink(request('POST', { fromNodeId: a, toNodeId: b }), siteParams());

    // The other tenant's administrator, on their own site.
    asUser(IDS.admin2, 'admin@contoso.test');
    const response = await getTopology(request('GET'), siteParams(SITE_T2));
    expect(response.status).toBe(200);
    const seen = await body(response);
    expect(seen.nodes).toEqual([]);
    expect(seen.links).toEqual([]);

    // And asking for tenant 1's site directly is a 404, not a peek: RLS
    // refuses the site, so "not there" and "not yours" are one answer.
    expect((await getTopology(request('GET'), siteParams(SITE))).status).toBe(404);
  });

  it('refuses a raw cross-tenant read at the table, not just at the route', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await makeNode('Acme core switch');

    const counts = await withTenant(
      { tenantId: IDS.tenant2, actorId: IDS.admin2, actorType: 'user' },
      async (tx) => {
        const [n] = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM topology_node`;
        const [l] = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM topology_link`;
        return { nodes: n!.n, links: l!.n };
      },
    );
    expect(counts).toEqual({ nodes: '0', links: '0' });
  });
});

// ---------------------------------------------------------------------------
describe('drawing by hand', () => {
  beforeAll(() => { asUser(IDS.admin1, 'admin@northwind.test'); });

  it('adds a node with a position and reads it back', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const id = await makeNode('ISP handoff', {
      deviceType: 'router', ipAddress: '203.0.113.1', subnet: '203.0.113.0/30',
      posX: 40, posY: 80,
    });

    const graph = await body(await getTopology(request('GET'), siteParams()));
    const nodes = graph.nodes as Record<string, unknown>[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id, label: 'ISP handoff', deviceType: 'router',
      ipAddress: '203.0.113.1', subnet: '203.0.113.0/30', posX: 40, posY: 80,
    });
  });

  it('refuses half a position', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await postNode(request('POST', { label: 'Half', posX: 10 }), siteParams());
    expect(response.status).toBe(400);
  });

  it('links two nodes, and refuses the same pair twice in either direction', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const a = await makeNode('Core switch');
    const b = await makeNode('Edge firewall');

    const first = await postLink(request('POST', { fromNodeId: a, toNodeId: b, label: 'Gi1/0/1' }), siteParams());
    expect(first.status).toBe(200);

    expect((await postLink(request('POST', { fromNodeId: a, toNodeId: b }), siteParams())).status).toBe(409);
    // Reversed is the same cable, and drawing it twice would stack two lines.
    expect((await postLink(request('POST', { fromNodeId: b, toNodeId: a }), siteParams())).status).toBe(409);
  });

  it('refuses a link to itself and a link across two sites', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const a = await makeNode('Core switch');
    const elsewhere = await makeNode('Annexe switch', {}, SITE_B);

    expect((await postLink(request('POST', { fromNodeId: a, toNodeId: a }), siteParams())).status).toBe(400);
    const crossed = await postLink(
      request('POST', { fromNodeId: a, toNodeId: elsewhere }), siteParams());
    expect(crossed.status).toBe(400);
  });

  it('deletes a node and the lines that touched it', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const a = await makeNode('Core switch');
    const b = await makeNode('Edge firewall');
    await postLink(request('POST', { fromNodeId: a, toNodeId: b }), siteParams());

    expect((await deleteNode(request('DELETE'), nodeParams(a))).status).toBe(200);

    const graph = await body(await getTopology(request('GET'), siteParams()));
    expect((graph.nodes as unknown[])).toHaveLength(1);
    // The FK cascades; a line to a box that is gone cannot be drawn.
    expect((graph.links as unknown[])).toHaveLength(0);
  });

  it('deletes a single link without touching its endpoints', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const a = await makeNode('Core switch');
    const b = await makeNode('Edge firewall');
    const linkId = (await body(
      await postLink(request('POST', { fromNodeId: a, toNodeId: b }), siteParams()),
    )).linkId as string;

    const response = await deleteLink(request('DELETE'), linkParams(linkId));
    expect(response.status).toBe(200);
    expect((await body(response)).deleted).toBe(linkId);

    const graph = await body(await getTopology(request('GET'), siteParams()));
    expect((graph.nodes as unknown[])).toHaveLength(2);
    expect((graph.links as unknown[])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('changing one box', () => {
  it('a drag persists the position and nothing else', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const id = await makeNode('Core switch', { ipAddress: '10.0.0.1' });

    expect((await patchNode(request('PATCH', { posX: 300, posY: 120 }), nodeParams(id))).status).toBe(200);

    const nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    expect(nodes[0]).toMatchObject({ posX: 300, posY: 120, label: 'Core switch', ipAddress: '10.0.0.1' });
  });

  it('an edit changes only the field it names', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const id = await makeNode('Core switch', {
      ipAddress: '10.0.0.1', subnet: '10.0.0.0/24', deviceType: 'switch',
    });

    await patchNode(request('PATCH', { label: 'Core switch (rack 3)' }), nodeParams(id));

    const nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    expect(nodes[0]).toMatchObject({
      label: 'Core switch (rack 3)',
      ipAddress: '10.0.0.1',
      subnet: '10.0.0.0/24',
      deviceType: 'switch',
    });
  });

  /*
   * The distinction the PATCH shape turns on. An absent field is left alone; an
   * explicit null clears it. Collapsing the two would mean a drag — which sends
   * only coordinates — erased every annotation on the box.
   */
  it('an explicit null clears a field, and an absent one is left alone', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const id = await makeNode('Core switch', { ipAddress: '10.0.0.1', subnet: '10.0.0.0/24' });

    await patchNode(request('PATCH', { subnet: null }), nodeParams(id));

    let nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    expect(nodes[0]).toMatchObject({ subnet: null, ipAddress: '10.0.0.1' });

    await patchNode(request('PATCH', { posX: 10, posY: 10 }), nodeParams(id));

    nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    expect(nodes[0]).toMatchObject({ subnet: null, ipAddress: '10.0.0.1', posX: 10 });
  });
});

// ---------------------------------------------------------------------------
describe('who may edit', () => {
  it('lets a tier1 technician draw', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const response = await postNode(request('POST', { label: 'Drawn by tier1' }), siteParams());
    expect(response.status).toBe(200);
  });

  it('refuses a read-only client user, who holds no asset:write', async () => {
    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await postNode(request('POST', { label: 'Nope' }), siteParams());
    expect(response.status).toBe(403);
  });

  it('lets that same user READ the diagram', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await makeNode('Core switch');

    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await getTopology(request('GET'), siteParams());
    expect(response.status).toBe(200);
    expect((await body(response)).nodes).toHaveLength(1);
  });

  /**
   * client_admin holds asset:write, so tenantRoute lets the request through —
   * and the write still fails, because the RLS policy 0570 applies requires
   * role rank 40 and a client administrator is rank 30. Two independent gates,
   * and this is the one that actually holds.
   */
  it('refuses a client administrator at the database even though the route allows them', async () => {
    asUser(IDS.acmeAdmin, 'admin@acme.test');
    const response = await postNode(request('POST', { label: 'Client drawn' }), siteParams());
    // 403, not 500: an RLS refusal is SQLSTATE 42501, which the handler already
    // maps to forbidden. The client administrator is told no, rather than shown
    // a fault.
    expect(response.status).toBe(403);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM topology_node`;
      expect(row!.n).toBe('0');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
