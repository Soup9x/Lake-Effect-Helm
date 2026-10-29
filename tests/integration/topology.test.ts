/**
 * Network diagrams, a record of their own under a client's Diagrams tab (0880):
 * what they isolate, what they let a person change, and how a box stands for a
 * configuration.
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

import { POST as postDiagram } from '../../src/app/api/diagrams/route';
import { PATCH as patchDiagram, DELETE as deleteDiagram } from '../../src/app/api/diagrams/[diagramId]/route';
import { GET as getTopology } from '../../src/app/api/diagrams/[diagramId]/topology/route';
import { POST as postNode } from '../../src/app/api/diagrams/[diagramId]/topology/nodes/route';
import {
  PATCH as patchNode, DELETE as deleteNode,
} from '../../src/app/api/diagrams/[diagramId]/topology/nodes/[nodeId]/route';
import { POST as postLink } from '../../src/app/api/diagrams/[diagramId]/topology/links/route';
import {
  PATCH as patchLink, DELETE as deleteLink,
} from '../../src/app/api/diagrams/[diagramId]/topology/links/[linkId]/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => { currentUser = { id, email }; };

// The harness builds the full service set, which includes the blind-index
// service. Topology stores no blind indexes itself (0580), but constructing the
// services without a key would fail before any test ran.
process.env.HELM_BLIND_INDEX_KEY_B64 = Buffer.alloc(32, 7).toString('base64');

/** Two of Acme's diagrams, about the fixtures' network and about nothing. */
const NET = '1e910000-0000-0000-0000-000000000001';
const NET_B = '1e910000-0000-0000-0000-000000000002';
/** Tenant 2's diagram, for the isolation tests. */
const NET_T2 = '2e910000-0000-0000-0000-000000000001';

const request = (method: string, payload?: unknown) =>
  new NextRequest(new Request('https://helm.test/api/diagrams/x/topology', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));

const body = async (r: Response) => (await r.json()) as Record<string, unknown>;
const siteParams = (diagramId: string = NET) => ({ params: Promise.resolve({ diagramId }) });
const nodeParams = (nodeId: string, diagramId: string = NET) =>
  ({ params: Promise.resolve({ diagramId, nodeId }) });
const linkParams = (linkId: string, diagramId: string = NET) =>
  ({ params: Promise.resolve({ diagramId, linkId }) });

