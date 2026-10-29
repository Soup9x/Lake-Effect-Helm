import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { CategoryGrid, type CategoryRecord } from '@/components/shell/category-grid';
import { ViewHeader } from '@/components/shell/view-header';
import { GlobalListFilters } from '@/components/global-list-filters';
import {
  GLOBAL_CREDENTIAL_TYPES, GLOBAL_LIST_LIMIT, globalFilterOptions, listGlobalCredentials, readCredentialFilters,
} from '@/lib/global/lists';
import { NODE_STATUSES } from '@/lib/assets/statuses';
import { isClientRole } from '@/lib/ui/roles';

export const dynamic = 'force-dynamic';

const TYPE_LABEL = new Map(GLOBAL_CREDENTIAL_TYPES.map((t) => [t.value, t.label]));

/**
 * Every client's credentials in one list, narrowed by client, location, type,
 * status and visibility.
 *
 * The same rows, columns and controls as a client's Credentials tab — copy the
 * username, open where it is used, see whether a code can be generated, the
 * access policy in the permissions dialog — and no values: revealing one still
 * goes through the entry's page, with its reason, step-up and audit row.
 */
export default async function GlobalCredentialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await getServerIdentity();
  const filters = readCredentialFilters(await searchParams);
  const canWrite = !isClientRole(identity.roleKey);

  const data = await withTenant(actorOf(identity), async (tx, session) => {
    const [rank] = await tx<{ rank: number }[]>`SELECT helm.current_role_rank() AS rank`;
    const [rows, options] = await Promise.all([
      listGlobalCredentials(tx, filters),
      globalFilterOptions(tx, filters.client),
    ]);
    return {
      rows, options,
      actorRoleRank: rank?.rank ?? 0,
      canDelete: session.permissions.includes('asset:delete'),
      canDeleteCredentials: session.permissions.includes('secret:delete'),
    };
  });

  const records = data.rows.map<CategoryRecord>((r) => ({
    id: r.id,
    name: r.name,
    href: `/assets/${r.id}`,
    secondary: r.username,
    type: r.status,
    extra: r.organization_name,
    internalOnly: r.is_internal_only,
    hasTotp: r.has_totp,
    externalUrl: r.url,
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by_name,
    removeKind: 'node',
    nodeType: 'credential',
    archived: r.archived,
    permissions: {
      internalOnly: r.is_internal_only,
      ...(r.secret_id
        ? {
            secret: {
              id: r.secret_id,
              sensitivity: (r.sensitivity ?? 'standard') as 'standard' | 'elevated' | 'critical',
              requiresStepUp: r.requires_step_up ?? false,
              requiresReason: r.requires_reason ?? false,
              minRoleRank: r.min_role_rank ?? 40,
            },
          }
        : {}),
    },
    cells: {
      kind: TYPE_LABEL.get(r.credential_type) ?? r.credential_type,
      location: r.site_name,
      vault: r.secret_label,
    },
  }));

  return (
    <>
      <ViewHeader
        trail={[{ label: 'Global', href: '/global' }]}
        title="Credentials"
        description={data.rows.length >= GLOBAL_LIST_LIMIT
          ? `Showing the first ${GLOBAL_LIST_LIMIT}. Narrow the list with the filters below.`
          : 'Every client’s logins. Open one to reveal it; each reveal is recorded.'}
      />
      <GlobalListFilters
        clients={data.options.clients}
        sites={data.options.sites}
        types={GLOBAL_CREDENTIAL_TYPES}
        typeLabel="Type"
        statuses={NODE_STATUSES}
      />
      <CategoryGrid
        records={records}
        total={records.length}
        categoryLabel="Credentials"
        canWrite={canWrite}
        canDelete={data.canDelete}
        canDeleteCredentials={data.canDeleteCredentials}
        labels={{ secondary: 'Username', type: 'Status', extra: 'Client' }}
        actorRoleRank={data.actorRoleRank}
        columnScope="global-credentials"
        extraColumns={[
          { key: 'kind', header: 'Type' },
          { key: 'location', header: 'Location' },
          { key: 'vault', header: 'Vault entry' },
        ]}
      />
    </>
  );
}
