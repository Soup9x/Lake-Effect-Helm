import Link from 'next/link';
import { Building2 } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { HealthDot } from '@/components/ui/health-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NewOrganizationForm } from '@/components/new-organization-form';
import { FavoriteStar } from '@/components/favorite-star';
import { isClientRole } from '@/lib/ui/roles';
import { favoriteIds } from '@/lib/workspace/queries';

interface OrganizationRow {
  id: string;
  name: string;
  status: string;
  is_msp_internal: boolean;
  industry: string | null;
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
 * The old "next expiry" column showed the severity of the SOONEST row, which is
 * not the same thing and was quietly wrong: a client with a certificate that
 * expired last month and a warranty due next year reported the warranty.
 */
export default async function OrganizationsPage() {
  const identity = await getServerIdentity();

  const canWrite = !isClientRole(identity.roleKey);

  const { organizations, pinned } = await withTenant(actorOf(identity), async (tx) => {
    const rows = await tx<OrganizationRow[]>`
      SELECT
        o.id, o.name, o.status::text, o.is_msp_internal, o.industry,
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
      ORDER BY o.is_msp_internal, o.name
    `;
    return { organizations: rows, pinned: await favoriteIds(tx) };
  });

  // Pinned clients float to the top of the same table rather than into a
  // separate card. A technician scanning for a client should find it in one
  // place whether or not they starred it; two lists means checking both.
  const ordered = [
    ...organizations.filter((o) => pinned.has(o.id)),
    ...organizations.filter((o) => !pinned.has(o.id)),
  ];
  const firstUnpinned = organizations.filter((o) => pinned.has(o.id)).length;

  return (
    <>
      <PageHeader
        title="Clients"
        description="Every organisation documented in this tenant, and what is in each."
        actions={canWrite ? <NewOrganizationForm /> : undefined}
      />
      <PageBody>
        <Card>
          <CardContent className="p-0">
            {organizations.length === 0 ? (
              <EmptyState
                icon={Building2}
                title="No clients are visible"
                description="Either none are documented yet, or your membership is scoped to organisations that no longer exist."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-8">
                      <span className="sr-only">Pinned</span>
                    </TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Health</TableHead>
                    <TableHead>Sites</TableHead>
                    <TableHead>Assets</TableHead>
                    <TableHead>Credentials</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ordered.map((org, index) => (
                    <TableRow
                      key={org.id}
                      // A hairline under the last pinned row. Enough to say
                      // "these are yours" without a second heading.
                      className={
                        firstUnpinned > 0 && index === firstUnpinned - 1
                          ? 'border-b-2 border-b-border'
                          : undefined
                      }
                    >
                      <TableCell className="pr-0">
                        <FavoriteStar
                          organizationId={org.id}
                          pinned={pinned.has(org.id)}
                          label={org.name}
                        />
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/organizations/${org.id}`}
                          className="font-medium text-ink hover:text-brand"
                        >
                          {org.name}
                        </Link>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          {org.is_msp_internal && <Badge tone="brand">Internal</Badge>}
                          {org.status !== 'active' && <Badge tone="danger">{org.status}</Badge>}
                          {org.industry && (
                            <span className="text-xs text-ink-faint">{org.industry}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <HealthDot
                          showLabel
                          organizationId={org.id}
                          health={{
                            health: org.health,
                            expiredCount: org.expired_count,
                            criticalCount: org.critical_count,
                            warningCount: org.warning_count,
                            reasons: org.reasons,
                          }}
                        />
                      </TableCell>
                      <TableCell className="tabular-nums text-ink-muted">{org.site_count}</TableCell>
                      <TableCell className="tabular-nums text-ink-muted">{org.asset_count}</TableCell>
                      <TableCell className="tabular-nums text-ink-muted">{org.secret_count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
