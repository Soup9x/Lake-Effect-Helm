import { tenantRoute } from '@/lib/api/handler';

interface OrganizationRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  is_msp_internal: boolean;
  site_count: string;
  asset_count: string;
}

/**
 * GET /api/organizations
 *
 * Returns only what the actor's scope permits: an MSP technician sees every
 * client, a co-managed client administrator sees exactly one. No filter here
 * says so — `organization`'s RLS policy does.
 */
export const GET = tenantRoute(
  async ({ tx }) => {
    const rows = await tx<OrganizationRow[]>`
      SELECT
        o.id, o.slug, o.name, o.status::text AS status, o.is_msp_internal,
        (SELECT count(*)::text FROM site s
          WHERE s.organization_id = o.id AND s.deleted_at IS NULL) AS site_count,
        (SELECT count(*)::text FROM asset_node n
          WHERE n.organization_id = o.id AND n.archived_at IS NULL) AS asset_count
      FROM organization o
      WHERE o.deleted_at IS NULL
      ORDER BY o.is_msp_internal DESC, o.name
    `;

    return {
      organizations: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        status: row.status,
        isMspInternal: row.is_msp_internal,
        siteCount: Number(row.site_count),
        assetCount: Number(row.asset_count),
      })),
    };
  },
  { permissions: ['organization:read'] },
);

export const dynamic = 'force-dynamic';