async function seedNetworks(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`
      INSERT INTO network_diagram (id, tenant_id, organization_id, network_id, name) VALUES
        (${NET}::uuid,    ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid,    ${IDS.network}::uuid, 'Acme LAN'),
        (${NET_B}::uuid,  ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid,    NULL, 'Acme guest wifi'),
        (${NET_T2}::uuid, ${IDS.tenant2}::uuid, ${IDS.orgContoso}::uuid, NULL, 'Contoso LAN')
      ON CONFLICT (id) DO NOTHING
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Create a manual node through the real route. */
async function makeNode(label: string, extra: Record<string, unknown> = {}, diagramId: string = NET) {
  const response = await postNode(request('POST', { label, ...extra }), siteParams(diagramId));
  expect(response.status).toBe(200);
  return (await body(response)).nodeId as string;
}

async function wipe(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`DELETE FROM topology_link`;
    await sql`DELETE FROM topology_node`;
    await sql`UPDATE network_diagram SET canvas_width = NULL, canvas_height = NULL`;
    // Diagrams a test created; the three seeded ones stay.
    await sql`DELETE FROM network_diagram WHERE id NOT IN (${NET}::uuid, ${NET_B}::uuid, ${NET_T2}::uuid)`;
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
  await seedNetworks();
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

    // The other tenant's administrator, on their own diagram.
    asUser(IDS.admin2, 'admin@contoso.test');
    const response = await getTopology(request('GET'), siteParams(NET_T2));
    expect(response.status).toBe(200);
    const seen = await body(response);
    expect(seen.nodes).toEqual([]);
    expect(seen.links).toEqual([]);

    // And asking for tenant 1's diagram directly is a 404, not a peek: RLS
    // refuses the row, so "not there" and "not yours" are one answer.
    expect((await getTopology(request('GET'), siteParams(NET))).status).toBe(404);
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

  it('refuses a link to itself and a link across two diagrams', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const a = await makeNode('Core switch');
    const elsewhere = await makeNode('Guest AP', {}, NET_B);

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
describe('styling lines and boxes, and sizing the canvas (1190)', () => {
  const linkOf = async (id: string) =>
    ((await body(await getTopology(request('GET'), siteParams()))).links as Record<string, unknown>[])
      .find((l) => l.id === id);

  it('draws a plain solid line unless told otherwise, and takes a style at creation', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const a = await makeNode('Core switch');
    const b = await makeNode('Edge firewall');
    const c = await makeNode('VPN peer');

    const plain = (await body(await postLink(request('POST', { fromNodeId: a, toNodeId: b }), siteParams()))).linkId as string;
    expect(await linkOf(plain)).toMatchObject({ lineStyle: 'solid', arrow: 'none', color: null });

    const styled = (await body(await postLink(request('POST', {
      fromNodeId: b, toNodeId: c, lineStyle: 'dotted', arrow: 'both', color: 'purple',
    }), siteParams()))).linkId as string;
    expect(await linkOf(styled)).toMatchObject({ lineStyle: 'dotted', arrow: 'both', color: 'purple' });
  });

  it('changes one line’s style, arrow, colour and label, each on its own', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const a = await makeNode('Core switch');
    const b = await makeNode('Edge firewall');
    const id = (await body(await postLink(
      request('POST', { fromNodeId: a, toNodeId: b, label: 'Gi1/0/1' }), siteParams(),
    ))).linkId as string;

    expect((await patchLink(request('PATCH', { lineStyle: 'dashed' }), linkParams(id))).status).toBe(200);
    expect((await patchLink(request('PATCH', { arrow: 'end', color: 'green' }), linkParams(id))).status).toBe(200);
    expect(await linkOf(id)).toMatchObject({ lineStyle: 'dashed', arrow: 'end', color: 'green', label: 'Gi1/0/1' });

    await patchLink(request('PATCH', { label: null, color: null }), linkParams(id));
    expect(await linkOf(id)).toMatchObject({ lineStyle: 'dashed', arrow: 'end', color: null, label: null });
  });

  it('reverses a line, so its arrow points the other way, without making a second one', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const a = await makeNode('Core switch');
    const b = await makeNode('Edge firewall');
    const id = (await body(await postLink(
      request('POST', { fromNodeId: a, toNodeId: b, arrow: 'end' }), siteParams(),
    ))).linkId as string;

    expect((await patchLink(request('PATCH', { reverse: true }), linkParams(id))).status).toBe(200);
    expect(await linkOf(id)).toMatchObject({ fromNodeId: b, toNodeId: a, arrow: 'end' });
    const graph = await body(await getTopology(request('GET'), siteParams()));
    expect(graph.links as unknown[]).toHaveLength(1);
  });

  it('refuses a style, arrow or colour it does not know', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const a = await makeNode('Core switch');
    const b = await makeNode('Edge firewall');
    const id = (await body(await postLink(request('POST', { fromNodeId: a, toNodeId: b }), siteParams()))).linkId as string;

    expect((await patchLink(request('PATCH', { lineStyle: 'wavy' }), linkParams(id))).status).toBe(400);
    expect((await patchLink(request('PATCH', { arrow: 'sideways' }), linkParams(id))).status).toBe(400);
    expect((await patchLink(request('PATCH', { color: '#ff0000' }), linkParams(id))).status).toBe(400);
    expect((await patchNode(request('PATCH', { color: 'red; background:url(x)' }), nodeParams(a))).status).toBe(400);
    // And the database says the same to anything that skips the route.
    const sql = superuserSql();
    try {
      await expect(sql`UPDATE topology_link SET color = 'teal' WHERE id = ${id}::uuid`).rejects.toThrow();
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('colours a box, and a drag leaves the colour alone', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const id = await makeNode('Core switch', { color: 'blue' });
    await patchNode(request('PATCH', { posX: 20, posY: 40 }), nodeParams(id));
    let nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    expect(nodes[0]).toMatchObject({ color: 'blue', posX: 20 });

    await patchNode(request('PATCH', { color: null }), nodeParams(id));
    nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    expect(nodes[0]).toMatchObject({ color: null });
  });

  it('remembers the canvas size somebody dragged it to, and forgets it on reset', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await patchDiagram(request('PATCH', { canvasWidth: 1800, canvasHeight: 900 }), siteParams())).status).toBe(200);
    let diagram = (await body(await getTopology(request('GET'), siteParams()))).diagram as Record<string, unknown>;
    expect(diagram).toMatchObject({ canvasWidth: 1800, canvasHeight: 900, name: 'Acme LAN' });

    expect((await patchDiagram(request('PATCH', { canvasWidth: 50 }), siteParams())).status).toBe(400);

    await patchDiagram(request('PATCH', { canvasWidth: null, canvasHeight: null }), siteParams());
    diagram = (await body(await getTopology(request('GET'), siteParams()))).diagram as Record<string, unknown>;
    expect(diagram).toMatchObject({ canvasWidth: null, canvasHeight: null });
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

// ---------------------------------------------------------------------------
describe('a box that stands for a configuration', () => {
  const nodesOf = async (diagramId: string = NET) =>
    (await body(await getTopology(request('GET'), siteParams(diagramId)))).nodes as Record<string, unknown>[];
  const su = async (fn: (sql: ReturnType<typeof superuserSql>) => Promise<unknown>) => {
    const sql = superuserSql();
    try { await fn(sql); } finally { await sql.end({ timeout: 5 }); }
  };

  it('offers this client’s configurations, and no other client’s', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const graph = await body(await getTopology(request('GET'), siteParams()));
    const names = (graph.configurations as { name: string; shape: string }[]).map((c) => c.name);
    expect(names).toContain('acme-fw-01');
    expect(names).not.toContain('globex-app-01');
    const firewall = (graph.configurations as { name: string; shape: string }[]).find((c) => c.name === 'acme-fw-01');
    expect(firewall?.shape, 'drawn with the shape its device type suggests').toBe('firewall');
  });

  it('shows the configuration’s current name and IP, and opens it', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await makeNode('acme-fw-01', { assetNodeId: IDS.firewall, deviceType: 'firewall' });
    await su((sql) => sql`
      UPDATE asset_node SET name = 'acme-fw-renamed' WHERE id = ${IDS.firewall}::uuid`);
    await su((sql) => sql`
      UPDATE device SET primary_ip = '10.9.9.1' WHERE id = ${IDS.firewall}::uuid`);
    try {
      const [box] = await nodesOf();
      expect(box).toMatchObject({ assetNodeId: IDS.firewall, label: 'acme-fw-renamed', ipAddress: '10.9.9.1' });
    } finally {
      await su((sql) => sql`
        UPDATE asset_node SET name = 'acme-fw-01' WHERE id = ${IDS.firewall}::uuid`);
      await su((sql) => sql`UPDATE device SET primary_ip = NULL WHERE id = ${IDS.firewall}::uuid`);
    }
  });

  it('refuses another client’s configuration on this diagram', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await postNode(
      request('POST', { label: 'globex-app-01', assetNodeId: IDS.globexServer }), siteParams());
    expect(response.status).toBe(400);
  });

  it('belongs to a diagram, and an entry’s id is not one', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await getTopology(request('GET'), siteParams(IDS.firewall))).status).toBe(404);
    expect((await postNode(request('POST', { label: 'Misplaced' }), siteParams(IDS.firewall))).status).toBe(404);
  });

  it('says "restricted" to a reader who may not see the configuration', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await makeNode('acme-dc01', { assetNodeId: IDS.domainController });
    await su((sql) => sql`
      UPDATE asset_node SET is_internal_only = true WHERE id = ${IDS.domainController}::uuid`);
    try {
      asUser(IDS.acmeViewer, 'viewer@acme.test');
      const [box] = await nodesOf();
      expect(box).toMatchObject({ label: 'Restricted entry', assetNodeId: null, ipAddress: null });
    } finally {
      await su((sql) => sql`
        UPDATE asset_node SET is_internal_only = false WHERE id = ${IDS.domainController}::uuid`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('a diagram as a record of its own (0880)', () => {
  const post = (payload: Record<string, unknown>) =>
    postDiagram(new NextRequest(new Request('https://helm.test/api/diagrams', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })));
  const diagramParams = (diagramId: string) => ({ params: Promise.resolve({ diagramId }) });

  it('is started for a client, drawn on, renamed, archived, restored and deleted', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await post({ organizationId: IDS.orgAcme, name: 'Head office', networkId: IDS.network });
    expect(created.status).toBe(200);
    const id = ((await body(created)).diagram as { id: string }).id;

    await makeNode('Core switch', {}, id);
    expect((await patchDiagram(request('PATCH', { name: 'Head office LAN' }), diagramParams(id))).status).toBe(200);
    const graph = await body(await getTopology(request('GET'), siteParams(id)));
    expect(graph.diagram).toMatchObject({ name: 'Head office LAN' });
    expect(graph.nodes as unknown[]).toHaveLength(1);

    // Archive first, then delete.
    expect((await deleteDiagram(request('DELETE'), diagramParams(id))).status).toBe(409);
    expect((await patchDiagram(request('PATCH', { archived: true }), diagramParams(id))).status).toBe(200);
    expect((await patchDiagram(request('PATCH', { archived: false }), diagramParams(id))).status).toBe(200);
    expect((await patchDiagram(request('PATCH', { archived: true }), diagramParams(id))).status).toBe(200);
    expect((await deleteDiagram(request('DELETE'), diagramParams(id))).status).toBe(200);
    expect((await getTopology(request('GET'), siteParams(id))).status).toBe(404);
  });

  it('refuses another client’s network or location', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await post({ organizationId: IDS.orgGlobex, name: 'Borrowed', networkId: IDS.network })).status).toBe(400);
    expect((await post({ organizationId: IDS.orgAcme, name: 'Of a firewall', networkId: IDS.firewall })).status).toBe(400);
  });

  it('is not started by a client administrator, whom the database refuses', async () => {
    asUser(IDS.acmeAdmin, 'admin@acme.test');
    expect((await post({ organizationId: IDS.orgAcme, name: 'Client diagram' })).status).toBe(403);
  });

  it('hides an internal-only diagram, boxes and all, from the client’s own users', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await makeNode('Core switch');
    await patchDiagram(request('PATCH', { isInternalOnly: true }), diagramParams(NET));
    try {
      asUser(IDS.acmeViewer, 'viewer@acme.test');
      expect((await getTopology(request('GET'), siteParams(NET))).status).toBe(404);
    } finally {
      asUser(IDS.admin1, 'admin@northwind.test');
      await patchDiagram(request('PATCH', { isInternalOnly: false }), diagramParams(NET));
    }
  });
});
