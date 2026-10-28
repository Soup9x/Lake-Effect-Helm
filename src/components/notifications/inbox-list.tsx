'use client';

/**
 * The rows of an inbox, with the two per-row actions, and the toolbar with the
 * two for everything. Rendered by the bell and by the Personal page.
 *
 * THE ACTIONS SIT BESIDE THE LINK, NOT INSIDE IT. A button inside an anchor is
 * invalid markup and, worse, a click on the cross would also navigate.
 */
import Link from 'next/link';
import { Bell, Check, CheckCheck, ClipboardCheck, FileDown, KeyRound, Settings2, Trash2, TriangleAlert, X } from 'lucide-react';
import { formatDateTime } from '@/lib/ui/format';
import { cn } from '@/lib/ui/cn';
import type { NotificationKind } from '@/lib/notifications/kinds';
import type { InboxItem } from './use-inbox';

/** One icon per kind, so a glance distinguishes a reminder from a reveal. */
const KIND_ICON: Record<NotificationKind, typeof Bell> = {
  task_assigned: ClipboardCheck,
  task_due: ClipboardCheck,
  export_activity: FileDown,
  credential_access: KeyRound,
  expiring_soon: TriangleAlert,
  operations: Settings2,
};

const ICON_BUTTON =
  'flex size-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors ' +
  'hover:bg-surface-sunken hover:text-ink disabled:pointer-events-none disabled:opacity-50';

export function InboxRows({
  items, busy, onMarkRead, onDismiss, onNavigate, menu = false, className,
}: {
  items: InboxItem[];
  busy: boolean;
  onMarkRead: (id: string) => void;
  onDismiss: (id: string) => void;
  onNavigate?: () => void;
  /** Inside the bell's popover, where the rows are menu items. */
  menu?: boolean;
  className?: string;
}) {
  return (
    <ul className={className}>
      {items.map((item) => {
        const Icon = KIND_ICON[item.kind] ?? Bell;
        const body = (
          <>
            <span
              aria-hidden
              className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', !item.read && 'bg-brand')}
            />
            <Icon className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
            <span className="min-w-0">
              <span className={cn('block', item.read ? 'text-ink-muted' : 'text-ink')}>
                {item.subject}
              </span>
              <span className="block truncate text-xs text-ink-faint">
                {item.organizationName ? `${item.organizationName} · ` : ''}
                {formatDateTime(item.occurredAt)}
              </span>
            </span>
          </>
        );

        return (
          <li key={item.id} className="group flex items-start gap-1 pr-2 hover:bg-surface-sunken">
            {item.href ? (
              <Link
                href={item.href}
                role={menu ? 'menuitem' : undefined}
                onClick={() => {
                  if (!item.read) onMarkRead(item.id);
                  onNavigate?.();
                }}
                className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-sm"
              >
                {body}
              </Link>
            ) : (
              // Nowhere to go, so not a link. A menuitem that navigates
              // nowhere is worse than plain text.
              <div className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-sm">{body}</div>
            )}
            <span className="flex shrink-0 items-center gap-0.5 pt-1.5">
              {!item.read && (
                <button
                  type="button"
                  className={ICON_BUTTON}
                  disabled={busy}
                  onClick={() => onMarkRead(item.id)}
                  aria-label={`Mark read: ${item.subject}`}
                  title="Mark read"
                >
                  <Check className="size-3.5" aria-hidden />
                </button>
              )}
              <button
                type="button"
                className={ICON_BUTTON}
                disabled={busy}
                onClick={() => onDismiss(item.id)}
                aria-label={`Clear: ${item.subject}`}
                title="Clear"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const TOOLBAR_BUTTON =
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ink-muted transition-colors ' +
  'hover:bg-surface-sunken hover:text-ink disabled:pointer-events-none disabled:opacity-50';

export function InboxToolbar({
  unread, total, busy, onMarkAllRead, onClearAll,
}: {
  unread: number;
  total: number;
  busy: boolean;
  onMarkAllRead: () => void;
  onClearAll: () => void;
}) {
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        className={TOOLBAR_BUTTON}
        disabled={busy || unread === 0}
        onClick={onMarkAllRead}
      >
        <CheckCheck className="size-3.5" aria-hidden /> Mark all read
      </button>
      <button
        type="button"
        className={TOOLBAR_BUTTON}
        disabled={busy || total === 0}
        onClick={() => {
          // Everything, unread included, and there is no undo.
          if (window.confirm('Clear all of your notifications? This cannot be undone.')) onClearAll();
        }}
      >
        <Trash2 className="size-3.5" aria-hidden /> Clear all
      </button>
    </span>
  );
}
