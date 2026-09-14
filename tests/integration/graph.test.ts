import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_RELATIONS,
  canonicalise,
  INVERSE_RELATION,
  isSymmetric,
  type LinkRelation,
} from '../../src/lib/graph/relations';
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
const clientAdmin = actor(IDS.tenant1, IDS.acmeAdmin);

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
}, 120_000);

afterAll(async () => {
  await disconnectPools();
});

describe('relation vocabulary stays in sync with the database', () => {
  it('every enum value in the database has a TypeScript inverse', async () => {
    const sql = superuserSql();
    try {
      const rows = await sql<{ label: string }[]>`
        SELECT e.enumlabel AS label
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'link_relation'
      `;
      const dbRelations = rows.map((r) => r.label).sort();
      expect(dbRelations).toEqual([...ALL_RELATIONS].sort());
    } finally {
      await sql.end();
    }
  });

  it('the TypeScript inverse map matches helm.inverse_relation() exactly', async () => {
    // These two definitions are duplicated by necessity — SQL needs it for the
    // bi-directional view, TypeScript for canonicalisation. A divergence would
    // store edges in a direction the view inverts differently, and the only
    // symptom would be an arrow quietly missing from a dependency map.
    const sql = superuserSql();
    try {
      const rows = await sql<{ label: string; inverse: string }[]>`
        SELECT e.enumlabel AS label,
               helm.inverse_relation(e.enumlabel::link_relation)::text AS inverse
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'link_relation'
      `;
      for (const row of rows) {
        expect(INVERSE_RELATION[row.label as LinkRelation]).toBe(row.inverse);
      }
    } finally {
      await sql.end();
    }
  });

  it('inverting twice is the identity', () => {
    for (const relation of ALL_RELATIONS) {
      expect(INVERSE_RELATION[INVERSE_RELATION[relation]]).toBe(relation);
    }
  });
});

describe('canonicalisation', () => {
  const low = '00000000-0000-0000-0000-00000000000a';
  const high = '00000000-0000-0000-0000-00000000000b';

  it('leaves an already-ordered edge alone', () => {
    expect(canonicalise(low, 'depends_on', high)).toEqual({
      sourceNodeId: low,
      targetNodeId: high,
      relation: 'depends_on',
      flipped: false,
    });
  });

  it('flips the pair and inverts the relation when out of order', () => {
    expect(canonicalise(high, 'supports', low)).toEqual({
      sourceNodeId: low,
      targetNodeId: high,
      relation: 'depends_on',
      flipped: true,
    });
  });

  it('maps both spellings of one fact onto identical rows', () => {
    // "A depends_on B" and "B supports A" are the same statement.
    const a = canonicalise(low, 'depends_on', high);
    const b = canonicalise(high, 'supports', low);
    expect({ ...a, flipped: false }).toEqual({ ...b, flipped: false });
  });

  it('collapses both directions of a symmetric relation', () => {
    const a = canonicalise(low, 'connects_to', high);
    const b = canonicalise(high, 'connects_to', low);
    expect(a.sourceNodeId).toBe(b.sourceNodeId);
    expect(a.targetNodeId).toBe(b.targetNodeId);
    expect(a.relation).toBe(b.relation);
  });

  it('refuses a self-link', () => {
    expect(() => canonicalise(low, 'depends_on', low)).toThrow(/itself/);
  });

  it('identifies the symmetric relations', () => {
    expect(isSymmetric('connects_to')).toBe(true);
    expect(isSymmetric('related_to')).toBe(true);
    expect(isSymmetric('depends_on')).toBe(false);
  });
});

