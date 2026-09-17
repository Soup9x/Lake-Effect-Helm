import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    primaryDomain: z.string().trim().max(253).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

/**
 * PATCH /api/tenant — rename your own MSP.
 *
 * No migration was needed: `tenant_rls_update` has always existed and has
 * always been gated on `tenant:write`, a permission only `super_admin` holds —
 * `tier3` is explicitly excluded from it in the seed, along with
 * `organization:delete` and `key:rotate`. Nothing had ever exercised it.
 *
 * `slug` is not settable. It is the tenant's stable identifier: it is what
 * `membership` and every audit row resolve through, what a future multi-tenant
 * URL would carry, and it appears in nothing a rebrand should change. A name is
 * what people read; a slug is what the system holds onto.
 *
 * `settings` is not settable either. It is a jsonb bag other features read, and
 * a generic "patch the settings object" endpoint is how a feature's invariant
 * gets overwritten by a caller that did not know it existed.
 *
 * There is no `WHERE id = …`: the policy restricts this to the current tenant,
 * and adding the predicate would imply it were optional.
 */
export const PATCH = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid changes', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const [updated] = await tx<{ id: string; name: string; slug: string }[]>`
      UPDATE tenant SET
        name           = COALESCE(${body.name ?? null}, name),
        primary_domain = ${body.primaryDomain === undefined ? tx`primary_domain` : body.primaryDomain},
        updated_at     = now()
      RETURNING id, name, slug
    `;

    // The policy matched nothing, which for an UPDATE means the actor lacks
    // tenant:write. The route's own permission check would normally have caught
    // that; this covers the case where the two ever disagree.
    if (!updated) throw ApiError.forbidden('you cannot rename this tenant');

    return { tenant: { id: updated.id, name: updated.name, slug: updated.slug } };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
