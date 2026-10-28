'use client';

/**
 * The Personal page's notifications card: the whole inbox, not a teaser of it.
 *
 * IT SCROLLS INSIDE THE CARD. The card shares a row with My tasks, so a list
 * that grew the card would push everything below it down the page; a fixed
 * height with its own scroll keeps the page's layout and still shows every row.
 *
 * NOTHING IS MARKED READ BY OPENING THIS PAGE. The bell does that because
 * opening it is the act of looking; arriving here may be on the way to My
 * passwords. Reading is the per-row tick, following the link, or Mark all read.
 */
import { useState } from 'react';
import { InboxRows, InboxToolbar } from './inbox-list';
import { useInbox, type InboxItem } from './use-inbox';

/** How many rows "Show more" adds each time. */
const PAGE = 50;

export function NotificationCenter({
  initial, unread, more,
}: {
  initial: InboxItem[];
  unread: number;
  more: boolean;
}) {
  const inbox = useInbox({ items: initial, unread, more });
  const [limit, setLimit] = useState(Math.max(initial.length, PAGE));
  const items = inbox.items ?? [];

  async function showMore() {
    const next = limit + PAGE;
    if (await inbox.load(next)) setLimit(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <InboxToolbar
          unread={inbox.unread ?? 0}
          total={items.length}
          busy={inbox.busy}
          onMarkAllRead={() => void inbox.markRead()}
          onClearAll={() => void inbox.dismiss()}
        />
      </div>

      {inbox.failed && <p role="alert" className="text-sm text-danger">{inbox.failed}</p>}

      {items.length === 0 ? (
        /*
         * SAYS WHICH EMPTY IT IS, like the bell itself. "Nothing here" could
         * mean nothing happened or nothing is subscribed, and those have
         * different answers — the oversight kinds are off until somebody asks
         * for them, so a quiet page is the shipped state rather than a fault.
         */
        <p className="text-sm text-ink-muted">
          Nothing yet. You are told when a checklist step is assigned to you
          or falls due; exports, credential reveals and expiries are off
          until you ask for them below.
        </p>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto overscroll-contain rounded-md border border-border">
          <InboxRows
            items={items}
            busy={inbox.busy}
            onMarkRead={(id) => void inbox.markRead([id])}
            onDismiss={(id) => void inbox.dismiss([id])}
            className="divide-y divide-border"
          />
          {inbox.more && (
            <div className="border-t border-border p-2 text-center">
              <button
                type="button"
                disabled={inbox.busy}
                onClick={() => void showMore()}
                className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
              >
                Show more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
