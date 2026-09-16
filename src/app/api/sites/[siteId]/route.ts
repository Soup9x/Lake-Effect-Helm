import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    code: z.string().trim().max(40).nullable().optional(),
    isPrimary: z.boolean().optional(),
    addressLine1: z.string().trim().max(200).nullable().optional(),
    addressLine2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    region: z.string().trim().max(120).nullable().optional(),
    postalCode: z.string().trim().max(32).nullable().optional(),
    country: z.string().trim().min(2).max(2).optional(),
    timezone: z.string().trim().max(64).nullable().optional(),
    mainPhone: z.string().trim().max(40).nullable().optional(),
    afterHoursPhone: z.string().trim().max(40).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

/**
 * PATCH /api/sites/[siteId] — rename or re-describe a location.
 *
 * Promoting a site to primary demotes the client's other sites in the same
 * transaction, exactly as creation does. Demoting one (`isPrimary: false`) is
 * allowed and deliberately leaves the client with no primary site: "which of
 * these is the head office" is a question the MSP answers, and refusing to
 * clear the flag would mean the only way to change the answer is to pick a new
 * one first.
 */
export const PATCH = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const siteId = z.guid().safeParse(params.siteId);
    if (!siteId.success) throw ApiError.invalid('not a site id');

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid changes', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    if (body.isPrimary === true) {
      // Scoped to this site's own organization, read through RLS — so a site
      // the actor cannot reach demotes nothing.
      await tx`
        UPDATE site SET is_primary = false, updated_at = now(), updated_by = ${identity.actorId}::uuid
        WHERE organization_id = (SELECT organization_id FROM site WHERE id = ${siteId.data}::uuid)
          AND id <> ${siteId.data}::uuid
          AND is_primary
          AND deleted_at IS NULL
      `;
    }

    const [updated] = await tx<{ id: string; name: string; is_primary: boolean }[]>`
      UPDATE site SET
        name              = COALESCE(${body.name ?? null}, name),
        code              = ${body.code === undefined ? tx`code` : body.code},
        is_primary        = COALESCE(${body.isPrimary ?? null}, is_primary),
        address_line1     = ${body.addressLine1 === undefined ? tx`address_line1` : body.addressLine1},
        address_line2     = ${body.addressLine2 === undefined ? tx`address_line2` : body.addressLine2},
        city              = ${body.city === undefined ? tx`city` : body.city},
        region            = ${body.region === undefined ? tx`region` : body.region},
        postal_code       = ${body.postalCode === undefined ? tx`postal_code` : body.postalCode},
        country           = COALESCE(${body.country ? body.country.toUpperCase() : null}, country),
        timezone          = ${body.timezone === undefined ? tx`timezone` : body.timezone},
        main_phone        = ${body.mainPhone === undefined ? tx`main_phone` : body.mainPhone},
        after_hours_phone = ${body.afterHoursPhone === undefined ? tx`after_hours_phone` : body.afterHoursPhone},
        updated_at        = now(),
        updated_by        = ${identity.actorId}::uuid
      WHERE id = ${siteId.data}::uuid AND deleted_at IS NULL
      RETURNING id, name, is_primary
    `;

    if (!updated) throw ApiError.invalid('no such site');

    return { site: { id: updated.id, name: updated.name, isPrimary: updated.is_primary } };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
