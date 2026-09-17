'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { Building2, Clock, Network } from 'lucide-react';
import { useDismissable } from '@/lib/ui/use-dismissable';

interface RecentItem {
  kind: 'client' | 'asset';
  id: string;
  href: string;
  name: string;
  context: string | null;
  viewedAt: string;
}

/**
 * The last ten things you opened.
 *
 * Per user, not per browser. localStorage would have been less work and would
 * have been wrong: a technician who moves from the workshop machine to a laptop
 * mid-ticket has the same job in front of them, and a history that resets is a
 * history nobody relies on. It is also why this survives signing out — the rows
 * are in the database under an RLS policy naming the acting user, and a
 * colleague on the same machine sees their own list, not this one.
 */
export function RecentlyViewed() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<RecentItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useDismissable(open, useCallback(() => setOpen(false), []), container, trigger);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;

    // Re-fetched on every open, not cached. The whole value of the list is that
    // it reflects where you have just been.
    setFailed(false);
    try {
      const response = await fetch('/api/workspace/recent', { headers: { accept: 'application/json' } });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const body = (await response.json()) as { recent?: RecentItem[] };
      setItems(body.recent ?? []);
    } catch {
      setFailed(true);
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
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
      >
        <Clock className="size-4 shrink-0" aria-hidden />
        <span className="hidden sm:inline">Recent</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Recently viewed"
          className="absolute right-0 z-30 mt-1 w-72 overflow-hidden rounded-md border border-border bg-surface-raised shadow-lg"
        >
          <div className="border-b border-border px-3 py-2 text-xs font-medium text-ink-faint">
            Recently viewed
          </div>

          {failed ? (
            <p role="alert" className="px-3 py-3 text-sm text-danger">
              Could not load your recent items.
            </p>
          ) : items === null ? (
            <p className="px-3 py-3 text-sm text-ink-faint">Loading…</p>
          ) : items.length === 0 ? (
            <p className="px-3 py-3 text-sm text-ink-muted">
              Nothing yet. Clients and assets you open appear here.
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1">
              {items.map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  <Link
                    href={item.href}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2.5 px-3 py-2 text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
                  >
                    {item.kind === 'client' ? (
                      <Building2 className="size-4 shrink-0 text-ink-faint" aria-hidden />
                    ) : (
                      <Network className="size-4 shrink-0 text-ink-faint" aria-hidden />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-ink">{item.name}</span>
                      {item.context && (
                        <span className="block truncate text-xs text-ink-faint">{item.context}</span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
