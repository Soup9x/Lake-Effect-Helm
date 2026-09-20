import Link from 'next/link';
import { Building2 } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { HealthDot } from '@/components/ui/health-dot';
import { NewOrganizationForm } from '@/components/new-organization-form';
import { FavoriteStar } from '@/components/favorite-star';
import { SelectableTable, type SelectableRow } from '@/components/selectable-table';
import { DeletePermanently } from '@/components/delete-permanently';
import { isClientRole } from '@/lib/ui/roles';
import { favoriteIds } from '@/lib/workspace/queries';

interface OrganizationRow {
  id: string;
  name: string;
  status: string;
  is_msp_internal: boolean;
  industry: string | null;
  tags: string[];
  site_count: string;
  asset_count: string;
  secret_count: string;
  health: string;
  expired_count: number;
  critical_count: number;
  warning_count: number;
  reasons: string[] | null;
}

/**
 * The client list.
 *
 * Counts come from correlated subqueries rather than a wide join with GROUP BY:
 * each subquery is independently RLS-scoped, so an organisation a client user
 * cannot see contributes nothing anywhere, and there is no join fan-out to get
 * the asset count wrong.
 *
 * Health comes from v_client_health, which aggregates v_expiration_dashboard.
 *
 * ARCHIVED CLIENTS are absent by default and reachable by a filter, never
 * deleted. `?archived=1` shows only them, which is also the only place they can
 * be restored from — an archive you cannot open is a delete with extra steps.
 */
