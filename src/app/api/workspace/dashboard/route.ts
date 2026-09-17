import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getLayout, setLayout } from '@/lib/workspace/queries';
import { WIDGET_KEYS } from '@/lib/workspace/widgets';

/**
 * Which widgets somebody wants, in what order.
 *
 * The enum is validated here AND by a CHECK constraint calling
 * helm.dashboard_layout_valid(). Two layers for one rule is worth it: this one
 * produces a message naming the offending key, and the constraint is what makes
 * a bad layout unstorable by any path — including a future route, a script, or
 * somebody at a psql prompt.
 */
const schema = z.object({
  widgets: z
    .array(z.enum(WIDGET_KEYS))
    .max(12)
    .refine((list) => new Set(list).size === list.length, {
      message: 'a widget cannot appear twice',
    }),
});

export const GET = tenantRoute(async ({ tx }) => ({ widgets: await getLayout(tx) }));

export const PUT = tenantRoute(async ({ tx, request }) => {
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid('a layout of known widget keys', {
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  });

  return { widgets: await setLayout(tx, body.widgets) };
});

export const dynamic = 'force-dynamic';
