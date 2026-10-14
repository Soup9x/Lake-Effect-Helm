/**
 * The coverage grid against a real database.
 *
 * THREE THINGS THAT ONLY A REAL DATABASE CAN ANSWER:
 *
 *   1. A flexible record's client lives on asset_node, not on the record, so
 *      the join is how a `flexible_asset` node learns which of the tenant's
 *      types it is. Get it wrong and every tenant-defined column reads zero
 *      while the records plainly exist.
 *   2. RLS scopes the rows AND the columns. A client-side role sees one
 *      organisation; the column list comes from flexible_asset_type, which is
 *      tenant-scoped and not organisation-scoped, so the two are filtered by
 *      different policies and have to be checked separately.
 *   3. Archived assets do not count. An archive that still shows up in a
 *      coverage number is an archive that does not mean anything.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import { actor, connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { readCoverageGrid, listGridColumns } from '../../src/lib/coverage/queries';
import { coverageOf, gapsOf } from '../../src/lib/coverage/grid';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const admin = actor(IDS.tenant1, IDS.admin1);
const clientAdmin = actor(IDS.tenant1, IDS.acmeAdmin);
const rival = actor(IDS.tenant2, IDS.admin2);

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
}, 120_000);
afterAll(async () => { await disconnectPools(); });
afterEach(async () => {
  await su((sql) => sql`UPDATE asset_node SET archived_at = NULL`);
});

/**
 * Put a probe type beyond the grid's reach, WITHOUT deleting it.
 *
 * A published type cannot be deleted by anybody: flexible_asset_type_version
 * carries helm.deny_mutation() on UPDATE and DELETE, and a cascade fires row
 * triggers, so `DELETE FROM flexible_asset_type` comes back with "DELETE on
 * flexible_asset_type_version is not permitted" even as the superuser. 0520's
 * header names that table as one it deliberately left unexempted, and F1 hit
 * exactly the same wall on sop_version.
 *
 * Deactivating is both the only option and the honest one — it is what a tenant
 * retiring a type actually does — and the grid excludes inactive types, which
 * is itself asserted below.
 */
async function retire(sql: ReturnType<typeof superuserSql>, typeId: string): Promise<void> {
  await sql`
    UPDATE flexible_asset_type
    SET is_active = false, key = 'retired_' || key, name = 'Retired ' || name
    WHERE id = ${typeId}::uuid
  `;
}

const rowFor = (grid: Awaited<ReturnType<typeof readCoverageGrid>>, name: string) =>
  grid.rows.find((row) => row.organizationName === name);