export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const identity = await getServerIdentity();
  const params = await searchParams;
  const showArchived = params.archived === '1';

  const canWrite = !isClientRole(identity.roleKey);

  const { organizations, pinned, archivedCount, canDelete } = await withTenant(
    actorOf(identity),
    async (tx, session) => {
    const rows = await tx<OrganizationRow[]>`
      SELECT
        o.id, o.name, o.status::text, o.is_msp_internal, o.industry, o.tags,
        (SELECT count(*) FROM site s
          WHERE s.organization_id = o.id AND s.deleted_at IS NULL) AS site_count,
        (SELECT count(*) FROM asset_node n
          WHERE n.organization_id = o.id AND n.archived_at IS NULL) AS asset_count,
        (SELECT count(*) FROM v_secret_metadata m
          WHERE m.organization_id = o.id) AS secret_count,
        coalesce(h.health, 'green') AS health,
        coalesce(h.expired_count, 0) AS expired_count,
        coalesce(h.critical_count, 0) AS critical_count,
        coalesce(h.warning_count, 0) AS warning_count,
        h.reasons
      FROM organization o
      LEFT JOIN v_client_health h ON h.organization_id = o.id
      WHERE o.deleted_at IS NULL
        AND (${showArchived}::boolean = (o.archived_at IS NOT NULL))
      ORDER BY o.is_msp_internal, o.name
    `;
    const [counted] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM organization
      WHERE deleted_at IS NULL AND archived_at IS NOT NULL
    `;
    return {
      organizations: rows,
      pinned: await favoriteIds(tx),
      archivedCount: counted?.n ?? 0,
      // Permanent deletion is organization:delete — msp_only, and in the
      // shipped catalogue super_admin alone. Strictly above the asset:write
      // that archiving needs, which is the point.
      canDelete: session.permissions.includes('organization:delete'),
    };
    },
  );

  // Pinned clients float to the top of the same table rather than into a
  // separate card. A technician scanning for a client should find it in one
  // place whether or not they starred it; two lists means checking both.
  const ordered = [
    ...organizations.filter((o) => pinned.has(o.id)),
    ...organizations.filter((o) => !pinned.has(o.id)),
  ];
  const pinnedCount = organizations.filter((o) => pinned.has(o.id)).length;

  const rows: SelectableRow[] = ordered.map((org, index) => ({
    id: org.id,
    label: org.name,
    dividerAfter: pinnedCount > 0 && index === pinnedCount - 1,
    cells: [
      <FavoriteStar key="star" organizationId={org.id} pinned={pinned.has(org.id)} label={org.name} />,
      <div key="name">
        <Link href={`/organizations/${org.id}`} className="font-medium text-ink hover:text-brand">
          {org.name}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {org.is_msp_internal && <Badge tone="brand">Internal</Badge>}
          {org.status !== 'active' && <Badge tone="danger">{org.status}</Badge>}
          {org.tags.map((tag) => (
            <Badge key={tag} tone="neutral">
              {tag}
            </Badge>
          ))}
          {org.industry && <span className="text-xs text-ink-faint">{org.industry}</span>}
        </div>
      </div>,
      <HealthDot
        key="health"
        showLabel
        organizationId={org.id}
        health={{
          health: org.health,
          expiredCount: org.expired_count,
          criticalCount: org.critical_count,
          warningCount: org.warning_count,
          reasons: org.reasons,
        }}
      />,
      <span key="sites" className="tabular-nums text-ink-muted">{org.site_count}</span>,
      <span key="assets" className="tabular-nums text-ink-muted">{org.asset_count}</span>,
      <span key="secrets" className="tabular-nums text-ink-muted">{org.secret_count}</span>,
      // Only in the archive, and only for somebody who holds organization:delete.
      // The rail is in helm.delete_organization(), which refuses a live client
      // whatever the interface offers; this is where it is reachable.
      showArchived && canDelete ? (
        <DeletePermanently
          key="delete"
          endpoint={`/api/organizations/${org.id}`}
          name={org.name}
          kind="client"
          counts={{
            assets: Number(org.asset_count),
            secrets: Number(org.secret_count),
            sites: Number(org.site_count),
          }}
        />
      ) : (
        <span key="delete" />
      ),
    ],
  }));

  return (
    <>
      <PageHeader
        title={showArchived ? 'Archived clients' : 'Clients'}
        trail={showArchived ? [{ label: 'Clients', href: '/organizations' }] : []}
        description={
          showArchived
            ? 'Hidden from the client list and from search. Nothing has been deleted; select and restore to bring one back.'
            : 'Every organisation documented in this tenant, and what is in each.'
        }
        actions={canWrite && !showArchived ? <NewOrganizationForm /> : undefined}
      />
      <PageBody>
        {/* Only offered when there is an archive to open. A link to an empty
            page is a promise of something that is not there. */}
        {(archivedCount > 0 || showArchived) && (
          <nav className="flex items-center gap-1.5 text-xs">
            <Link
              href="/organizations"
              className={showArchived ? 'text-brand hover:underline' : 'font-medium text-ink'}
            >
              Active
            </Link>
            <span className="text-ink-faint">·</span>
            <Link
              href="/organizations?archived=1"
              className={showArchived ? 'font-medium text-ink' : 'text-brand hover:underline'}
            >
              Archived <span className="tabular-nums">{archivedCount}</span>
            </Link>
          </nav>
        )}

        <Card>
          <CardContent className="p-0">
            {organizations.length === 0 ? (
              <EmptyState
                icon={Building2}
                title={showArchived ? 'Nothing is archived' : 'No clients are visible'}
                description={
                  showArchived
                    ? 'Archived clients appear here and can be restored.'
                    : 'Either none are documented yet, or your membership is scoped to organisations that no longer exist.'
                }
              />
            ) : (
              <SelectableTable
                target="client"
                archived={showArchived}
                selectable={canWrite}
                columns={[
                  // The star column has no heading worth showing, but it still
                  // needs one: a header cell short of the body cells shifts
                  // every column right by one.
                  <span key="pin" className="sr-only">Pinned</span>,
                  'Client',
                  'Health',
                  'Sites',
                  'Assets',
                  'Credentials',
                  <span key="delete" className="sr-only">Delete</span>,
                ]}
                rows={rows}
              />
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
