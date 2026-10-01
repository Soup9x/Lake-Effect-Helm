/**
 * The numbers in the drawer.
 *
 * ONE QUERY, not one per category. Sixteen categories plus however many
 * flexible asset types a tenant has defined would otherwise be twenty-odd round
 * trips on every page under an organization, and the drawer renders on every
 * one of them. Scalar subqueries over the same connection cost a single
 * statement and the planner handles them as cheaply as a join would.
 *
 * Every count runs through RLS like any other read, so a client-side user sees
 * their own organisation's totals and a count they are not allowed to see comes
 * back as zero rather than as a number they could have inferred something from.
 */
import type { HelmTx } from '../db/client';
import { ORG_CATEGORIES, type CategoryCounts } from './org-categories';

export interface FlexibleAssetNav {
  id: string;
  name: string;
  /** The type's configured lucide icon name, if it set one. */
  icon: string | null;
  count: number;
}

export interface OrgNavData {
  counts: CategoryCounts;
  flexibleAssets: readonly FlexibleAssetNav[];
}

export async function loadOrgNav(tx: HelmTx, organizationId: string): Promise<OrgNavData> {
  const nodeTypes = ORG_CATEGORIES.filter((c) => c.kind === 'node').map((c) => c.source);

  const [nodeRows, tableRow, faRows] = await Promise.all([
    /*
     * One row per node_type present. GROUP BY rather than sixteen FILTER
     * clauses so adding a category to the registry needs no change here.
     */
    tx<{ node_type: string; n: string }[]>`
      SELECT node_type::text, count(*)::text AS n
      FROM asset_node
      WHERE organization_id = ${organizationId}::uuid
        AND archived_at IS NULL
        AND node_type = ANY (${nodeTypes}::node_type[])
      GROUP BY node_type
    `,
    // The three that are not nodes.
    tx<{ contacts: string; locations: string; documents: string }[]>`
      SELECT
        (SELECT count(*)::text FROM contact
          WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL) AS contacts,
        (SELECT count(*)::text FROM site
          WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL) AS locations,
        (SELECT count(*)::text FROM attachment
          WHERE organization_id = ${organizationId}::uuid AND is_document) AS documents
    `,
    /*
     * Apps & Services: the tenant's own flexible asset types, with their
     * configured icon. This is the honest analogue of IT Glue's custom section —
     * both are "categories this MSP invented for itself".
     */
    tx<{ id: string; name: string; icon: string | null; n: string }[]>`
      -- count(n.id), NOT count(r.id): the org filter is on the NODE, so a
      -- record belonging to another client leaves n NULL while r is still a
      -- row. Counting r here would show every tenant's total on one client.
      SELECT t.id::text, t.name, t.icon,
             count(n.id)::text AS n
      FROM flexible_asset_type t
      LEFT JOIN flexible_asset_record r ON r.type_id = t.id
      LEFT JOIN asset_node n ON n.id = r.id
        AND n.organization_id = ${organizationId}::uuid
        AND n.archived_at IS NULL
      WHERE t.is_active
      GROUP BY t.id, t.name, t.icon
      HAVING count(n.id) > 0
      ORDER BY t.name
    `,
  ]);

  const counts: CategoryCounts = {};
  const byType = new Map(nodeRows.map((r) => [r.node_type, Number(r.n)]));
  for (const category of ORG_CATEGORIES) {
    counts[category.slug] =
      category.kind === 'node'
        ? (byType.get(category.source) ?? 0)
        : Number(
            tableRow[0]?.[category.slug as 'contacts' | 'locations' | 'documents'] ?? '0',
          );
  }

  return {
    counts,
    flexibleAssets: faRows.map((r) => ({
      id: r.id,
      name: r.name,
      icon: r.icon,
      count: Number(r.n),
    })),
  };
}