describe('the grid', () => {
  it('counts the fixture"s assets per client and kind', async () => {
    const grid = await withTenant(admin, (tx) => readCoverageGrid(tx));

    const acme = rowFor(grid, 'Acme Manufacturing');
    expect(acme, 'Acme should be on the first page').toBeTruthy();
    // The fixture gives Acme two devices, a network, an application, a domain,
    // a certificate and two procedures.
    expect(acme!.counts.device).toBe(2);
    expect(acme!.counts.network).toBe(1);
    expect(acme!.counts.domain).toBe(1);
    expect(acme!.counts.ssl_certificate).toBe(1);
    expect(acme!.counts.sop).toBe(2);
    expect(acme!.counts.ip_address, 'nothing documents an IP address yet').toBeUndefined();

    const globex = rowFor(grid, 'Globex Corporation');
    expect(globex!.counts.device).toBe(1);
    expect(globex!.counts.domain, 'Globex has no domain documented').toBeUndefined();
  });

  it('puts the MSP"s own organisation first, then clients by name', async () => {
    /*
     * Internal first because it is the row somebody scrolls past, not the row
     * they came for — and alphabetical would bury it between two clients.
     *
     * THE EXTRA CLIENT IS WHAT MAKES THIS A TEST. The fixture inserts
     * internal, Acme, Globex, which is already the order this asserts — so
     * with only those three the assertion passes on heap order alone and
     * deleting the ORDER BY changes nothing. Found by sabotage. "AAA" sorts
     * first and is inserted last, so insert order and expected order now
     * disagree and only an ORDER BY can produce the right answer.
     */
    const extra = await su(async (sql) => {
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO organization (tenant_id, slug, name)
        VALUES (${IDS.tenant1}::uuid, 'aaa-early', 'AAA Early Client')
        RETURNING id
      `;
      return org!.id;
    });

    try {
      const grid = await withTenant(admin, (tx) => readCoverageGrid(tx));
      expect(grid.rows[0]!.isMspInternal, 'the MSP"s own row should lead').toBe(true);
      expect(grid.rows.map((row) => row.organizationName)).toEqual([
        'Northwind (Internal)',
        'AAA Early Client',
        'Acme Manufacturing',
        'Globex Corporation',
      ]);
    } finally {
      await su((sql) => sql`DELETE FROM organization WHERE id = ${extra}::uuid`);
    }
  });

  it('leaves a soft-deleted client out of the rows and the total', async () => {
    /*
     * organization_rls_select is `tenant_id = … AND org_in_scope(id)` and says
     * nothing about deleted_at, so the predicate in this query is the ONLY
     * thing keeping a deleted client off the grid — unlike the membership
     * check in F2, where RLS was doing the work. Found by sabotage: dropping
     * it broke no test, because the fixture has nothing soft-deleted.
     */
    const before = await withTenant(admin, (tx) => readCoverageGrid(tx));
    expect(before.clients).toBe(3);

    await su((sql) => sql`
      UPDATE organization SET deleted_at = now() WHERE id = ${IDS.orgGlobex}::uuid
    `);

    try {
      const after = await withTenant(admin, (tx) => readCoverageGrid(tx));
      expect(after.rows.map((row) => row.organizationName),
        'a deleted client is still on the grid').not.toContain('Globex Corporation');
      expect(after.clients,
        'the total still counts a deleted client, so the pager over-counts').toBe(2);
    } finally {
      await su((sql) => sql`
        UPDATE organization SET deleted_at = NULL WHERE id = ${IDS.orgGlobex}::uuid
      `);
    }
  });

  it('offers a column for every node category and every published type', async () => {
    const columns = await withTenant(admin, (tx) => listGridColumns(tx));
    const keys = columns.map((column) => column.key);

    expect(keys, 'the node categories should all be columns').toEqual(
      expect.arrayContaining(['device', 'network', 'domain', 'credential', 'sop']),
    );
    expect(columns.find((column) => column.key === 'domain')?.label,
      'the column should be named as the sidebar names it').toBe('Domain Tracker');
    expect(keys.some((key) => key.startsWith('flex:')),
      'the fixture has no published flexible type, so there should be no flex column')
      .toBe(false);
  });

  it('counts a flexible record under its own type, not as a generic node', async () => {
    /*
     * The join that makes the tenant's own columns work. A flexible_asset node
     * carries node_type 'flexible_asset'; which TYPE it is lives on
     * flexible_asset_record. If the grid grouped on node_type alone, every
     * tenant-defined column would read zero with the records sitting right
     * there.
     */
    const typeId = await su(async (sql) => {
      const [type] = await sql<{ id: string }[]>`
        INSERT INTO flexible_asset_type (tenant_id, key, name, created_by)
        VALUES (${IDS.tenant1}::uuid, 'coverage_probe', 'Coverage Probe',
                ${IDS.admin1}::uuid)
        RETURNING id
      `;
      const [version] = await sql<{ id: string }[]>`
        INSERT INTO flexible_asset_type_version (
          tenant_id, type_id, version, status, json_schema, published_at, created_by
        )
        VALUES (
          ${IDS.tenant1}::uuid, ${type!.id}::uuid, 1, 'published',
          '{"type":"object","properties":{"a":{"type":"string"}}}'::jsonb,
          now(), ${IDS.admin1}::uuid
        )
        RETURNING id
      `;
      await sql`
        UPDATE flexible_asset_type SET current_version_id = ${version!.id}::uuid
        WHERE id = ${type!.id}::uuid
      `;
      for (const name of ['probe one', 'probe two']) {
        const [node] = await sql<{ id: string }[]>`
          INSERT INTO asset_node (tenant_id, organization_id, node_type, name)
          VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'flexible_asset', ${name})
          RETURNING id
        `;
        await sql`
          INSERT INTO flexible_asset_record (
            id, tenant_id, node_type, type_id, type_version_id, data
          )
          VALUES (
            ${node!.id}::uuid, ${IDS.tenant1}::uuid, 'flexible_asset',
            ${type!.id}::uuid, ${version!.id}::uuid, '{"a":"x"}'::jsonb
          )
        `;
      }
      return type!.id;
    });

    try {
      const grid = await withTenant(admin, (tx) => readCoverageGrid(tx));
      const column = grid.columns.find((c) => c.key === `flex:${typeId}`);
      expect(column, 'the published type should be a column').toBeTruthy();
      expect(column!.label).toBe('Coverage Probe');

      const acme = rowFor(grid, 'Acme Manufacturing');
      expect(acme!.counts[`flex:${typeId}`],
        'the two records should be counted under their own type').toBe(2);
      expect(acme!.counts.flexible_asset,
        'and not under the generic node type').toBeUndefined();

      // Globex has none of them, so the column is its gap.
      const globex = rowFor(grid, 'Globex Corporation');
      expect(gapsOf(globex!, grid.columns).map((gap) => gap.key))
        .toContain(`flex:${typeId}`);
    } finally {
      await su(async (sql) => {
        await sql`DELETE FROM asset_node WHERE name LIKE 'probe %'`;
        await retire(sql, typeId);
      });
    }
  });

  it('stops counting an asset once it is archived', async () => {
    const before = await withTenant(admin, (tx) => readCoverageGrid(tx));
    expect(rowFor(before, 'Globex Corporation')!.counts.device).toBe(1);

    await su((sql) => sql`
      UPDATE asset_node SET archived_at = now() WHERE id = ${IDS.globexServer}::uuid
    `);

    const after = await withTenant(admin, (tx) => readCoverageGrid(tx));
    expect(rowFor(after, 'Globex Corporation')!.counts.device,
      'an archived asset is still being counted as coverage').toBeUndefined();
    expect(gapsOf(rowFor(after, 'Globex Corporation')!, after.columns).map((g) => g.key))
      .toContain('device');
  });

  it('agrees with coverageOf about the rows it returns', async () => {
    // The page computes the badge from the row; this is the one place both the
    // query and the arithmetic can be checked against each other.
    const grid = await withTenant(admin, (tx) => readCoverageGrid(tx));
    const acme = rowFor(grid, 'Acme Manufacturing')!;
    const coverage = coverageOf(acme, grid.columns);

    expect(coverage.total).toBe(grid.columns.length);
    expect(coverage.covered).toBe(
      grid.columns.filter((column) => (acme.counts[column.key] ?? 0) > 0).length,
    );
    expect(coverage.covered).toBeGreaterThan(0);
    expect(coverage.covered).toBeLessThan(coverage.total);
  });
});

describe('pages', () => {
  it('returns the client total so a pager can exist, not just this page', async () => {
    const grid = await withTenant(admin, (tx) => readCoverageGrid(tx, { pageSize: 2 }));
    expect(grid.rows).toHaveLength(2);
    expect(grid.clients, 'the total must count every client, not the page').toBe(3);
    expect(grid.page).toBe(1);
    expect(grid.pageSize).toBe(2);
  });

  it('does not repeat or skip a client across pages', async () => {
    /*
     * The ordering is (is_msp_internal DESC, name), which is stable — and it
     * has to be, because LIMIT/OFFSET over an unstable order silently shows
     * one client twice and another not at all. Asserted by walking every page
     * and comparing with the unpaginated read.
     */
    const all = await withTenant(admin, (tx) => readCoverageGrid(tx));
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const slice = await withTenant(admin, (tx) => readCoverageGrid(tx, { page, pageSize: 1 }));
      expect(slice.rows).toHaveLength(1);
      seen.push(slice.rows[0]!.organizationName);
    }
    expect(seen).toEqual(all.rows.map((row) => row.organizationName));
    expect(new Set(seen).size, 'a client appeared on two pages').toBe(3);
  });

  it('is empty past the end rather than an error', async () => {
    const grid = await withTenant(admin, (tx) => readCoverageGrid(tx, { page: 99 }));
    expect(grid.rows).toEqual([]);
    expect(grid.clients, 'the total still comes back, so the pager can send them home').toBe(3);
    // The columns still come back too: an empty page is not a broken page.
    expect(grid.columns.length).toBeGreaterThan(0);
  });

  it('treats page 0 and negative pages as the first page', async () => {
    for (const page of [0, -5]) {
      const grid = await withTenant(admin, (tx) => readCoverageGrid(tx, { page, pageSize: 1 }));
      expect(grid.page, `page ${page} should clamp to 1`).toBe(1);
      expect(grid.rows[0]!.isMspInternal).toBe(true);
    }
  });
});

describe('who sees what', () => {
  it('shows a client-side role only their own organisation', async () => {
    const grid = await withTenant(clientAdmin, (tx) => readCoverageGrid(tx));
    expect(grid.rows.map((row) => row.organizationName)).toEqual(['Acme Manufacturing']);
    expect(grid.clients, 'the total must be RLS-scoped too, or the pager lies').toBe(1);
  });

  it('shows another tenant nothing of this one"s", rows or columns', async () => {
    /*
     * Rows and columns are filtered by DIFFERENT policies — organization is
     * organisation-scoped, flexible_asset_type is tenant-scoped — so one being
     * right says nothing about the other.
     */
    const typeId = await su(async (sql) => {
      const [type] = await sql<{ id: string }[]>`
        INSERT INTO flexible_asset_type (tenant_id, key, name, created_by)
        VALUES (${IDS.tenant1}::uuid, 'tenant_probe', 'Tenant Probe', ${IDS.admin1}::uuid)
        RETURNING id
      `;
      const [version] = await sql<{ id: string }[]>`
        INSERT INTO flexible_asset_type_version (
          tenant_id, type_id, version, status, json_schema, published_at, created_by
        )
        VALUES (${IDS.tenant1}::uuid, ${type!.id}::uuid, 1, 'published',
                '{"type":"object"}'::jsonb, now(), ${IDS.admin1}::uuid)
        RETURNING id
      `;
      await sql`
        UPDATE flexible_asset_type SET current_version_id = ${version!.id}::uuid
        WHERE id = ${type!.id}::uuid
      `;
      return type!.id;
    });

    try {
      const ours = await withTenant(admin, (tx) => readCoverageGrid(tx));
      expect(ours.columns.map((c) => c.key)).toContain(`flex:${typeId}`);

      const theirs = await withTenant(rival, (tx) => readCoverageGrid(tx));
      expect(theirs.rows.map((row) => row.organizationName)).toEqual(['Contoso Ltd']);
      expect(theirs.columns.map((c) => c.key),
        'another tenant"s documentation type became a column')
        .not.toContain(`flex:${typeId}`);
      expect(theirs.rows[0]!.counts.device,
        'the rival should see their own asset, and only theirs').toBe(1);
    } finally {
      await su((sql) => retire(sql, typeId));
    }
  });

  it('leaves an unpublished type out of the columns', async () => {
    // A type nobody can create records of is not a gap — it is a draft. C's
    // authoring screen can leave one sitting for a while.
    const typeId = await su(async (sql) => {
      const [type] = await sql<{ id: string }[]>`
        INSERT INTO flexible_asset_type (tenant_id, key, name, created_by)
        VALUES (${IDS.tenant1}::uuid, 'draft_probe', 'Draft Probe', ${IDS.admin1}::uuid)
        RETURNING id
      `;
      return type!.id;
    });
    try {
      const grid = await withTenant(admin, (tx) => readCoverageGrid(tx));
      expect(grid.columns.map((c) => c.key),
        'a type with no published version should not count against anybody')
        .not.toContain(`flex:${typeId}`);
    } finally {
      await su((sql) => retire(sql, typeId));
    }
  });

  it('leaves a deactivated type out too', async () => {
    const typeId = await su(async (sql) => {
      const [type] = await sql<{ id: string }[]>`
        INSERT INTO flexible_asset_type (tenant_id, key, name, created_by, is_active)
        VALUES (${IDS.tenant1}::uuid, 'retired_probe', 'Retired Probe',
                ${IDS.admin1}::uuid, false)
        RETURNING id
      `;
      const [version] = await sql<{ id: string }[]>`
        INSERT INTO flexible_asset_type_version (
          tenant_id, type_id, version, status, json_schema, published_at, created_by
        )
        VALUES (${IDS.tenant1}::uuid, ${type!.id}::uuid, 1, 'published',
                '{"type":"object"}'::jsonb, now(), ${IDS.admin1}::uuid)
        RETURNING id
      `;
      await sql`
        UPDATE flexible_asset_type SET current_version_id = ${version!.id}::uuid
        WHERE id = ${type!.id}::uuid
      `;
      return type!.id;
    });
    try {
      const grid = await withTenant(admin, (tx) => readCoverageGrid(tx));
      expect(grid.columns.map((c) => c.key),
        'a retired type should stop being measured, not start reading zero')
        .not.toContain(`flex:${typeId}`);
    } finally {
      await su((sql) => retire(sql, typeId));
    }
  });
});
