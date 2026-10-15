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
 * NO POLLING. A bell that polls every thirty seconds is a query per user per
 * thirty seconds forever, on an on-premises box sized for an MSP's technicians,
 * to shave a few minutes off noticing something the fan-out itself takes up to
 * a minute to queue. The count refreshes on navigation, which is what people do.
 */
import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, ClipboardCheck, FileDown, KeyRound, Settings2, TriangleAlert } from 'lucide-react';
import { useDismissable } from '@/lib/ui/use-dismissable';
import { formatDateTime } from '@/lib/ui/format';
import type { NotificationKind } from '@/lib/notifications/kinds';

interface InboxItem {
  id: string;
  kind: NotificationKind;
  subject: string;
  href: string | null;
  organizationId: string | null;
  organizationName: string | null;
  occurredAt: string;
  read: boolean;
}

/** One icon per kind, so a glance distinguishes a reminder from a reveal. */
const KIND_ICON: Record<NotificationKind, typeof Bell> = {
  task_assigned: ClipboardCheck,
  task_due: ClipboardCheck,
  export_activity: FileDown,
  credential_access: KeyRound,
  expiring_soon: TriangleAlert,
  operations: Settings2,
};

export function NotificationBell({ unread }: { unread: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useDismissable(open, useCallback(() => setOpen(false), []), container, trigger);

  // The server's number until this component has changed it. `?? unread`
  // rather than initialising state from the prop, so a navigation that brings a
  // new count is not ignored by stale state.
  const shown = count ?? unread;

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;

    setFailed(false);
    try {
      const response = await fetch('/api/account/inbox', {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const body = (await response.json()) as { notifications?: InboxItem[]; unread?: number };
      const list = body.notifications ?? [];
      setItems(list);
      setCount(body.unread ?? 0);

      // Exactly what was shown, not everything. See the header.
      const unseen = list.filter((item) => !item.read).map((item) => item.id);
      if (unseen.length > 0) await markRead(unseen);
    } catch {
      setFailed(true);
    }
  }

  async function markRead(ids: string[]) {
    try {
      const response = await fetch('/api/account/inbox', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!response.ok) return;
      const body = (await response.json()) as { unread?: number };
      setCount(body.unread ?? 0);
      // Locally too, so the dots clear without a second fetch.
      setItems((current) => current?.map(
        (item) => (ids.includes(item.id) ? { ...item, read: true } : item),
      ) ?? null);
      /*
       * The shell's own count came from the server and is now wrong. Refreshing
       * is what keeps it right on the NEXT navigation rather than carrying a
       * stale number until something else happens to re-render the layout.
       */
      router.refresh();
    } catch {
      // A failed mark-read is not worth an error message: the rows are still
      // there, still unread, and the next open tries again.
    }
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
          className="absolute right-0 z-30 mt-1 w-80 overflow-hidden rounded-md border border-border bg-surface-raised shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-ink-faint">Notifications</span>
            <Link
              href="/account"
              onClick={() => setOpen(false)}
              className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            >
              Choose what appears here
            </Link>
          </div>

          {failed ? (
            <p role="alert" className="px-3 py-3 text-sm text-danger">
              Could not load your notifications.
            </p>
          ) : items === null ? (
            <p className="px-3 py-3 text-sm text-ink-faint">Loading…</p>
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
            <ul className="max-h-96 overflow-y-auto py-1">
              {items.map((item) => {
                const Icon = KIND_ICON[item.kind] ?? Bell;
                const body = (
                  <>
                    {!item.read && (
                      <span
                        aria-hidden
                        className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand"
                      />
                    )}
                    {item.read && <span aria-hidden className="mt-1.5 size-1.5 shrink-0" />}
                    <Icon className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-ink">{item.subject}</span>
                      <span className="block truncate text-xs text-ink-faint">
                        {item.organizationName ? `${item.organizationName} · ` : ''}
                        {formatDateTime(item.occurredAt)}
                      </span>
                    </span>
                  </>
                );

                return (
                  <li key={item.id}>
                    {item.href ? (
                      <Link
                        href={item.href}
                        role="menuitem"
                        onClick={() => setOpen(false)}
                        className="flex items-start gap-2 px-3 py-2 text-sm hover:bg-surface-sunken"
                      >
                        {body}
                      </Link>
                    ) : (
                      // Nowhere to go, so not a link. A menuitem that navigates
                      // nowhere is worse than plain text.
                      <div className="flex items-start gap-2 px-3 py-2 text-sm">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
