import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

const createSchema = z.object({
  organizationId: z.guid('organizationId must be a UUID'),
  name: z.string().trim().min(1).max(200),
  /** Short label a technician says out loud — "BUF-HQ". */
  code: z.string().trim().max(40).optional(),
  isPrimary: z.boolean().default(false),
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  region: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(32).optional(),
  country: z.string().trim().min(2).max(2).default('US'),
  timezone: z.string().trim().max(64).optional(),
  mainPhone: z.string().trim().max(40).optional(),
  afterHoursPhone: z.string().trim().max(40).optional(),
});

interface SiteRow {
  id: string;
  name: string;
  code: string | null;
  is_primary: boolean;
  city: string | null;
  region: string | null;
}

/** GET /api/sites?organizationId=… — the sites of one client. */
export const GET = tenantRoute(
  async ({ tx, request }) => {
    const organizationId = new URL(request.url).searchParams.get('organizationId');
    if (!organizationId || !z.guid().safeParse(organizationId).success) {
      throw ApiError.invalid('organizationId must be a UUID');
    }

    const rows = await tx<SiteRow[]>`
      SELECT id, name, code, is_primary, city, region
      FROM site
      WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
      ORDER BY is_primary DESC, name
    `;

    return {
      sites: rows.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        isPrimary: r.is_primary,
        city: r.city,
        region: r.region,
      })),
    };
  },
  { permissions: ['asset:read'] },
);

/**
 * POST /api/sites — add a location to a client.
 *
 * `is_primary` is a claim about the client, not about this row: at most one
 * site should carry it. Rather than trusting the caller to know that, setting
 * it here clears the flag from every other site of the same organization in the
 * same transaction. The alternative — a partial unique index — would reject the
 * second write with a constraint violation and leave the technician to work out
 * which existing site to demote first.
 *
 * The organization is not re-checked in the application. An id from another
 * tenant, or one this actor cannot reach, fails the composite foreign key
 * against `organization (id, tenant_id)`, because the tenant in that key comes
 * from the session.
 */
export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid site', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    if (body.isPrimary) {
      await tx`
        UPDATE site SET is_primary = false, updated_at = now(), updated_by = ${identity.actorId}::uuid
        WHERE organization_id = ${body.organizationId}::uuid AND is_primary AND deleted_at IS NULL
      `;
    }

    let created: { id: string; name: string } | undefined;
    try {
      [created] = await tx<{ id: string; name: string }[]>`
        INSERT INTO site (
          tenant_id, organization_id, name, code, is_primary,
          address_line1, address_line2, city, region, postal_code, country,
          timezone, main_phone, after_hours_phone, created_by, updated_by
        )
        VALUES (
          ${identity.tenantId}::uuid, ${body.organizationId}::uuid, ${body.name},
          ${body.code ?? null}, ${body.isPrimary},
          ${body.addressLine1 ?? null}, ${body.addressLine2 ?? null},
          ${body.city ?? null}, ${body.region ?? null}, ${body.postalCode ?? null},
          ${body.country.toUpperCase()}, ${body.timezone ?? null},
          ${body.mainPhone ?? null}, ${body.afterHoursPhone ?? null},
          ${identity.actorId}::uuid, ${identity.actorId}::uuid
        )
        RETURNING id, name
      `;
    } catch (error) {
      // 23503 foreign_key_violation: the organization is not one this actor can
      // reach, or does not exist. Same answer either way, deliberately.
      if ((error as { code?: string }).code === '23503') {
        throw ApiError.invalid('no such client');
      }
      throw error;
    }
    if (!created) throw ApiError.conflict('the site could not be created');

    return { site: { id: created.id, name: created.name, isPrimary: body.isPrimary } };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
