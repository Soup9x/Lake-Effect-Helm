import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import {
  clearSidebarLayout, getSidebarLayout, setSidebarLayout,
} from '@/lib/nav/sidebar-queries';
import { SIDEBAR_MAX, SIDEBAR_SLUGS } from '@/lib/nav/sidebar-layout';

/**
 * My own drawer layout.
 *
 * The slug set is validated HERE and by a CHECK constraint calling
 * helm.sidebar_layout_valid(). Two layers for one rule is worth it, and 0370
 * made the same trade for the dashboard: this one answers 400 with the POSITION
 * in the submitted list and the set of legal slugs, which is what a control
 * sending a list can act on, while the constraint is what makes a bad layout
 * unstorable by any path — a future route, a script, or somebody at a psql
 * prompt. The constraint's own refusal is a 500 and says nothing useful, which
 * is exactly why the first layer is worth having.
 *
 * NO PERMISSION BEYOND BEING SIGNED IN. The layout is a property of the person,
 * not of the records: rearranging it reveals nothing, grants nothing, and a
 * client-side user has as much right to arrange their own drawer as a tier 3
 * engineer. RLS confines the row to its owner, so there is nothing a permission
 * would add here that the policy does not already guarantee.
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
  categories: await getSidebarLayout(tx),
}));

export const PUT = tenantRoute(async ({ tx, request }) => {
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid('a layout of known category slugs', {
        issues: zodIssues(result.error),
      });
    }
    return result.data;
  });

  return { categories: await setSidebarLayout(tx, body.categories) };
});

/**
 * DELETE — follow the tenant default again.
 *
 * Not "reset to the shipped default": it removes the row, so whatever an
 * administrator sets later applies. See clearSidebarLayout() for why that is a
 * different state from storing a copy of the default.
 */
export const DELETE = tenantRoute(async ({ tx }) => ({
  categories: await clearSidebarLayout(tx),
  following: 'tenant-default' as const,
}));

export const dynamic = 'force-dynamic';
