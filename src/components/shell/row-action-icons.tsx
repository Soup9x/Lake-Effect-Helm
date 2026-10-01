'use client';

/**
 * The quick actions on a grid row.
 *
 * REVEALED ON HOVER, PRESENT ALWAYS. The icons are rendered at every row and
 * only their opacity changes, which matters for two reasons: a keyboard user
 * tabs into them (focus-within brings the group back to full opacity), and a
 * row whose contents appear on hover shifts its own layout as the pointer
 * crosses it.
 *
 * `opacity-0 group-hover:opacity-100 focus-within:opacity-100` — not `hidden`.
 */
import { ExternalLink, Lock, Pencil, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/ui/cn';

export interface RowAction {
  label: string;
  icon: typeof Pencil;
  href?: string | undefined;
  onClick?: (() => void) | undefined;
  tone?: 'default' | 'danger';
}

export function RowActionIcons({ actions }: { actions: readonly RowAction[] }) {
  if (actions.length === 0) return null;
  return (
    <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {actions.map((action) => {
        const className = cn(
          'flex size-7 items-center justify-center rounded transition-colors',
          action.tone === 'danger'
            ? 'text-ink-faint hover:bg-danger/10 hover:text-danger'
            : 'text-ink-faint hover:bg-surface-sunken hover:text-ink',
        );
        const inner = <action.icon className="size-3.5" aria-hidden />;
        return action.href ? (
          <a key={action.label} href={action.href} className={className} title={action.label} aria-label={action.label}>
            {inner}
          </a>
        ) : (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            className={className}
            title={action.label}
            aria-label={action.label}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}

/** The standard trio. Callers pass only the handlers they actually have. */
export function standardRowActions({
  editHref,
  onPermissions,
  onDelete,
}: {
  editHref?: string | undefined;
  onPermissions?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
}): RowAction[] {
  const actions: RowAction[] = [];
  if (editHref) actions.push({ label: 'Edit', icon: Pencil, href: editHref });
  if (onPermissions) actions.push({ label: 'Permissions', icon: Lock, onClick: onPermissions });
  if (onDelete) actions.push({ label: 'Delete', icon: Trash2, onClick: onDelete, tone: 'danger' });
  return actions;
}

/**
 * Inline utilities on the row's own name cell — copy a username, copy a secret,
 * open an external link.
 *
 * These are NOT hover-revealed. They are part of what the row is for: a
 * technician scanning a password list is looking for the copy button, and
 * hiding it until the pointer arrives makes the list look like it does not have
 * one.
 */
export function InlineRowUtilities({ children }: { children: ReactNode }) {
  return <span className="flex items-center gap-0.5">{children}</span>;
}

export function InlineUtility({
  label,
  icon: Icon,
  onClick,
  href,
}: {
  label: string;
  icon: typeof ExternalLink;
  onClick?: (() => void) | undefined;
  href?: string | undefined;
}) {
  const className =
    'flex size-6 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink';
  const inner = <Icon className="size-3.5" aria-hidden />;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className} title={label} aria-label={label}>
      {inner}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={className} title={label} aria-label={label}>
      {inner}
    </button>
  );
}
