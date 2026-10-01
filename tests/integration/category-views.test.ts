/**
 * The internal-only split, through the page's own query.
 *
 * The tabs this replaces said "Shared / Personal", which Helm cannot express:
 * there is no per-user ownership and no personal vault. is_internal_only is the
 * flag 0390 enforces through RLS, so these assert the thing that is actually
 * true — including, at the end, that it is enforced rather than merely filtered.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import type { SessionContextRequest } from '../../src/lib/db/context';
import {
  buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql, type Harness,
} from './harness';

let h: Harness;
const admin: SessionContextRequest = {
  tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user',
};
const clientAdmin: SessionContextRequest = {
  tenantId: IDS.tenant1, actorId: IDS.acmeAdmin, actorType: 'user',
};

/**
 * The same shape the category page builds, narrowed to this suite's own rows.
 *
 * The fixtures already document a network for Acme, so an assertion that the
 * whole list equals three names would be testing the fixtures rather than the
 * filter. The prefix is what makes these assertions about the thing under test.
 */
const PREFIX = 'ViewTest';

async function listNetworks(
  actor: SessionContextRequest,
  view: 'all' | 'shared' | 'internal',
  includeArchived = false,
): Promise<string[]> {
  return withTenant(actor, async (tx) => {
    const rows = await tx<{ name: string }[]>`
      SELECT n.name FROM asset_node n
      WHERE n.organization_id = ${IDS.orgAcme}::uuid
        AND n.node_type = 'network'::node_type
        AND n.name LIKE ${PREFIX + '%'}
        ${includeArchived ? tx`` : tx`AND n.archived_at IS NULL`}
        ${view === 'all' ? tx`` : tx`AND n.is_internal_only = ${view === 'internal'}`}
      ORDER BY n.name
    `;
    return rows.map((r) => r.name);
  });
}

/** The page's count query, which feeds both the tab badges and "X of Y". */
async function counts(
  actor: SessionContextRequest,
  includeArchived = false,
): Promise<{ n: number; shared: number; internal: number }> {
  return withTenant(actor, async (tx) => {
    const [row] = await tx<{ n: string; shared: string; internal: string }[]>`
      SELECT count(*)::text AS n,
             count(*) FILTER (WHERE NOT is_internal_only)::text AS shared,
             count(*) FILTER (WHERE is_internal_only)::text     AS internal
      FROM asset_node
      WHERE organization_id = ${IDS.orgAcme}::uuid
        AND node_type = 'network'::node_type
        AND name LIKE ${PREFIX + '%'}
        ${includeArchived ? tx`` : tx`AND archived_at IS NULL`}
    `;
    return {
      n: Number(row?.n ?? 0),
      shared: Number(row?.shared ?? 0),
      internal: Number(row?.internal ?? 0),
    };
  });
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'view tests' });

  const sql = superuserSql();
  try {
    await sql`
      INSERT INTO asset_node (tenant_id, organization_id, node_type, name, is_internal_only)
      VALUES
        (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'network', 'ViewTest Shared A', false),
        (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'network', 'ViewTest Shared B', false),
        (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'network', 'ViewTest Internal', true)
    `;
    // One archived row, so "X of Y" and the tab badges have something to get
    // wrong. Without it, counting every row and counting live rows agree.
    await sql`
      INSERT INTO asset_node
        (tenant_id, organization_id, node_type, name, is_internal_only, archived_at)
      VALUES
        (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'network',
         'ViewTest Shared Archived', false, now())
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}, 180_000);

afterAll(async () => { await disconnectPools(); });

describe('the view filter', () => {
  it('shows everything on All', async () => {
    expect(await listNetworks(admin, 'all')).toEqual([
      'ViewTest Internal', 'ViewTest Shared A', 'ViewTest Shared B',
    ]);
  });

  it('shows only what the client can see on Shared', async () => {
    expect(await listNetworks(admin, 'shared')).toEqual(['ViewTest Shared A', 'ViewTest Shared B']);
  });

  it('shows only what the client cannot see on Internal only', async () => {
    expect(await listNetworks(admin, 'internal')).toEqual(['ViewTest Internal']);
  });

  it('counts the two sides to what the tabs claim', async () => {
    expect(await counts(admin)).toEqual({ n: 3, shared: 2, internal: 1 });
  });

  /*
   * The readout is "X of Y", and the badge on each tab is a count. Both have to
   * be drawn from the same population as the list, or they contradict it: a
   * count that ignores archived_at reports "2 of 3" on a page showing
   * everything there is, and one that always excludes it reports "4 of 3" with
   * Include archived on. This pins the count to the list's own predicate.
   */
  it('counts the same rows the list shows, archived or not', async () => {
    for (const includeArchived of [false, true]) {
      const listed = await listNetworks(admin, 'all', includeArchived);
      const c = await counts(admin, includeArchived);
      expect(c.n).toBe(listed.length);
      expect(c.shared + c.internal).toBe(listed.length);

      for (const view of ['shared', 'internal'] as const) {
        const rows = await listNetworks(admin, view, includeArchived);
        expect(rows.length).toBe(view === 'internal' ? c.internal : c.shared);
      }
    }
  });

  it('is the archived row that makes those two populations differ', async () => {
    expect(await listNetworks(admin, 'all', false)).not.toContain('ViewTest Shared Archived');
    expect(await listNetworks(admin, 'all', true)).toContain('ViewTest Shared Archived');
    expect((await counts(admin, true)).n).toBe((await counts(admin, false)).n + 1);
  });

  /*
   * The one that matters. The tabs are a convenience for an MSP user who can
   * see both sides; the flag is a CONTROL, and a client-side role does not get
   * the internal row from any view — including the one that asks for it.
   */
  it('never hands an internal row to a client-side role, whichever view is asked for', async () => {
    expect(await listNetworks(clientAdmin, 'all')).toEqual(['ViewTest Shared A', 'ViewTest Shared B']);
    expect(await listNetworks(clientAdmin, 'internal')).toEqual([]);
  });
});
