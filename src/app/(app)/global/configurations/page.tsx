import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { CategoryGrid, type CategoryRecord } from '@/components/shell/category-grid';
import { ViewHeader } from '@/components/shell/view-header';
import { GlobalListFilters } from '@/components/global-list-filters';
import {
  GLOBAL_LIST_LIMIT, globalFilterOptions, listGlobalConfigurations, readConfigurationFilters,
} from '@/lib/global/lists';
import { NODE_STATUSES } from '@/lib/assets/statuses';
import { DEVICE_TYPES } from '@/lib/assets/detail-fields';
import { humanise } from '@/lib/ui/format';
import { isClientRole } from '@/lib/ui/roles';

export const dynamic = 'force-dynamic';

const TYPES = DEVICE_TYPES.map((t) => ({ value: t, label: humanise(t) }));

/**
 * Every client's configurations in one list — the columns a client's
 * Configurations tab shows, plus the client — narrowed by client, location,
 * device type, status and visibility.
 */
export default async function GlobalConfigurationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await getServerIdentity();
  const filters = readConfigurationFilters(await searchParams);
  const canWrite = !isClientRole(identity.roleKey);

  const data = await withTenant(actorOf(identity), async (tx, session) => {
    const [rank] = await tx<{ rank: number }[]>`SELECT helm.current_role_rank() AS rank`;
    const [rows, options] = await Promise.all([
      listGlobalConfigurations(tx, filters),
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
    secondary: humanise(r.device_type),
    type: r.status,
    extra: r.organization_name,
    internalOnly: r.is_internal_only,
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by_name,
    removeKind: 'node',
    archived: r.archived,
    permissions: { internalOnly: r.is_internal_only },
    cells: {
      os: [r.operating_system, r.os_version].filter(Boolean).join(' ') || null,
      primaryIp: r.primary_ip,
      serial: r.serial_number,
      expires: r.warranty_expires_at ? r.warranty_expires_at.toISOString().slice(0, 10) : null,
      location: r.site_name,
    },
  }));

  return (
    <>
      <ViewHeader
        trail={[{ label: 'Global', href: '/global' }]}
        title="Configurations"
        description={data.rows.length >= GLOBAL_LIST_LIMIT
          ? `Showing the first ${GLOBAL_LIST_LIMIT}. Narrow the list with the filters below.`
          : 'Every client’s servers, network gear and endpoints.'}
      />
      <GlobalListFilters
        clients={data.options.clients}
        sites={data.options.sites}
        types={TYPES}
        typeLabel="Device type"
        statuses={NODE_STATUSES}
      />
      <CategoryGrid
        records={records}
        total={records.length}
        categoryLabel="Configurations"
        canWrite={canWrite}
        canDelete={data.canDelete}
        labels={{ secondary: 'Type', type: 'Status', extra: 'Client' }}
        actorRoleRank={data.actorRoleRank}
        columnScope="global-configurations"
        extraColumns={[
          { key: 'os', header: 'OS' },
          { key: 'primaryIp', header: 'Primary IP' },
          { key: 'serial', header: 'Serial number', secondary: true },
          { key: 'expires', header: 'Expires', secondary: true },
          { key: 'location', header: 'Location' },
        ]}
      />
    </>
  );
}
