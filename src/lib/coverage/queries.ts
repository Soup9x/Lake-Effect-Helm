/**
 * The coverage grid, read in two queries and one page at a time.
 *
 * ONE PAGE AT A TIME IS A MEASURED DECISION, not caution. The grid is an
 * aggregate over asset_node, and under RLS that is expensive in a way the row
 * count alone does not predict. On a synthetic estate of 404 clients and 60,009
 * nodes:
 *
 *   the whole tenant, one grouped pass      430 ms
 *   the same aggregate as superuser          40 ms
 *   fifty clients, same query shape          79 ms
 *
 * The 10× between the first two is the policy predicate:
 * `helm.org_in_scope(organization_id)` and
 * `helm.internal_visible(is_internal_only)` are STABLE SQL functions carrying
 * `SET search_path`, and a SET clause makes a SQL function un-inlinable — so
 * each is a real function call, twice per row, 120,018 calls for one grid.
 * Verified directly: an identical two-line function with the SET clause plans
 * as `Filter: probe_with_set(organization_id)` and without it as
 * `Filter: (organization_id IS NOT NULL)`.
 *
 * That cost is the product's, not this grid's — every RLS-filtered aggregate
 * pays it, including the dashboard's counter strip — and it is written up in
 * docs/history/itg-parity.md rather than changed here, because removing a search_path
 * pin from a function every policy calls is a security decision and not one
 * this group gets to take. What this group can do is not ask for 404 clients
 * when it is showing 50, which is the difference between 430 ms and 79 ms and
 * is also just correct: the query matches the screen.
 *
 * TWO QUERIES, NOT ONE JOIN. The columns come from the taxonomy and the
 * tenant's own types; the counts come from the assets. Fetching them together
 * would mean a client with no records of a type contributing no row, and the
 * grid needs the column to exist anyway — an empty cell IS the finding here.
 */
import type { HelmTx } from '../db/client';
import { ORG_CATEGORIES } from '../nav/org-categories';
import type { GridColumn, GridRow } from './grid';

/** How many clients one page of the grid shows. */
const GRID_PAGE_SIZE = 50;

/**
 * The grid's columns: Helm's own node types, then the tenant's.
 *
 * DRIVEN OFF ORG_CATEGORIES so the grid names things exactly as the sidebar
 * does — "SSL Tracker", not "Ssl certificate" — and so a category added there
 * appears here without a second list to remember. `documents`, `contacts` and
 * `locations` are dropped because they are not asset_node rows and this
 * aggregate counts nodes; they are real documentation and a later pass could
 * add them from their own tables, which is noted rather than silently missing.
 */
export async function listGridColumns(tx: HelmTx): Promise<GridColumn[]> {
  const builtIn: GridColumn[] = ORG_CATEGORIES
    .filter((category) => category.kind === 'node')
    .map((category) => ({
      key: category.source,
      label: category.label,
      source: 'node' as const,
      categorySlug: category.slug,
    }));

  const types = await tx<{ id: string; name: string }[]>`
    SELECT id, name FROM flexible_asset_type
    WHERE is_active AND current_version_id IS NOT NULL
    ORDER BY name
  `;

  return [
    ...builtIn,
    ...types.map((type) => ({
      key: `flex:${type.id}`,
      label: type.name,
      source: 'flexible' as const,
      categorySlug: undefined,
    })),
  ];
}

export interface GridPage {
  rows: GridRow[];
  columns: GridColumn[];
  /** Total clients this actor can see, for the pager. */
  clients: number;
  page: number;
  pageSize: number;
}

export async function readCoverageGrid(
  tx: HelmTx,
  options: { page?: number | undefined; pageSize?: number | undefined } = {},
): Promise<GridPage> {
  const pageSize = options.pageSize ?? GRID_PAGE_SIZE;
  const page = Math.max(1, options.page ?? 1);
  const offset = (page - 1) * pageSize;

  const columns = await listGridColumns(tx);

  const [clientCount] = await tx<{ clients: string }[]>`
    SELECT count(*) AS clients FROM organization WHERE deleted_at IS NULL
  `;
  const clients = Number(clientCount?.clients ?? 0);

  const orgs = await tx<{
    id: string; name: string; is_msp_internal: boolean;
  }[]>`
    SELECT id, name, is_msp_internal FROM organization
    WHERE deleted_at IS NULL
    ORDER BY is_msp_internal DESC, name
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  if (orgs.length === 0) {
    return { rows: [], columns, clients, page, pageSize };
  }

  /*
   * The counts, for these clients only.
   *
   * A flexible record's client lives on asset_node, not on the record — so the
   * LEFT JOIN is how a `flexible_asset` node learns which of the tenant's types
   * it is. It is a LEFT JOIN rather than two UNIONed aggregates because that
   * was measured too: the UNION shape was 997 ms against this one's 430 ms on
   * the same data, since the flexible arm pays the record table's own policy
   * subquery a second time.
   */
  const ids = orgs.map((org) => org.id);
  const counts = await tx<{ organization_id: string; col: string; n: string }[]>`
    SELECT n.organization_id,
           CASE WHEN n.node_type = 'flexible_asset'
                THEN 'flex:' || r.type_id::text
                ELSE n.node_type::text END AS col,
           count(*) AS n
    FROM asset_node n
    LEFT JOIN flexible_asset_record r ON r.id = n.id
    WHERE n.organization_id = ANY (${ids}::uuid[])
      AND n.archived_at IS NULL
    GROUP BY 1, 2
  `;

  const byOrg = new Map<string, Record<string, number>>();
  for (const row of counts) {
    const bucket = byOrg.get(row.organization_id) ?? {};
    // A `flexible_asset` node whose record row is missing groups as 'flex:null'
    // — unreachable through the application, since POST creates both in one
    // transaction, but a column key nothing matches would silently vanish from
    // the grid rather than being visibly odd. Dropped on purpose.
    if (row.col !== 'flex:null') bucket[row.col] = Number(row.n);
    byOrg.set(row.organization_id, bucket);
  }

  return {
    rows: orgs.map((org) => ({
      organizationId: org.id,
      organizationName: org.name,
      isMspInternal: org.is_msp_internal,
      counts: byOrg.get(org.id) ?? {},
    })),
    columns,
    clients,
    page,
    pageSize,
  };
}
