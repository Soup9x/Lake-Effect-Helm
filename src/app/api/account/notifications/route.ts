import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { NOTIFICATION_KINDS } from '@/lib/notifications/kinds';
import { readMyNotificationKinds, writeMyNotificationKinds } from '@/lib/email/preferences';

/**
 * What I want to be emailed about.
 *
 * NOT GATED ON ANY PERMISSION, and that is the design rather than an omission.
 * This is the reader's own preference: RLS on user_notification_preference
 * admits only rows where `user_id = helm.current_actor_id()`, so the policy IS
 * the authorisation and there is no permission that could sensibly be asked
 * for. A client read-only user who is assigned a checklist step decides for
 * themselves whether to hear about it.
 *
 * WHICH ALSO MEANS AN ADMINISTRATOR CANNOT SET SOMEBODY ELSE'S. There is no
 * route for that and no policy that would allow one — same rule as
 * `user_sidebar` and `user_dashboard`, and for the stronger reason that what
 * somebody chooses to be told about says something about what they are paying
 * attention to.
 *
 * AN EMPTY ARRAY IS A REAL ANSWER. It means "nothing", not "use the default" —
 * if `[]` fell through to the shipped default, somebody who unticked both boxes
 * would watch the control appear to do nothing. 0690's table comment has the
 * same note, because the distinction has to survive in both places.
 */
const schema = z.object({
  kinds: z
    .array(z.enum(NOTIFICATION_KINDS as unknown as [string, ...string[]]))
    .max(NOTIFICATION_KINDS.length)
    .refine((list) => new Set(list).size === list.length, {
      message: 'a kind cannot appear twice',
    }),
});

export const GET = tenantRoute(async ({ tx }) => readMyNotificationKinds(tx));

export const PUT = tenantRoute(async ({ tx, request }) => {
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid('a list of known notification kinds', {
        issues: zodIssues(result.error),
      });
    }
    return result.data;
  });

  return writeMyNotificationKinds(tx, body.kinds);
});

export const dynamic = 'force-dynamic';
