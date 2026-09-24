/**
 * Per-site network topology: what it isolates, what it lets a person change,
 * and what a poll is forbidden from undoing.
 *
 * The last one is the reason this feature is interesting. A diagram whose boxes
 * re-arrange themselves every five minutes is worse than no diagram, so the
 * non-destructive contract is tested by actually moving a node, actually
 * running the real sync against a real stub controller, and looking at where
 * the node ended up — not by asserting that a function exists.
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
import { PUT as putMapping } from '../../src/app/api/network/mappings/route';
import { unifiSyncJob } from '../../src/workers/unifi-sync';
import { deviceTypeFor } from '../../src/lib/topology/sync';
import { FakeUnifi } from '../support/fake-unifi';
import type { JobContext, JobLogger } from '../../src/workers/runtime';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => { currentUser = { id, email }; };

// Fixed, for the same reason unifi.test.ts fixes it: one MAC must produce one
// index across two separate syncs or nothing can be matched twice.
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

const running: FakeUnifi[] = [];
async function runSync(): Promise<Record<string, number>> {
  const ctx: JobContext = { log: recordingLogger([]), stopping: () => false };
  return (await unifiSyncJob().run(ctx)).counts ?? {};
}

/** A switch and an access point uplinked to it — the smallest real topology. */
const SWITCH = {
  macAddress: 'aa:bb:cc:00:00:01',
  ipAddress: '10.4.0.2',
  name: 'acme-sw-core',
  model: 'USW-24-PoE',
  state: 'ONLINE',
};
const AP = {
  macAddress: 'aa:bb:cc:00:00:02',
  ipAddress: '10.4.0.30',
  name: 'acme-ap-lobby',
  model: 'U6-Pro',
  state: 'ONLINE',
  uplinkMac: 'aa:bb:cc:00:00:01',
  switchPort: 12,
};

