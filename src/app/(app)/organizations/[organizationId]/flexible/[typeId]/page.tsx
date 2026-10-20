import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/ids';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { CategoryGrid, type CategoryRecord } from '@/components/shell/category-grid';
import { ViewHeader } from '@/components/shell/view-header';
import { Button } from '@/components/ui/button';
import { FlexibleRecordForm } from '@/components/flexible-record-form';
import { schemaToFields, type FieldDef } from '@/lib/flexible/fields';
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
  if (!isUuid(organizationId) || !isUuid(typeId)) notFound();
  const identity = await getServerIdentity();

  const data = await withTenant(actorOf(identity), async (tx) => {
    const [org] = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM organization WHERE id = ${organizationId}::uuid
    `;
    if (!org) return null;

    /*
     * The type AND its current published schema, because the "+ New" button is
     * a form over that schema rather than a link to one. Read in the same query
     * so there is no window in which the page offers fields from a version that
     * has since been superseded.
     *
     * The LEFT JOIN is not defensive dressing: current_version_id is ON DELETE
     * SET NULL, so a type whose only version was a deleted draft genuinely has
     * no schema, and its records (if any predate that) still have to list.
     */
    const [type] = await tx<{
      id: string; name: string; description: string | null;
      json_schema: unknown; ui_schema: unknown;
    }[]>`
      SELECT t.id, t.name, t.description, v.json_schema, v.ui_schema
      FROM flexible_asset_type t
      LEFT JOIN flexible_asset_type_version v ON v.id = t.current_version_id
      WHERE t.id = ${typeId}::uuid AND t.is_active
    `;
    if (!type) return null;

    // For the create form's site picker. Read through RLS, so it can only ever
    // offer sites this actor may already see.
    const sites = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM site
      WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL AND archived_at IS NULL
      ORDER BY name
    `;

    const [rank] = await tx<{ rank: number }[]>`SELECT helm.current_role_rank() AS rank`;

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
      sites,
      // null, not [], when there is no published version: "nothing to fill in"
      // and "no template to fill in" are different answers and the button below
      // depends on which one it is.
      fields: type.json_schema === null
        ? null
        : schemaToFields(type.json_schema, type.ui_schema) satisfies FieldDef[],
      actorRoleRank: rank?.rank ?? 0,
      records: rows.map<CategoryRecord>((r) => ({
        id: r.id,
        name: r.name,
        href: `/assets/${r.id}`,
        type: r.status,
        ...(r.needs_migration ? { extra: 'Needs migration', flagged: true } : {}),
        internalOnly: r.is_internal_only,
        updatedAt: r.updated_at.toISOString(),
        updatedBy: r.updated_by_name,
        removeKind: 'node',
        permissions: { internalOnly: r.is_internal_only },
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
          canWrite && data.fields !== null ? (
            <FlexibleRecordForm
              type={{ id: data.type.id, name: data.type.name, fields: data.fields }}
              organizationId={organizationId}
              sites={data.sites}
              trigger={
                <Button variant="cta" size="sm">
                  + New
                </Button>
              }
            />
          ) : null
        }
      />
      <CategoryGrid
        records={data.records}
        total={data.records.length}
        categoryLabel={data.type.name}
        canWrite={canWrite}
        actorRoleRank={data.actorRoleRank}
        columnScope={`flexible:${typeId}`}
      />
    </>
  );
}
