import type { ReactNode } from 'react';
import { cn } from '@/lib/ui/cn';

/**
 * The rows of a login: a label above, the value below it, and the things you
 * do with the value — copy, show, open — at the right-hand end of the same
 * line, where the eye already is when the value is what you came for.
 *
 * Presentational only, so the page renders the static rows on the server and
 * RevealButton / TotpPanel render theirs on the client in the same shape.
 */

/** One look for every icon action in a row, links included. */
export const iconActionClass =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors ' +
  'hover:bg-surface-sunken hover:text-ink disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4';

export function FieldList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('divide-y divide-border overflow-hidden rounded-lg border border-border', className)}>
      {children}
    </div>
  );
}

export function FieldRow({
  label,
  meta,
  hint,
  children,
}: {
  label: ReactNode;
  /** Badges beside the label: sensitivity, step-up, strength. */
  meta?: ReactNode;
  /** A muted line under the value, such as when it was last rotated. */
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
        <span>{label}</span>
        {meta}
      </div>
      <div className="mt-0.5">{children}</div>
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

/** The value and its actions on one line; the value truncates, the actions never wrap. */
export function FieldLine({
  children,
  actions,
  mono = false,
}: {
  children: ReactNode;
  actions?: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <div className={cn('min-w-0 flex-1 truncate text-sm text-ink', mono && 'font-mono')}>{children}</div>
      {actions && <div className="-mr-2 flex shrink-0 items-center">{actions}</div>}
    </div>
  );
}