/** A mapping pointed at a stub, active, due, and bound to SITE. */
async function boundMapping(c: FakeUnifi, siteId: string | null = SITE): Promise<string> {
  asUser(IDS.admin1, 'admin@northwind.test');
  const response = await putMapping(new NextRequest(
    new Request('https://helm.test/api/network/mappings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: IDS.orgAcme,
        name: 'ACME HQ controller',
        controllerUrl: c.url,
        unifiSiteId: 'site-1',
        isActive: false,
        pollIntervalSeconds: 300,
        apiKey: 'unifi-api-key-for-the-topology-suite',
      }),
    }),
  ));
  expect(response.status).toBe(200);
  const mappings = (await body(response)).mappings as { id: string; name: string }[];
  const id = mappings.find((m) => m.name === 'ACME HQ controller')!.id;

  const sql = superuserSql();
  try {
    await sql`
      UPDATE unifi_site_mapping
      SET is_active = true, tls_verify = false, tls_pinned_sha256 = ${c.sha256},
          tls_exception_ack_by = ${IDS.admin1}::uuid, tls_exception_ack_at = now(),
          next_poll_at = now() - interval '1 minute',
          site_id = ${siteId}::uuid
      WHERE id = ${id}::uuid
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
  return id;
}

async function wipe(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`DELETE FROM topology_link`;
    await sql`DELETE FROM topology_node`;
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
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'topology tests' });
  await h.keys.provision(IDS.tenant2, IDS.admin2, { reason: 'topology tests' });
  await seedSites();
}, 180_000);

afterEach(async () => {
  currentUser = null;
  await wipe();
  for (const c of running.splice(0)) await c.stop();
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
      ipAddress: '203.0.113.1', posX: 40, posY: 80, source: 'manual',
    });
    // A box nobody has edited yet: the markers only mean something after an edit.
    expect(nodes[0]!.customised).toEqual({
      label: false, deviceType: false, ipAddress: false, subnet: false,
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
    expect((await body(response)).wasSynced).toBe(false);

    const graph = await body(await getTopology(request('GET'), siteParams()));
    expect((graph.nodes as unknown[])).toHaveLength(2);
    expect((graph.links as unknown[])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('moving is not editing', () => {
  it('a drag raises no customisation marker', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const id = await makeNode('Core switch');

    expect((await patchNode(request('PATCH', { posX: 300, posY: 120 }), nodeParams(id))).status).toBe(200);

    const nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    expect(nodes[0]).toMatchObject({ posX: 300, posY: 120 });
    expect(nodes[0]!.customised).toEqual({
      label: false, deviceType: false, ipAddress: false, subnet: false,
    });
  });

  it('an edit raises the marker for that field and no other', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const id = await makeNode('Core switch');

    await patchNode(request('PATCH', { label: 'Core switch (rack 3)' }), nodeParams(id));

    const nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    expect(nodes[0]!.label).toBe('Core switch (rack 3)');
    expect(nodes[0]!.customised).toEqual({
      label: true, deviceType: false, ipAddress: false, subnet: false,
    });
  });

  it('clearing a field still counts as an edit', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const id = await makeNode('Core switch', { subnet: '10.0.0.0/24' });

    await patchNode(request('PATCH', { subnet: null }), nodeParams(id));

    const nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    expect(nodes[0]!.subnet).toBeNull();
    // "I do not want the controller's subnet here" is a decision, and a poll
    // that put it back would be overruling it.
    expect((nodes[0]!.customised as Record<string, boolean>).subnet).toBe(true);
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
describe('seeding from UniFi', () => {
  it('maps a model to an icon, and admits when it does not know', () => {
    expect(deviceTypeFor('USW-24-PoE', 'unifi_device')).toBe('switch');
    expect(deviceTypeFor('U6-Pro', 'unifi_device')).toBe('access_point');
    expect(deviceTypeFor('UDM-Pro', 'unifi_device')).toBe('firewall');
    expect(deviceTypeFor('UNVR', 'unifi_device')).toBe('server');
    expect(deviceTypeFor('something-else', 'unifi_device')).toBe('generic');
    // A client device is somebody's laptop, not infrastructure.
    expect(deviceTypeFor('USW-24-PoE', 'client_device')).toBe('generic');
  });

  it('seeds nodes and derives the uplink as a link', async () => {
    const c = await FakeUnifi.start({ devices: [SWITCH, AP] });
    running.push(c);
    await boundMapping(c);

    const counts = await runSync();
    expect(counts.polled).toBe(1);

    asUser(IDS.admin1, 'admin@northwind.test');
    const graph = await body(await getTopology(request('GET'), siteParams()));
    const nodes = graph.nodes as Record<string, unknown>[];
    const links = graph.links as Record<string, unknown>[];

    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.label).sort()).toEqual(['acme-ap-lobby', 'acme-sw-core']);
    expect(nodes.every((n) => n.source === 'unifi_sync')).toBe(true);
    // Nothing has been placed: the canvas lays these out on first load.
    expect(nodes.every((n) => n.posX === null && n.posY === null)).toBe(true);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ source: 'unifi_sync', label: 'Port 12' });

    const ap = nodes.find((n) => n.label === 'acme-ap-lobby')!;
    const sw = nodes.find((n) => n.label === 'acme-sw-core')!;
    expect(links[0]!.fromNodeId).toBe(ap.id);
    expect(links[0]!.toNodeId).toBe(sw.id);
    expect(ap.deviceType).toBe('access_point');
    expect(sw.deviceType).toBe('switch');
    expect(graph.unifiBound).toBe(true);
  }, 60_000);

  it('seeds nothing when the mapping names no site', async () => {
    const c = await FakeUnifi.start({ devices: [SWITCH, AP] });
    running.push(c);
    await boundMapping(c, null);

    await runSync();

    asUser(IDS.admin1, 'admin@northwind.test');
    const graph = await body(await getTopology(request('GET'), siteParams()));
    expect(graph.nodes).toEqual([]);
    expect(graph.unifiBound).toBe(false);
  }, 60_000);

  /**
   * THE ONE THAT MATTERS.
   *
   * Somebody arranges their diagram and renames a switch to match the label on
   * the rack. The controller keeps reporting its own name, its own IP, and a
   * model that says "switch". The next poll must leave the arrangement and the
   * name alone, and is still welcome to correct the IP nobody has touched.
   */
  it('never moves a node a person placed, or overwrites what they edited', async () => {
    const c = await FakeUnifi.start({ devices: [SWITCH, AP] });
    running.push(c);
    await boundMapping(c);
    await runSync();

    asUser(IDS.admin1, 'admin@northwind.test');
    let nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    const sw = nodes.find((n) => n.label === 'acme-sw-core')!;

    await patchNode(request('PATCH', { posX: 512, posY: 256 }), nodeParams(sw.id as string));
    await patchNode(request('PATCH', {
      label: 'Core switch — rack 3', deviceType: 'router',
    }), nodeParams(sw.id as string));

    // The controller now reports a different name, a different address and a
    // different model. Only the address may land.
    await c.stop();
    running.splice(running.indexOf(c), 1);
    const c2 = await FakeUnifi.start({
      devices: [
        { ...SWITCH, name: 'renamed-on-controller', ipAddress: '10.4.0.99', model: 'U6-Pro' },
        AP,
      ],
    });
    running.push(c2);

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

    await runSync();

    nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    const after = nodes.find((n) => n.id === sw.id)!;

    expect(after.posX).toBe(512);
    expect(after.posY).toBe(256);
    expect(after.label).toBe('Core switch — rack 3');
    expect(after.deviceType).toBe('router');
    // Never edited, so the controller is still the better source for it.
    expect(after.ipAddress).toBe('10.4.0.99');
  }, 90_000);

  it('brings a deleted node back while the controller still reports the device', async () => {
    const c = await FakeUnifi.start({ devices: [SWITCH, AP] });
    running.push(c);
    await boundMapping(c);
    await runSync();

    asUser(IDS.admin1, 'admin@northwind.test');
    let nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    const ap = nodes.find((n) => n.label === 'acme-ap-lobby')!;

    const deleted = await deleteNode(request('DELETE'), nodeParams(ap.id as string));
    expect((await body(deleted)).wasSynced).toBe(true);

    const sql = superuserSql();
    try {
      await sql`UPDATE unifi_site_mapping SET next_poll_at = now() - interval '1 minute'`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    await runSync();

    nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    // Back, because the device is still there. This is what the interface warns
    // about before the delete.
    expect(nodes.map((n) => n.label).sort()).toEqual(['acme-ap-lobby', 'acme-sw-core']);
  }, 90_000);

  it('leaves a deleted node gone once the device is off the controller', async () => {
    const c = await FakeUnifi.start({ devices: [SWITCH, AP] });
    running.push(c);
    await boundMapping(c);
    await runSync();

    asUser(IDS.admin1, 'admin@northwind.test');
    let nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    const ap = nodes.find((n) => n.label === 'acme-ap-lobby')!;
    await deleteNode(request('DELETE'), nodeParams(ap.id as string));

    // The access point is decommissioned: the controller stops listing it, so
    // finish_unifi_poll marks it offline and the seeder never sees it again.
    await c.stop();
    running.splice(running.indexOf(c), 1);
    const c2 = await FakeUnifi.start({ devices: [SWITCH] });
    running.push(c2);

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
    await runSync();

    nodes = (await body(await getTopology(request('GET'), siteParams()))).nodes as Record<string, unknown>[];
    expect(nodes.map((n) => n.label)).toEqual(['acme-sw-core']);
  }, 90_000);
});
