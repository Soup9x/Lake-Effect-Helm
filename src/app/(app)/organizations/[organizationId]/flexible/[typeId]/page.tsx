import { notFound } from 'next/navigation';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { CategoryGrid, type CategoryRecord } from '@/components/shell/category-grid';
import { ViewHeader } from '@/components/shell/view-header';
import { Button } from '@/components/ui/button';
import { isClientRole } from '@/lib/ui/roles';

export const dynamic = 'force-dynamic';

/**
 * One flexible asset type, for one client — the "Apps & Services" destination.
 *
 * A SEPARATE ROUTE FROM [category] rather than another slug in the registry,
 * because the thing being selected is a ROW in flexible_asset_type rather than a
 * fixed node_type. Folding it into the registry would mean the registry depending
 * on tenant data, and `/organizations/x/flexible` resolving to a category called
 * "flexible" that does not exist.
 *
 * `needs_migration` is surfaced as the flag column. A record whose type has moved
 * on since it was written is the one thing somebody looking at this list needs to
 * know, and 0080 set that flag precisely so it would not be discovered silently.
 */
export default async function FlexibleAssetPage({
  params,
}: {
  params: Promise<{ organizationId: string; typeId: string }>;
}) {
  const { organizationId, typeId } = await params;
  const identity = await getServerIdentity();

  const data = await withTenant(actorOf(identity), async (tx) => {
    const [org] = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM organization WHERE id = ${organizationId}::uuid
    `;
    if (!org) return null;

    const [type] = await tx<{ id: string; name: string; description: string | null }[]>`
      SELECT id, name, description FROM flexible_asset_type
      WHERE id = ${typeId}::uuid AND is_active
    `;
    if (!type) return null;

    const rows = await tx<{
      id: string; name: string; status: string; needs_migration: boolean;
      updated_at: Date; updated_by_name: string | null; is_internal_only: boolean;
    }[]>`
      SELECT n.id, n.name, n.status::text, r.needs_migration,
             n.updated_at, u.name AS updated_by_name, n.is_internal_only
      FROM flexible_asset_record r
      JOIN asset_node n ON n.id = r.id
      LEFT JOIN app_user u ON u.id = n.updated_by
      WHERE r.type_id = ${typeId}::uuid
        AND n.organization_id = ${organizationId}::uuid
        AND n.archived_at IS NULL
      ORDER BY n.name
      LIMIT 500
    `;

    return {
      org,
      type,
      records: rows.map<CategoryRecord>((r) => ({
        id: r.id,
        name: r.name,
        href: `/assets/${r.id}`,
        type: r.status,
        ...(r.needs_migration ? { extra: 'Needs migration', flagged: true } : {}),
        internalOnly: r.is_internal_only,
        updatedAt: r.updated_at.toISOString(),
        updatedBy: r.updated_by_name,
      })),
    };
  });

  if (!data) notFound();

  const canWrite = !isClientRole(identity.roleKey);
  const base = `/organizations/${organizationId}`;

  return (
    <>
      <ViewHeader
        trail={[{ label: data.org.name, href: base }]}
        title={data.type.name}
        description={data.type.description ?? undefined}
        actions={
          canWrite ? (
            <Button variant="cta" size="sm">
              + New
            </Button>
          ) : null
        }
      />
      <CategoryGrid
        records={data.records}
        total={data.records.length}
        categoryLabel={data.type.name}
        canWrite={canWrite}
      />
    </>
  );
}
