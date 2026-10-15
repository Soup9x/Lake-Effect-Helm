import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { readHealthSetting, writeHealthSetting } from '@/lib/health/queries';
import { HEALTH_DAYS_MAX, HEALTH_DAYS_MIN } from '@/lib/health/window';

/**
 * How long a record may go unrevised, and unopened, before it is worth saying so.
 *
 * GATED ON tenant:write, the same permission the RLS policies on
 * documentation_health_setting name, so the route and the database cannot come
 * to disagree about who may move the line. Turning this dial changes what every
 * client's health reads as, which is a tenant-wide decision whatever the person
 * doing it thinks they are adjusting.
 *
 * GET IS NOT GATED. The ring renders for every role, and a ring whose window
 * the reader cannot discover is a number with no units — "11 records are stale"
 * means nothing without "stale after 180 days" beside it.
 *
 * SEPARATE FROM PATCH /api/tenant, for the reason that route's header gives and
 * 0620 made a rule: `settings` is a jsonb bag, a generic patch endpoint
 * overwrites invariants it never knew about, and a feature with bounds of its
 * own gets a route with those bounds on it.
 *
 * TWO WINDOWS, because they answer different questions — see
 * src/lib/health/window.ts. Both are required rather than optional: a PUT that
 * silently kept the other value would make the form's second field look
 * ignored, and this is a form with exactly two fields.
 */
const schema = z.object({
  staleAfterDays: z.number().int().min(HEALTH_DAYS_MIN).max(HEALTH_DAYS_MAX),
  unviewedAfterDays: z.number().int().min(HEALTH_DAYS_MIN).max(HEALTH_DAYS_MAX),
});

export const GET = tenantRoute(async ({ tx }) => readHealthSetting(tx));

export const PUT = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid(
          `two windows in days, each between ${HEALTH_DAYS_MIN} and ${HEALTH_DAYS_MAX}`,
          {
            issues: result.error.issues.map(
              (i) => ({ path: i.path.join('.'), message: i.message }),
            ),
          },
        );
      }
      return result.data;
    });

    return writeHealthSetting(tx, body, identity.actorId);
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
