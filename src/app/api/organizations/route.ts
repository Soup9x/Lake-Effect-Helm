import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

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

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** URL-safe identifier, unique within the tenant. */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG, 'slug must be lowercase letters, digits and hyphens, 2-63 characters'),
  legalName: z.string().trim().max(200).optional(),
  status: z
    .enum(['prospect', 'onboarding', 'active', 'co_managed', 'offboarding', 'former'])
    .default('active'),
  industry: z.string().trim().max(120).optional(),
  website: z.string().trim().url('website must be a URL').max(500).optional(),
  timezone: z.string().trim().max(64).default('America/New_York'),
});

/**
 * POST /api/organizations — add a client.
 *
 * `is_msp_internal` is deliberately NOT settable. Exactly one organization per
 * tenant represents the MSP itself, it is created by bootstrap, and a second
 * one would quietly change what "internal" means everywhere it is read —
 * including which credentials an offboarding export treats as the MSP's own.
 *
 * The tenant comes from the session, never from the body. A tenant_id in the
 * request would be a cross-tenant write waiting for its first typo; RLS would
 * refuse it, but the API should not offer the shape at all.
 */
export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid organization', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    // organization_slug_uk is UNIQUE (tenant_id, slug). Asking first turns the
    // common mistake into a message instead of a constraint violation; the
    // constraint is still what guarantees it, and the insert below is still
    // wrapped in case two requests race between the check and the write.
    const [clash] = await tx<{ id: string }[]>`
      SELECT id FROM organization WHERE slug = ${body.slug} AND deleted_at IS NULL
    `;
    if (clash) throw ApiError.conflict(`a client with the slug "${body.slug}" already exists`);

    let created: { id: string; slug: string; name: string } | undefined;
    try {
      [created] = await tx<{ id: string; slug: string; name: string }[]>`
        INSERT INTO organization (
          tenant_id, slug, name, legal_name, status, industry, website, timezone, created_by
        )
        VALUES (
          ${identity.tenantId}::uuid, ${body.slug}, ${body.name},
          ${body.legalName ?? null}, ${body.status}::organization_status,
          ${body.industry ?? null}, ${body.website ?? null}, ${body.timezone},
          ${identity.actorId}::uuid
        )
        RETURNING id, slug, name
      `;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') {
        throw ApiError.conflict(`a client with the slug "${body.slug}" already exists`);
      }
      throw error;
    }
    if (!created) throw ApiError.conflict('the client could not be created');

    return {
      organization: {
        id: created.id,
        slug: created.slug,
        name: created.name,
        status: body.status,
        isMspInternal: false,
        siteCount: 0,
        assetCount: 0,
      },
    };
  },
  { permissions: ['organization:write'] },
);

export const dynamic = 'force-dynamic';
