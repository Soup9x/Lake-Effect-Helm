import Link from 'next/link';
import { Building2 } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { NewOrganizationForm } from '@/components/new-organization-form';
import { ClientsTable, type ClientRow } from '@/components/clients-table';
import { ClientStrip } from '@/components/client-strip';
import { isClientRole } from '@/lib/ui/roles';
import { favoriteIds, listFavorites, listRecent } from '@/lib/workspace/queries';
import { ACTIVE_STATUSES, RELATIONSHIP_KEYS, RELATIONSHIPS } from '@/lib/ui/organization-relationship';

interface OrganizationQueryRow {
  id: string;
  name: string;
  status: string;
  relationship: string;
  is_msp_internal: boolean;
  industry: string | null;
  logo_url: string | null;
  tags: string[];
  site_count: string;
  asset_count: string;
  secret_count: string;
  health: string;
  expired_count: number;
  critical_count: number;
  warning_count: number;
  reasons: string[] | null;
  sync_status: string | null;
  sync_at: Date | null;
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
 *
 * TYPE AND STATUS FILTER IN SQL; the text box filters in the browser. That
 * split is not an inconsistency: `?type=vendor` is a link somebody pastes into
 * a ticket and should return the same rows for everyone, while the text box is
 * a person narrowing what is already on their screen. The one that belongs in
 * the URL is the one that goes to the database.
 */
export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string; q?: string; type?: string; status?: string }>;
}) {
  const identity = await getServerIdentity();
  const params = await searchParams;
  const showArchived = params.archived === '1';
  const query = params.q ?? '';

  // Unrecognised values are dropped rather than rejected: a stale link with a
  // type that has since been removed should show the list, not an error.
  const typeFilter =
    params.type && (RELATIONSHIP_KEYS as readonly string[]).includes(params.type)
      ? params.type
      : null;
  const activeFilter =
    params.status === 'active' ? true : params.status === 'inactive' ? false : null;

  const canWrite = !isClientRole(identity.roleKey);

  const { organizations, pinned, archivedCount, canDelete, recents, favorites } =
    await withTenant(actorOf(identity), async (tx, session) => {
      const rows = await tx<OrganizationQueryRow[]>`
      SELECT
        o.id, o.name, o.status::text, o.relationship::text AS relationship,
        o.is_msp_internal, o.industry, o.logo_url, o.tags,
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
        h.reasons,
        -- The most recent run of any integration covering this client. LATERAL
        -- rather than a correlated subquery because two columns come back
        -- together, and a NULL here means "no integration is mapped", which the
        -- Sync column renders differently from a run that failed.
        sync.status::text AS sync_status,
        sync.finished_at AS sync_at
      FROM organization o
      LEFT JOIN v_client_health h ON h.organization_id = o.id
      LEFT JOIN LATERAL (
        SELECT r.status, r.finished_at
        FROM integration_sync_run r
        JOIN integration_connection c ON c.id = r.connection_id
        WHERE c.organization_id = o.id
        ORDER BY r.started_at DESC
        LIMIT 1
      ) sync ON true
      WHERE o.deleted_at IS NULL
        AND (${showArchived}::boolean = (o.archived_at IS NOT NULL))
        AND (${typeFilter}::text IS NULL OR o.relationship::text = ${typeFilter})
        AND (
          ${activeFilter}::boolean IS NULL
          OR (o.status::text = ANY(${ACTIVE_STATUSES as unknown as string[]})) = ${activeFilter}
        )
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
        // The strip is about getting back to work, so it ignores the filters
        // above: a vendor you opened an hour ago is still what you want.
        recents: showArchived ? [] : await listRecent(tx, 20),
        favorites: showArchived ? [] : await listFavorites(tx),
      };
    });

  // Pinned clients float to the top while no sort is active. See ClientsTable.
  const ordered = [
    ...organizations.filter((o) => pinned.has(o.id)),
    ...organizations.filter((o) => !pinned.has(o.id)),
  ];

  const clients: ClientRow[] = ordered.map((org) => ({
    id: org.id,
    name: org.name,
    status: org.status,
    relationship: org.relationship,
    isMspInternal: org.is_msp_internal,
    industry: org.industry,
    logoUrl: org.logo_url,
    tags: org.tags,
    siteCount: Number(org.site_count),
    assetCount: Number(org.asset_count),
    secretCount: Number(org.secret_count),
    health: {
      health: org.health,
      expiredCount: org.expired_count,
      criticalCount: org.critical_count,
      warningCount: org.warning_count,
      reasons: org.reasons,
    },
    sync: org.sync_status
      ? { status: org.sync_status, at: org.sync_at?.toISOString() ?? null }
      : null,
    pinned: pinned.has(org.id),
  }));

  // Logos for the strip, from the rows already fetched. The strip shows recents
  // that may be filtered out of the table above, so a miss here is normal and
  // falls back to initials rather than to nothing.
  const logos = new Map(organizations.map((o) => [o.id, o.logo_url]));

  /** A filter chip that keeps every other parameter in the URL. */
  function chip(key: 'type' | 'status', value: string | null, label: string) {
    const next = new URLSearchParams();
    if (showArchived) next.set('archived', '1');
    if (query) next.set('q', query);
    if (key !== 'type' && typeFilter) next.set('type', typeFilter);
    if (key !== 'status' && params.status) next.set('status', params.status);
    if (value) next.set(key, value);
    const active = key === 'type' ? typeFilter === value : (params.status ?? null) === value;
    const href = `/organizations${next.toString() ? `?${next}` : ''}`;
    return (
      <Link
        key={`${key}:${value ?? 'all'}`}
        href={href}
        className={
          active
            ? 'rounded-full border border-brand bg-brand-tint px-2 py-0.5 text-xs font-medium text-brand-strong'
            : 'rounded-full border border-border px-2 py-0.5 text-xs text-ink-muted hover:border-brand hover:text-brand'
        }
      >
        {label}
      </Link>
    );
  }

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
        {!showArchived && (
          <ClientStrip recents={recents} favorites={favorites} logos={logos} />
        )}

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

        {!showArchived && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-ink-faint">Type</span>
              {chip('type', null, 'All')}
              {RELATIONSHIP_KEYS.map((key) =>
                chip('type', key, RELATIONSHIPS[key].label),
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-ink-faint">Status</span>
              {chip('status', null, 'Any')}
              {chip('status', 'active', 'Active')}
              {chip('status', 'inactive', 'Inactive')}
            </div>
          </div>
        )}

        <Card>
          <CardContent className="p-0">
            {clients.length === 0 ? (
              <EmptyState
                icon={Building2}
                title={
                  showArchived
                    ? 'Nothing is archived'
                    : typeFilter || activeFilter !== null
                      ? 'No clients match these filters'
                      : 'No clients are visible'
                }
                description={
                  showArchived
                    ? 'Archived clients appear here and can be restored.'
                    : typeFilter || activeFilter !== null
                      ? 'Clear the filters above to see the whole list.'
                      : 'Either none are documented yet, or your membership is scoped to organisations that no longer exist.'
                }
              />
            ) : (
              <ClientsTable
                clients={clients}
                query={query}
                canWrite={canWrite}
                canDelete={canDelete}
                archived={showArchived}
              />
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
