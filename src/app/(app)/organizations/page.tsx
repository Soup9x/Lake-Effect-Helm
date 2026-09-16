import Link from 'next/link';
import { Building2 } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, severityTone } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NewOrganizationForm } from '@/components/new-organization-form';
import { isClientRole } from '@/lib/ui/roles';

interface OrganizationRow {
  id: string;
  name: string;
  status: string;
  is_msp_internal: boolean;
  industry: string | null;
  site_count: string;
  asset_count: string;
  secret_count: string;
  worst_severity: string | null;
  soonest_expiry: Date | null;
}

/**
 * The client list.
 *
 * Counts come from correlated subqueries rather than a wide join with GROUP BY:
 * each subquery is independently RLS-scoped, so an organisation a client user
 * cannot see contributes nothing anywhere, and there is no join fan-out to get
 * the asset count wrong.
 */
export default async function OrganizationsPage() {
  const identity = await getServerIdentity();

  const canWrite = !isClientRole(identity.roleKey);

  const organizations = await withTenant(actorOf(identity), async (tx) => {
    return tx<OrganizationRow[]>`
      SELECT
        o.id, o.name, o.status::text, o.is_msp_internal, o.industry,
        (SELECT count(*) FROM site s
          WHERE s.organization_id = o.id AND s.deleted_at IS NULL) AS site_count,
        (SELECT count(*) FROM asset_node n
          WHERE n.organization_id = o.id AND n.archived_at IS NULL) AS asset_count,
        (SELECT count(*) FROM v_secret_metadata m
          WHERE m.organization_id = o.id) AS secret_count,
        (SELECT e.severity::text FROM v_expiration_dashboard e
          WHERE e.organization_id = o.id ORDER BY e.expires_at LIMIT 1) AS worst_severity,
        (SELECT min(e.expires_at) FROM v_expiration_dashboard e
          WHERE e.organization_id = o.id) AS soonest_expiry
      FROM organization o
      WHERE o.deleted_at IS NULL
      ORDER BY o.is_msp_internal, o.name
    `;
  });

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
                    <TableHead>Client</TableHead>
                    <TableHead>Sites</TableHead>
                    <TableHead>Assets</TableHead>
                    <TableHead>Credentials</TableHead>
                    <TableHead>Next expiry</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizations.map((org) => (
                    <TableRow key={org.id}>
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
                      <TableCell className="tabular-nums text-ink-muted">{org.site_count}</TableCell>
                      <TableCell className="tabular-nums text-ink-muted">{org.asset_count}</TableCell>
                      <TableCell className="tabular-nums text-ink-muted">{org.secret_count}</TableCell>
                      <TableCell>
                        {org.worst_severity ? (
                          <Badge tone={severityTone(org.worst_severity)}>{org.worst_severity}</Badge>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </TableCell>
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
