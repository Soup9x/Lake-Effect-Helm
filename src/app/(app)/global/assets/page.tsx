import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { CategoryGrid, type CategoryRecord } from '@/components/shell/category-grid';
import { ViewHeader } from '@/components/shell/view-header';
import { GlobalListFilters } from '@/components/global-list-filters';
import {
  GLOBAL_ASSET_TYPES, GLOBAL_LIST_LIMIT, globalFilterOptions, listGlobalAssets, readAssetFilters,
} from '@/lib/global/lists';
import { NODE_STATUSES } from '@/lib/assets/statuses';
import { isClientRole } from '@/lib/ui/roles';

export const dynamic = 'force-dynamic';

const TYPE_LABEL = new Map(GLOBAL_ASSET_TYPES.map((t) => [t.value, t.label]));

/**
 * Every client's assets in one list, narrowed by client, location, type,
 * status and visibility (see src/lib/global/lists.ts for what is and is not in
 * it). The grid is the one a client's category pages use, so text filtering,
 * columns, archive and restore behave the same here.
 */
export default async function GlobalAssetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await getServerIdentity();
  const filters = readAssetFilters(await searchParams);
  const canWrite = !isClientRole(identity.roleKey);

  const data = await withTenant(actorOf(identity), async (tx, session) => {
    const [rank] = await tx<{ rank: number }[]>`SELECT helm.current_role_rank() AS rank`;
    const [rows, options] = await Promise.all([
      listGlobalAssets(tx, filters),
      globalFilterOptions(tx, filters.client),
    ]);
    return {
      rows, options,
      actorRoleRank: rank?.rank ?? 0,
      canDelete: session.permissions.includes('asset:delete'),
    };
  });

  const records = data.rows.map<CategoryRecord>((r) => ({
    id: r.id,
    name: r.name,
    href: `/assets/${r.id}`,
    secondary: r.flexible_type_name ?? TYPE_LABEL.get(r.node_type) ?? r.node_type,
    type: r.status,
    extra: r.organization_name,
    internalOnly: r.is_internal_only,
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by_name,
    removeKind: 'node',
    nodeType: r.node_type,
    archived: r.archived,
    permissions: { internalOnly: r.is_internal_only },
    cells: { location: r.site_name },
  }));

  return (
    <>
      <ViewHeader
        trail={[{ label: 'Global', href: '/global' }]}
        title="Assets"
        description={data.rows.length >= GLOBAL_LIST_LIMIT
          ? `Showing the first ${GLOBAL_LIST_LIMIT}. Narrow the list with the filters below.`
          : 'Every client’s documented assets. Credentials stay on each client’s Credentials tab.'}
      />
      <GlobalListFilters
        clients={data.options.clients}
        sites={data.options.sites}
        types={GLOBAL_ASSET_TYPES}
        typeLabel="Type"
        statuses={NODE_STATUSES}
      />
      <CategoryGrid
        records={records}
        total={records.length}
        categoryLabel="Assets"
        canWrite={canWrite}
        canDelete={data.canDelete}
        labels={{ secondary: 'Type', type: 'Status', extra: 'Client' }}
        actorRoleRank={data.actorRoleRank}
        columnScope="global-assets"
        extraColumns={[{ key: 'location', header: 'Location' }]}
      />
    </>
  );
}
