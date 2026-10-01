'use client';

/**
 * Secondary tabs, with the blue underline.
 *
 * Driven by the URL rather than by state: `Shared` and `Personal` are two views
 * of the same collection, and a technician who sends a colleague a link to the
 * personal view should not have them land on the shared one. The underline is an
 * element rather than a border so it can sit flush with the bar's own divider
 * instead of doubling it.
 */
import Link from 'next/link';
import { cn } from '@/lib/ui/cn';

export interface Tab {
  href: string;
  label: string;
  count?: number | undefined;
}

export function TabNav({ tabs, activeHref }: { tabs: readonly Tab[]; activeHref: string }) {
  if (tabs.length === 0) return null;
  return (
    <nav className="flex items-center gap-1 border-b border-canvas-border px-6" aria-label="View">
      {tabs.map((tab) => {
        const active = tab.href === activeHref;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative -mb-px px-3 py-2.5 text-sm transition-colors',
              active ? 'font-medium text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="ml-1.5 tabular-nums text-ink-faint">{tab.count}</span>
            )}
            {active && (
              <span
                className="absolute inset-x-0 -bottom-px h-0.5 rounded-t bg-subnav-active"
                aria-hidden
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
