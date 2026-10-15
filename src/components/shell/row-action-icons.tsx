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
import { Pencil } from 'lucide-react';
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
