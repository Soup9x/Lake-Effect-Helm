import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/ids';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { TopologyDesigner } from '@/components/topology-designer';
import { DiagramPageActions } from '@/components/diagram-page-actions';
import { isClientRole } from '@/lib/ui/roles';
import { formatDateTime } from '@/lib/ui/format';

export const dynamic = 'force-dynamic';

/**
 * One network diagram, drawn full width (0880).
 *
 * Diagrams used to sit at the bottom of a Network entry's page (0860), which
 * left nowhere for a drawing of a whole building. Each is now a record of the
 * client's, listed under its Diagrams tab and opened here.
 *
 * UNDER RLS like every read: a diagram this actor cannot see — another
 * client's, or an internal-only one for a client user — is a 404, the same
 * answer as one that does not exist. An archived diagram is shown, marked,
 * read-only, with Restore.
 */
export default async function DiagramPage({ params }: { params: Promise<{ diagramId: string }> }) {
  const identity = await getServerIdentity();
  const { diagramId } = await params;
  if (!isUuid(diagramId)) notFound();

  const canWrite = !isClientRole(identity.roleKey);
  const data = await withTenant(actorOf(identity), async (tx) => {
    const [row] = await tx<{
      id: string; name: string; description: string | null; organization_id: string; organization_name: string;
      site_id: string | null; site_name: string | null; network_id: string | null; network_name: string | null;
      is_internal_only: boolean; archived_at: Date | null;
    }[]>`
      SELECT d.id, d.name, d.description, d.organization_id, o.name AS organization_name,
             s.id AS site_id, s.name AS site_name, n.id AS network_id, n.name AS network_name,
             d.is_internal_only, d.archived_at
      FROM network_diagram d
      JOIN organization o ON o.id = d.organization_id
      LEFT JOIN site s ON s.id = d.site_id AND s.deleted_at IS NULL
      LEFT JOIN asset_node n ON n.id = d.network_id
      WHERE d.id = ${diagramId}::uuid
    `;
    if (!row) return null;
    // The edit dialog's pickers, only for somebody who can edit.
    const [sites, networks] = canWrite
      ? await Promise.all([
          tx<{ id: string; name: string }[]>`
            SELECT id, name FROM site
            WHERE organization_id = ${row.organization_id}::uuid AND deleted_at IS NULL
            ORDER BY name
          `,
          tx<{ id: string; name: string }[]>`
            SELECT id, name FROM asset_node
            WHERE organization_id = ${row.organization_id}::uuid AND archived_at IS NULL
              AND node_type = 'network'
            ORDER BY lower(name)
          `,
        ])
      : [[], []];
    return { row, sites, networks };
  });
  if (!data) notFound();

  const { row, sites, networks } = data;
  const archived = row.archived_at !== null;

  return (
    <>
      <PageHeader
        title={row.name}
        description={row.description ?? undefined}
        trail={[
          { label: 'Clients', href: '/organizations' },
          { label: row.organization_name, href: `/organizations/${row.organization_id}` },
          { label: 'Diagrams', href: `/organizations/${row.organization_id}/diagrams` },
        ]}
        actions={canWrite ? (
          <DiagramPageActions
            diagramId={row.id}
            organizationId={row.organization_id}
            archived={archived}
            sites={sites}
            networks={networks}
            values={{
              name: row.name,
              description: row.description ?? '',
              siteId: row.site_id ?? '',
              networkId: row.network_id ?? '',
              isInternalOnly: row.is_internal_only,
            }}
          />
        ) : undefined}
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          {archived && <Badge tone="warning">Archived {formatDateTime(row.archived_at!.toISOString())}</Badge>}
          {row.is_internal_only && <Badge tone="neutral">Internal only</Badge>}
          {row.site_id && row.site_name && (
            <Link href={`/locations/${row.site_id}`}><Badge tone="neutral">{row.site_name}</Badge></Link>
          )}
          {row.network_id && row.network_name && (
            <Link href={`/assets/${row.network_id}`}><Badge tone="brand">{row.network_name}</Badge></Link>
          )}
        </div>

        <TopologyDesigner diagramId={row.id} diagramName={row.name} canEdit={canWrite && !archived} />
      </PageBody>
    </>
  );
}
