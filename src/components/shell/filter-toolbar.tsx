'use client';

/**
 * The filter bar above a grid.
 *
 * STATE LIVES IN THE URL, which is the opposite choice from the sidebar's
 * collapse flag and for the opposite reason: "the archived passwords matching
 * vpn" is a thing somebody pastes into a ticket, and a filter held in component
 * state is lost the moment they open a row and come back.
 *
 * The typed query is debounced before it reaches the URL. Pushing a history
 * entry per keystroke makes the back button useless — thirty presses to leave a
 * page — so this replaces rather than pushes, and waits for a pause.
 */
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import type { ReactNode } from 'react';

export interface FilterToolbarProps {
  /** Rows after filtering, and rows in total: the "X of Y" readout. */
  shown: number;
  total: number;
  placeholder?: string;
  /** Hidden where the underlying table has no archive flag. */
  showArchivedToggle?: boolean;
  /**
   * The column control, passed in rather than configured here. It owns its own
   * persisted state and this bar owns the URL — keeping the two apart is what
   * stops a column choice leaking into a link somebody pastes.
   */
  columnMenu?: ReactNode;
}

const DEBOUNCE_MS = 250;

export function FilterToolbar({
  shown,
  total,
  placeholder = 'Filter columns or Search keywords...',
  showArchivedToggle = true,
  columnMenu,
}: FilterToolbarProps) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const params = useSearchParams();

  const urlQuery = params?.get('q') ?? '';
  const archived = params?.get('archived') === '1';
  const [draft, setDraft] = useState(urlQuery);

  // Re-sync when the URL changes underneath us — a back button, or a sidebar
  // link to the same route with no query.
  useEffect(() => setDraft(urlQuery), [urlQuery]);

  useEffect(() => {
    if (draft === urlQuery) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params?.toString() ?? '');
      if (draft) next.set('q', draft);
      else next.delete('q');
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, urlQuery, params, pathname, router]);

  const toggleArchived = () => {
    const next = new URLSearchParams(params?.toString() ?? '');
    if (archived) next.delete('archived');
    else next.set('archived', '1');
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-canvas-border px-6 py-2.5">
      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
        <input
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          aria-label="Filter rows"
          className="h-8 w-full rounded-md border border-canvas-border bg-surface-raised pl-8 pr-2 text-sm text-ink placeholder:text-ink-faint"
        />
      </div>

      {showArchivedToggle && (
        <label className="flex shrink-0 items-center gap-1.5 text-sm text-ink-muted">
          <input
            type="checkbox"
            checked={archived}
            onChange={toggleArchived}
            className="size-3.5 rounded border-border-strong"
          />
          Include archived
        </label>
      )}

      <span className="shrink-0 tabular-nums text-sm text-ink-faint">
        {shown} of {total}
      </span>

      <span className="ml-auto">{columnMenu}</span>
    </div>
  );
}
