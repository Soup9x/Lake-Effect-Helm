'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './button';

/**
 * One page of a list that is already all in the browser. The page is clamped
 * rather than reset when the list shrinks, so a search that leaves fewer pages
 * lands on the last one instead of an empty one; callers reset it themselves
 * when the filter changes and the old page no longer means anything.
 */
export function usePage<T>(items: T[], size: number) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pages - 1);
  return {
    rows: items.slice(current * size, current * size + size),
    page: current,
    pages,
    total: items.length,
    first: current * size + 1,
    last: Math.min(items.length, current * size + size),
    setPage,
  };
}

/** "11–20 of 48" with previous and next. Renders nothing for a single page. */
export function Pager({ page, pages, total, first, last, setPage, noun = 'rows' }: ReturnType<typeof usePage<unknown>> & { noun?: string }) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 text-xs text-ink-faint">
      <span className="tabular-nums">{first}&ndash;{last} of {total} {noun}</span>
      <Button variant="ghost" size="icon" className="size-8" aria-label="Previous page"
        disabled={page === 0} onClick={() => setPage(page - 1)}>
        <ChevronLeft aria-hidden />
      </Button>
      <Button variant="ghost" size="icon" className="size-8" aria-label="Next page"
        disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
        <ChevronRight aria-hidden />
      </Button>
    </div>
  );
}
