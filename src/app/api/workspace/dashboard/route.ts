import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { clearLayout, getLayout, setLayout } from '@/lib/workspace/queries';
import { layoutSchema } from '@/lib/workspace/layout-schema';

/**
 * Which widgets somebody wants, in what order, and which span the full row.
 *
 * The enum is validated here AND by a CHECK constraint calling
 * helm.dashboard_layout_valid(). Two layers for one rule is worth it: this one
 * produces a message naming the offending key, and the constraint is what makes
 * a bad layout unstorable by any path — including a future route, a script, or
 * somebody at a psql prompt.
 *
 * DELETE forgets the personal arrangement, so the team default (1230) applies
 * again.
 */
export const GET = tenantRoute(async ({ tx }) => getLayout(tx));

export const PUT = tenantRoute(async ({ tx, request }) => {
  const body = await readJson(request, (raw) => {
    const result = layoutSchema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid('a layout of known widget keys', {
        issues: zodIssues(result.error),
      });
    }
    return result.data;
  });

  // `wide` left out: keep whatever this person had, rather than resetting
  // every width because an older client did not know about them.
  const wide = body.wide ?? (await getLayout(tx)).wide;
  return setLayout(tx, { widgets: body.widgets, wide });
});

export const DELETE = tenantRoute(async ({ tx }) => clearLayout(tx));

export const dynamic = 'force-dynamic';
