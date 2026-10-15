import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { getTenantSidebarDefault, setTenantSidebarDefault } from '@/lib/nav/sidebar-queries';
import { SIDEBAR_MAX, SIDEBAR_SLUGS } from '@/lib/nav/sidebar-layout';

/**
 * The drawer layout a user starts with.
 *
 * GATED ON tenant:write, which only super_admin holds — the seed excludes
 * tier3 from it explicitly, alongside organization:delete and key:rotate. That
 * is the existing permission for tenant-wide configuration and no new one is
 * introduced here; the RLS policies on tenant_sidebar_default name the same
 * permission, so the route and the database cannot come to disagree about who
 * may set everybody's drawer.
 *
 * SEPARATE FROM PATCH /api/tenant, deliberately. That route's header explains
 * why `settings` is not settable through it: a generic "patch the settings
 * object" endpoint is how one feature's invariant gets overwritten by a caller
 * that never knew it existed. A layout with a validator of its own gets a
 * table and a route of its own.
 *
 * GET is NOT gated, because the drawer renders from this for every role. It
 * returns the shipped default when no row exists, so a caller cannot tell
 * whether an administrator has set one — hasTenantSidebarDefault() answers that
 * for the settings screen, which already holds tenant:write.
 */
const schema = z.object({
  categories: z
    .array(z.enum(SIDEBAR_SLUGS as [string, ...string[]]))
    .max(SIDEBAR_MAX)
    .refine((list) => new Set(list).size === list.length, {
      message: 'a category cannot appear twice',
    }),
});

export const GET = tenantRoute(async ({ tx }) => ({
  categories: await getTenantSidebarDefault(tx),
}));

export const PUT = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('a layout of known category slugs', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });

    return {
      categories: await setTenantSidebarDefault(tx, body.categories, identity.actorId),
    };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
