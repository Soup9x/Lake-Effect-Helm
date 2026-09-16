import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Every field is optional, but at least one must be present.
 *
 * A PATCH with an empty body is almost always a bug in the caller rather than a
 * request to change nothing, and answering 200 to it hides that. `.refine`
 * turns it into a 400 that says which field was expected.
 */
const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(SLUG, 'slug must be lowercase letters, digits and hyphens, 2-63 characters')
      .optional(),
    legalName: z.string().trim().max(200).nullable().optional(),
    status: z
      .enum(['prospect', 'onboarding', 'active', 'co_managed', 'offboarding', 'former'])
      .optional(),
    industry: z.string().trim().max(120).nullable().optional(),
    website: z.string().trim().url('website must be a URL').max(500).nullable().optional(),
    timezone: z.string().trim().max(64).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

/**
 * PATCH /api/organizations/[organizationId] — rename or re-describe a client.
 *
 * `is_msp_internal` is not settable here for the same reason it is not settable
 * on create: exactly one organization per tenant is the MSP itself, and
 * promoting or demoting one silently changes what "internal" means everywhere
 * it is read.
 *
 * There is no `WHERE tenant_id = …` below and that is not an oversight. The
 * row is reachable only if `organization`'s RLS policy says this actor may
 * reach it, so an id belonging to another tenant matches zero rows and returns
 * the same "no such client" an id that never existed returns. Adding the
 * predicate would imply the policy were optional.
 */
export const PATCH = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const organizationId = z.guid().safeParse(params.organizationId);
    if (!organizationId.success) throw ApiError.invalid('not an organization id');

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid changes', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    if (body.slug !== undefined) {
      const [clash] = await tx<{ id: string }[]>`
        SELECT id FROM organization
        WHERE slug = ${body.slug} AND id <> ${organizationId.data}::uuid AND deleted_at IS NULL
      `;
      if (clash) throw ApiError.conflict(`a client with the slug "${body.slug}" already exists`);
    }

    // COALESCE so an absent field keeps its value, while an explicit null on a
    // nullable field clears it. The two are different requests and the caller
    // means different things by them.
    let updated: { id: string; slug: string; name: string; status: string } | undefined;
    try {
      [updated] = await tx<{ id: string; slug: string; name: string; status: string }[]>`
        UPDATE organization SET
          name       = COALESCE(${body.name ?? null}, name),
          slug       = COALESCE(${body.slug ?? null}, slug),
          legal_name = ${body.legalName === undefined ? tx`legal_name` : body.legalName},
          status     = COALESCE(${body.status ?? null}::organization_status, status),
          industry   = ${body.industry === undefined ? tx`industry` : body.industry},
          website    = ${body.website === undefined ? tx`website` : body.website},
          timezone   = COALESCE(${body.timezone ?? null}, timezone),
          updated_at = now(),
          updated_by = ${identity.actorId}::uuid
        WHERE id = ${organizationId.data}::uuid AND deleted_at IS NULL
        RETURNING id, slug, name, status::text AS status
      `;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') {
        throw ApiError.conflict(`a client with the slug "${body.slug}" already exists`);
      }
      throw error;
    }

    if (!updated) throw ApiError.invalid('no such client');

    return {
      organization: {
        id: updated.id,
        slug: updated.slug,
        name: updated.name,
        status: updated.status,
      },
    };
  },
  { permissions: ['organization:write'] },
);

export const dynamic = 'force-dynamic';