describe('linking', () => {
  it('creates an edge and audits it', async () => {
    const result = await h.links.link(admin, {
      sourceNodeId: IDS.firewall,
      relation: 'secures',
      targetNodeId: IDS.network,
    });
    expect(result.created).toBe(true);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ action: string }[]>`
        SELECT action FROM audit_log
        WHERE entity_id = ${result.linkId}::uuid AND action = 'asset.linked'
      `;
      expect(row?.action).toBe('asset.linked');
    } finally {
      await sql.end();
    }
  });

  it('is idempotent on an exact repeat', async () => {
    const again = await h.links.link(admin, {
      sourceNodeId: IDS.firewall,
      relation: 'secures',
      targetNodeId: IDS.network,
    });
    expect(again.created).toBe(false);
  });

  it('refuses to create a second row for the inverse of an existing edge', async () => {
    // Without canonicalisation this would insert a distinct row, and the
    // dependency map would then show the relationship twice.
    const inverse = await h.links.link(admin, {
      sourceNodeId: IDS.network,
      relation: 'secured_by',
      targetNodeId: IDS.firewall,
    });
    expect(inverse.created).toBe(false);

    const sql = superuserSql();
    try {
      const rows = await sql`
        SELECT id FROM asset_link
        WHERE (source_node_id, target_node_id) IN (
          (${IDS.firewall}::uuid, ${IDS.network}::uuid),
          (${IDS.network}::uuid, ${IDS.firewall}::uuid)
        )
      `;
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it('stores one row for either direction of a symmetric relation', async () => {
    await h.links.link(admin, {
      sourceNodeId: IDS.domainController,
      relation: 'connects_to',
      targetNodeId: IDS.firewall,
    });
    const reverse = await h.links.link(admin, {
      sourceNodeId: IDS.firewall,
      relation: 'connects_to',
      targetNodeId: IDS.domainController,
    });
    expect(reverse.created).toBe(false);
  });

  it('reports when an edge was stored in the opposite direction', async () => {
    const result = await h.links.link(admin, {
      sourceNodeId: IDS.network,
      relation: 'secured_by',
      targetNodeId: IDS.firewall,
    });
    // IDs order firewall < network, so this request was flipped to canonical.
    expect(result.canonicalised).toBe(true);
  });

  it('refuses a self-link at the database too', async () => {
    await expect(
      h.links.link(admin, {
        sourceNodeId: IDS.firewall,
        relation: 'connects_to',
        targetNodeId: IDS.firewall,
      }),
    ).rejects.toThrow();
  });

  it('unlinks given either direction', async () => {
    await h.links.link(admin, {
      sourceNodeId: IDS.crmApp,
      relation: 'depends_on',
      targetNodeId: IDS.domainController,
    });

    // Ask to remove it the other way round; canonicalisation finds the row.
    const removed = await h.links.unlink(
      admin,
      IDS.domainController,
      'supports',
      IDS.crmApp,
    );
    expect(removed).toBe(true);

    const again = await h.links.unlink(admin, IDS.crmApp, 'depends_on', IDS.domainController);
    expect(again).toBe(false);
  });
});

describe('bi-directional reads', () => {
  it('shows an explicit edge in both directions with the relation inverted', async () => {
    const fromFirewall = await h.links.edges(admin, IDS.firewall);
    expect(fromFirewall).toContainEqual(
      expect.objectContaining({ toNodeId: IDS.network, relation: 'secures' }),
    );

    const fromNetwork = await h.links.edges(admin, IDS.network);
    expect(fromNetwork).toContainEqual(
      expect.objectContaining({ toNodeId: IDS.firewall, relation: 'secured_by' }),
    );
  });

  it('includes intrinsic edges that no asset_link row backs', async () => {
    // device.primary_network_id, projected rather than duplicated.
    const edges = await h.links.edges(admin, IDS.firewall);
    const intrinsic = edges.find((e) => e.relation === 'member_of' && e.toNodeId === IDS.network);
    expect(intrinsic).toBeDefined();
    expect(intrinsic?.origin).toBe('intrinsic');
    expect(intrinsic?.linkId).toBeNull();

    // And the inverse side.
    const reverse = await h.links.edges(admin, IDS.network);
    expect(reverse).toContainEqual(
      expect.objectContaining({ toNodeId: IDS.firewall, relation: 'contains' }),
    );
  });

  it('projects an application host relationship from its foreign key', async () => {
    const edges = await h.links.edges(admin, IDS.crmApp);
    expect(edges).toContainEqual(
      expect.objectContaining({
        toNodeId: IDS.domainController,
        relation: 'hosted_on',
        origin: 'intrinsic',
      }),
    );
  });

  it('labels neighbours for display', async () => {
    const neighbours = await h.links.neighbours(admin, IDS.network);
    const names = neighbours.map((n) => n.toName);
    expect(names).toContain('acme-fw-01');
    expect(names).toContain('ACME-DC01');
  });

  it('filters by relation', async () => {
    const secured = await h.links.neighbours(admin, IDS.network, { relations: ['contains'] });
    expect(secured.every((e) => e.relation === 'contains')).toBe(true);
    expect(secured.length).toBeGreaterThan(0);
  });
});

describe('traversal', () => {
  it('walks outward to a bounded depth', async () => {
    const reached = await h.links.walk(admin, IDS.network, { maxDepth: 2 });
    const ids = reached.map((n) => n.nodeId);
    expect(ids).toContain(IDS.network);
    expect(ids).toContain(IDS.firewall);
    expect(ids).toContain(IDS.domainController);
    expect(reached.every((n) => n.depth <= 2)).toBe(true);
  });

  it('terminates on a cyclic graph', async () => {
    // firewall and network are joined by two relations at once (an explicit
    // `secures` and an intrinsic `member_of`), so the graph is genuinely cyclic.
    const reached = await h.links.walk(admin, IDS.network, { maxDepth: 5 });
    expect(reached.length).toBeLessThan(100);

    // The cycle guard's property: no path ever revisits a node.
    for (const node of reached) {
      expect(new Set(node.path).size).toBe(node.path.length);
    }
  });

  it('returns each reachable node exactly once', async () => {
    // Regression: parallel relations between one pair used to expand the
    // frontier twice, duplicating every node downstream of them.
    const reached = await h.links.walk(admin, IDS.network, { maxDepth: 5 });
    const ids = reached.map((n) => n.nodeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports every relation that joins a pair, not just one', async () => {
    const reached = await h.links.walk(admin, IDS.network, { maxDepth: 1 });
    const firewall = reached.find((n) => n.nodeId === IDS.firewall);
    // The firewall is reached both because the network contains it and because
    // it secures the network.
    expect(firewall?.viaRelations).toEqual(
      expect.arrayContaining(['contains', 'secured_by']),
    );
  });

  it('returns the shortest route to a node reachable several ways', async () => {
    const reached = await h.links.walk(admin, IDS.network, { maxDepth: 5 });
    const crm = reached.find((n) => n.nodeId === IDS.crmApp);
    // network > domain controller > CRM, not the longer way round via the firewall.
    expect(crm?.depth).toBe(2);
  });

  it('answers what an application depends on', async () => {
    const deps = await h.links.dependenciesOf(admin, IDS.crmApp, 3);
    expect(deps.map((d) => d.nodeId)).toContain(IDS.domainController);
  });

  it('answers what breaks if a node fails, ordered by criticality', async () => {
    const impact = await h.links.impactOf(admin, IDS.domainController, 3);
    expect(impact.map((n) => n.nodeId)).toContain(IDS.crmApp);
    expect(impact.map((n) => n.nodeId)).not.toContain(IDS.domainController);

    for (let i = 1; i < impact.length; i += 1) {
      expect(impact[i - 1]!.criticality).toBeGreaterThanOrEqual(impact[i]!.criticality);
    }
  });

  it('stops at the organisation boundary rather than revealing what is beyond', async () => {
    // Globex is a different client in the same tenant. A client-scoped user
    // must not learn its assets exist by walking off the end of the graph.
    await h.links.link(admin, {
      sourceNodeId: IDS.firewall,
      relation: 'connects_to',
      targetNodeId: IDS.globexServer,
    });

    const asClient = await h.links.walk(clientAdmin, IDS.network, { maxDepth: 5 });
    expect(asClient.map((n) => n.nodeId)).not.toContain(IDS.globexServer);

    const asAdmin = await h.links.walk(admin, IDS.network, { maxDepth: 5 });
    expect(asAdmin.map((n) => n.nodeId)).toContain(IDS.globexServer);
  });

  it('hides an edge from a client user when only one endpoint is in scope', async () => {
    const edges = await h.links.edges(clientAdmin, IDS.firewall);
    expect(edges.map((e) => e.toNodeId)).not.toContain(IDS.globexServer);
  });
});

describe('cross-tenant linking is structurally impossible', () => {
  it('refuses to link across tenants', async () => {
    await expect(
      h.links.link(admin, {
        sourceNodeId: IDS.firewall,
        relation: 'connects_to',
        targetNodeId: IDS.contosoFirewall,
      }),
    ).rejects.toThrow();
  });
});
