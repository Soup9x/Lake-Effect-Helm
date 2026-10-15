/**
 * The bell.
 *
 * EVERY QUERY HERE IS SCOPED BY RLS AND NOT BY THIS FILE, and none of them
 * takes a user id. user_notification admits only rows where
 * `user_id = helm.current_actor_id()`, so "read somebody else's bell" is
 * unexpressible rather than merely unauthorised — the same rule
 * src/lib/workspace/queries.ts states for favourites and recents, and the one
 * 0700's guard 3 asserts on the policy's text.
 *
 * THE COUNT AND THE LIST ARE SEPARATE ON PURPOSE. The count is rendered in the
 * shell on every navigation and comes from a partial index; the list is fetched
 * when somebody opens the popover. /api/workspace/recent made the same split in
 * 0370, for the same reason: a query per page load to populate a control most
 * people will not touch is a cost paid continuously for a benefit taken
 * occasionally.
 *
 * MARKING READ IS AN UPDATE THE REQUEST PATH MAKES ITSELF, and the only column
 * it can touch is `read_at` — a column grant, because RLS cannot restrict a
 * column and rewriting the subject of a notification about an export would be
 * putting words in Helm's mouth.
 */
import type { HelmTx } from '../db/client';
import type { NotificationKind } from './kinds';

export interface InboxItem {
  id: string;
  kind: NotificationKind;
  subject: string;
  /** A relative path, or null for something with nowhere to go. */
  href: string | null;
  organizationId: string | null;
  organizationName: string | null;
  occurredAt: string;
  read: boolean;
}

interface InboxRow {
  id: string;
  kind: NotificationKind;
  subject: string;
  href: string | null;
  organization_id: string | null;
  organization_name: string | null;
  occurred_at: Date;
  read_at: Date | null;
}

/** How many of this person's notifications are unread. */
export async function unreadCount(tx: HelmTx): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    SELECT helm.unread_notification_count() AS n
  `;
  return Number(row?.n ?? 0);
}

export async function listInbox(tx: HelmTx, limit = 20): Promise<InboxItem[]> {
  const rows = await tx<InboxRow[]>`SELECT * FROM helm.my_notifications(${limit})`;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    href: row.href,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    occurredAt: row.occurred_at.toISOString(),
    // A boolean, not the timestamp. WHEN somebody read something is a fact
    // about their attention and the screen has no use for it; the bell only
    // needs to know whether to show the dot.
    read: row.read_at !== null,
  }));
}

/**
 * Mark some, or all, of this person's notifications read.
 *
 * `ids` absent means everything — the "mark all read" button — and an empty
 * array means nothing, which is a different thing and is why the parameter is
 * optional rather than defaulted to `[]`. Same distinction 0690's preference
 * array had to keep.
 *
 * Returns how many rows changed. A zero is not an error: re-reading something
 * already read is idempotent, and a notification that has since been pruned is
 * simply gone.
 */
export async function markRead(tx: HelmTx, ids?: readonly string[]): Promise<number> {
  if (ids !== undefined && ids.length === 0) return 0;

  // `read_at IS NULL` in the predicate keeps the first-read time rather than
  // moving it on every page load, and means the row count is "how many were
  // actually unread" instead of "how many matched".
  const rows = ids === undefined
    ? await tx<{ id: string }[]>`
        UPDATE user_notification SET read_at = now()
        WHERE tenant_id = helm.current_tenant_id()
          AND user_id = helm.current_actor_id()
          AND read_at IS NULL
        RETURNING id
      `
    : await tx<{ id: string }[]>`
        UPDATE user_notification SET read_at = now()
        WHERE tenant_id = helm.current_tenant_id()
          AND user_id = helm.current_actor_id()
          AND read_at IS NULL
          AND id = ANY (${ids as string[]}::uuid[])
        RETURNING id
      `;
  return rows.length;
}

/**
 * Remove notifications this person no longer wants to see.
 *
 * The owner's own row, so an ordinary DELETE under the policy rather than a
 * definer function. Deleting is offered as well as marking read because a bell
 * nobody can empty becomes a list people stop looking at — and the record of
 * what happened lives in the audit log, which this never touches.
 */
export async function clearRead(tx: HelmTx): Promise<number> {
  const rows = await tx<{ id: string }[]>`
    DELETE FROM user_notification
    WHERE tenant_id = helm.current_tenant_id()
      AND user_id = helm.current_actor_id()
      AND read_at IS NOT NULL
    RETURNING id
  `;
  return rows.length;
}
