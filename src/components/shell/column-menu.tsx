'use client';

/**
 * Choosing which columns a grid shows.
 *
 * PERSISTED PER VIEWER, PER CATEGORY, in localStorage — not in the URL. This is
 * the same test the sidebar's collapse flag passes and the filter text fails: a
 * column choice is a property of the person reading, not of the thing being
 * read. Somebody pasting a link to "the archived passwords matching vpn" means
 * the rows; they do not mean "and hide the Updated column". Putting it in the
 * URL would also make two identical pages look different to every cache between
 * here and the browser.
 *
 * Keyed by category, because the useful columns differ: Updated By earns its
 * place on Documents and is noise on Locations.
 *
 * THE FIRST COLUMN CANNOT BE HIDDEN. It holds the name, the link to the record
 * and the inline copy and OTP controls. A grid of rows you cannot identify is
 * not a shorter grid, it is a broken one — so it is rendered as a disabled,
 * checked box rather than omitted, which answers "why can't I turn that off"
 * without anybody having to ask.
 */
import * as Popover from '@radix-ui/react-popover';
import { Columns3 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

export interface ColumnChoice {
  key: string;
  header: string;
  /** False for the identity column, which is always shown. */
  hideable: boolean;
}

const KEY_PREFIX = 'helm:columns:';

/**
 * Hidden column keys for one category.
 *
 * Stores what is HIDDEN rather than what is shown, so a column added to the
 * product later appears for everybody instead of staying invisible to every
 * person who had already saved a choice.
 */
export function useHiddenColumns(category: string): {
  hidden: ReadonlySet<string>;
  toggle: (key: string) => void;
  reset: () => void;
} {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  // After mount, for the same reason the sidebar's collapse state is: the
  // server cannot know what this browser remembers, and reading it during the
  // first render would be a hydration mismatch.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY_PREFIX + category);
      if (raw) setHidden(new Set(JSON.parse(raw) as string[]));
      else setHidden(new Set());
    } catch {
      // Private windows and blocked site data throw. A grid that cannot
      // remember a preference still works.
    }
  }, [category]);

  const persist = useCallback(
    (next: ReadonlySet<string>) => {
      setHidden(next);
      try {
        window.localStorage.setItem(KEY_PREFIX + category, JSON.stringify([...next]));
      } catch {
        /* As above. */
      }
    },
    [category],
  );

  const toggle = useCallback(
    (key: string) => {
      const next = new Set(hidden);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persist(next);
    },
    [hidden, persist],
  );

  const reset = useCallback(() => persist(new Set()), [persist]);

  return { hidden, toggle, reset };
}

export function ColumnMenu({
  columns,
  hidden,
  onToggle,
  onReset,
}: {
  columns: readonly ColumnChoice[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onReset: () => void;
}) {
  const hiddenCount = columns.filter((c) => c.hideable && hidden.has(c.key)).length;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Choose columns"
          aria-label={
            hiddenCount === 0
              ? 'Choose columns'
              : `Choose columns — ${hiddenCount} hidden`
          }
          className="relative flex size-8 shrink-0 items-center justify-center rounded-md border border-canvas-border text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
        >
          <Columns3 className="size-4" aria-hidden />
          {/* A count, not just a dot: "why is the Updated column missing" is
              answered before somebody goes looking for a bug. */}
          {hiddenCount > 0 && (
            <span className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-brand text-[10px] font-medium text-on-brand">
              {hiddenCount}
            </span>
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-56 rounded-md border border-border bg-surface-raised p-1 shadow-lg"
        >
          <p className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Columns
          </p>
          {columns.map((column) => {
            const shown = !hidden.has(column.key);
            return (
              <label
                key={column.key}
                className={
                  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-ink hover:bg-surface-sunken' +
                  (column.hideable ? '' : ' cursor-default opacity-60')
                }
              >
                <input
                  type="checkbox"
                  checked={column.hideable ? shown : true}
                  disabled={!column.hideable}
                  onChange={() => column.hideable && onToggle(column.key)}
                  className="size-3.5 rounded border-border-strong"
                />
                {column.header}
                {!column.hideable && (
                  <span className="ml-auto text-[10px] text-ink-faint">always</span>
                )}
              </label>
            );
          })}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={onReset}
              className="mt-1 w-full border-t border-border px-2 py-1.5 text-left text-sm text-brand hover:bg-surface-sunken"
            >
              Show every column
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
