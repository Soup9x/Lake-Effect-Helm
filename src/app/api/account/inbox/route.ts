import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { clearRead, dismiss, listInbox, markRead, unreadCount } from '@/lib/notifications/inbox';

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

/**
 * What a clear removes. NO BODY AT ALL is the original meaning — the read ones —
 * so the bell's older callers keep working; `ids` dismisses exactly those, read
 * or not; `all` empties the inbox.
 */
const clearSchema = z.union([
  z.object({ ids: z.array(z.guid()).max(200) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
  z.object({ read: z.literal(true) }).strict(),
]);

/** The longest list one GET returns. The retention sweep keeps far fewer. */
const MAX_LIMIT = 200;

export const GET = tenantRoute(async ({ tx, request }) => {
  const asked = Number(new URL(request.url).searchParams.get('limit') ?? 20);
  const limit = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), MAX_LIMIT) : 20;
  // One more than asked, so the screen knows whether "Show more" has anything
  // behind it without a count query.
  const rows = await listInbox(tx, limit + 1);
  return {
    notifications: rows.slice(0, limit),
    more: rows.length > limit,
    unread: await unreadCount(tx),
  };
});

export const PUT = tenantRoute(async ({ tx, request }) => {
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid('a list of notification ids, or nothing for all of them', {
        issues: zodIssues(result.error),
      });
    }
    return result.data;
  });

  const marked = await markRead(tx, body.ids);
  return { marked, unread: await unreadCount(tx) };
});

/**
 * Clear notifications.
 *
 * Offered because a bell nobody can empty becomes a list people stop looking
 * at. With no body, only the read ones go: deleting something unseen by
 * accident would delete the thing the table exists for. Dismissing named rows,
 * or everything, is an explicit choice made on screen, so those take unread
 * rows too.
 */
export const DELETE = tenantRoute(async ({ tx, request }) => {
  const body = request.body === null
    ? { read: true as const }
    : await readJson(request, (raw) => {
      const result = clearSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('a list of notification ids, or { all: true }', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });

  const cleared = 'ids' in body
    ? await dismiss(tx, body.ids)
    : 'all' in body ? await dismiss(tx) : await clearRead(tx);
  return { cleared, unread: await unreadCount(tx) };
});

export const dynamic = 'force-dynamic';
