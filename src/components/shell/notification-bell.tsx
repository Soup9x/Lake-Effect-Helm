'use client';

/**
 * The bell.
 *
 * THE COUNT COMES FROM THE SERVER, THE LIST COMES FROM A FETCH. The badge is
 * rendered by the shell on every navigation — a badge that only appears once
 * somebody clicks the thing it is meant to draw them to is not a badge — while
 * the list is fetched on open, which is the split /api/workspace/recent chose
 * in 0370 and for the same reason.
 *
 * AND THE COUNT IS A PROP, NOT STATE, until something changes it. Marking
 * things read is the only thing here that can change it, so the local override
 * exists to make that immediate rather than waiting for a refresh; everything
 * else that could change it arrives with the next navigation, because the shell
 * re-renders.
 *
 * READ ON OPEN IS DELIBERATE, AND IT IS NOT "read everything". Opening the bell
 * marks read exactly the rows it just showed — which is what somebody means by
 * opening it — rather than every unread row, because an inbox with forty
 * unread and twenty shown should not quietly lose the other twenty.
 *
 * EVERY ROW CAN BE CLEARED, AND SO CAN ALL OF THEM. The state and the actions
 * live in useInbox, shared with the Personal page's card, which is the place to
 * see more than the twenty this shows.
 *
 * NO POLLING. A bell that polls every thirty seconds is a query per user per
 * thirty seconds forever, on an on-premises box sized for an MSP's technicians,
 * to shave a few minutes off noticing something the fan-out itself takes up to
 * a minute to queue. The count refreshes on navigation, which is what people do.
 */
import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useDismissable } from '@/lib/ui/use-dismissable';
import { useInbox } from '@/components/notifications/use-inbox';
import { InboxRows, InboxToolbar } from '@/components/notifications/inbox-list';

export function NotificationBell({ unread }: { unread: number }) {
  const [open, setOpen] = useState(false);
  const inbox = useInbox({ items: null, unread: null });
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useDismissable(open, useCallback(() => setOpen(false), []), container, trigger);

  // The server's number until this component has changed it. `?? unread`
  // rather than initialising state from the prop, so a navigation that brings a
  // new count is not ignored by stale state.
  const shown = inbox.unread ?? unread;
  const items = inbox.items;

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;

    const list = await inbox.load(20);
    if (list === null) return;

    // Exactly what was shown, not everything. See the header.
    const unseen = list.filter((item) => !item.read).map((item) => item.id);
    if (unseen.length > 0) await inbox.markRead(unseen, true);
  }

  return (
    <div className="relative" ref={container}>
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={shown > 0 ? `Notifications, ${shown} unread` : 'Notifications'}
        title="Notifications"
        className="relative flex size-8 items-center justify-center rounded-md text-nav-ink transition-colors hover:bg-white/10 hover:text-nav-ink-active"
      >
        <Bell className="size-4" aria-hidden />
        {shown > 0 && (
          /*
           * The number, not a dot. "Three things happened" and "something
           * happened" are different pieces of information, and a technician
           * deciding whether to look now wants the first. Capped at 99+ so the
           * badge cannot grow wide enough to push the bar around.
           */
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-on-danger"
          >
            {shown > 99 ? '99+' : shown}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          className="absolute right-0 z-30 mt-1 w-96 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-border bg-surface-raised shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-ink-faint">Notifications</span>
            <InboxToolbar
              unread={shown}
              total={items?.length ?? 0}
              busy={inbox.busy}
              onMarkAllRead={() => void inbox.markRead()}
              onClearAll={() => void inbox.dismiss()}
            />
          </div>

          {inbox.failed && (
            <p role="alert" className="px-3 py-2 text-sm text-danger">{inbox.failed}</p>
          )}
          {items === null ? (
            !inbox.failed && <p className="px-3 py-3 text-sm text-ink-faint">Loading…</p>
          ) : items.length === 0 ? (
            /*
             * THE EMPTY STATE SAYS WHICH EMPTY IT IS. "Nothing here" could mean
             * nothing happened or nothing is subscribed, and those have
             * different answers — the oversight kinds are off until somebody
             * asks for them, so a quiet bell is the shipped state rather than a
             * fault. A bell that cannot be told apart from an empty inbox is
             * the thing the parity plan warned about.
             */
            <div className="px-3 py-3 text-sm text-ink-muted">
              Nothing to show.
              <span className="mt-1 block text-xs text-ink-faint">
                You are told when a checklist step is assigned to you or falls due.
                Exports, credential reveals and expiries are off until you ask for
                them on your account page.
              </span>
            </div>
          ) : (
            /*
             * Capped by the viewport as well as by 24rem, so on a short window
             * the list scrolls inside the popover instead of running off the
             * bottom of the screen where nothing can reach it.
             */
            <InboxRows
              menu
              items={items}
              busy={inbox.busy}
              onMarkRead={(id) => void inbox.markRead([id])}
              onDismiss={(id) => void inbox.dismiss([id])}
              onNavigate={() => setOpen(false)}
              className="max-h-[min(24rem,calc(100vh-10rem))] overflow-y-auto overscroll-contain py-1"
            />
          )}

          <div className="flex items-center justify-between border-t border-border px-3 py-2">
            <Link
              href="/personal#notifications"
              onClick={() => setOpen(false)}
              className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            >
              See all
            </Link>
            <Link
              href="/account"
              onClick={() => setOpen(false)}
              className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            >
              Choose what appears here
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
