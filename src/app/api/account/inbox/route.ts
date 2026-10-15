import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { clearRead, listInbox, markRead, unreadCount } from '@/lib/notifications/inbox';

/**
 * My bell.
 *
 * NOT GATED ON ANY PERMISSION, and that is the design rather than an omission —
 * the same reasoning as /api/account/notifications. RLS on user_notification
 * admits only rows where `user_id = helm.current_actor_id()`, so the policy IS
 * the authorisation and there is no permission that could sensibly be asked
 * for. A client read-only user assigned a checklist step has a bell for it.
 *
 * WHICH ALSO MEANS AN ADMINISTRATOR CANNOT READ SOMEBODY ELSE'S, and 0700
 * deliberately gave this table no `audit:read` carve-out at all — unlike
 * task_reminder, which has one for a tenant-wide seat. What somebody has and
 * has not read is a record of their attention, and the oversight material
 * itself is in the audit log, where anybody holding the permission can read it
 * without reading somebody's unread count.
 *
 * THE COUNT IS NOT HERE. The shell renders it on every navigation, so it comes
 * from the layout's own transaction rather than from a fetch — a round trip per
 * page load for a number in the corner is a cost paid continuously.
 */
const schema = z.object({
  /**
   * Which to mark read. ABSENT means all of them, which is the "mark all read"
   * button; an EMPTY ARRAY means none, and is a different answer. Optional
   * rather than defaulted so those two stay distinguishable — the same
   * distinction 0690's preference array had to keep.
   */
  ids: z.array(z.guid()).max(200).optional(),
});

export const GET = tenantRoute(async ({ tx }) => ({
  notifications: await listInbox(tx, 20),
  unread: await unreadCount(tx),
}));

export const PUT = tenantRoute(async ({ tx, request }) => {
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid('a list of notification ids, or nothing for all of them', {
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  });

  const marked = await markRead(tx, body.ids);
  return { marked, unread: await unreadCount(tx) };
});

/**
 * Empty the read ones.
 *
 * Offered because a bell nobody can empty becomes a list people stop looking
 * at. Only the read ones: deleting something unseen would delete the thing the
 * table exists for, and 0700's retention sweep already keeps unread rows far
 * longer than read ones for the same reason.
 */
export const DELETE = tenantRoute(async ({ tx }) => ({
  cleared: await clearRead(tx),
  unread: await unreadCount(tx),
}));

export const dynamic = 'force-dynamic';
