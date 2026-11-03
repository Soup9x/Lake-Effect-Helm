/**
 * The two tabs of Administration → Updates. Links, so each tab is its own
 * page with its own reads, the way Administration's sections are.
 */
import Link from 'next/link';
import { cn } from '@/lib/ui/cn';

const TABS = [
  { href: '/settings/updates', label: 'Version' },
  { href: '/settings/updates/history', label: 'History' },
] as const;

export function UpdatesTabs({ active }: { active: (typeof TABS)[number]['href'] }) {
  return (
    <nav aria-label="Updates" className="flex gap-1 border-b border-border">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.href === active ? 'page' : undefined}
          className={cn(
            'relative -mb-px px-3 py-2 text-sm transition-colors',
            tab.href === active ? 'font-medium text-ink' : 'text-ink-muted hover:text-ink',
          )}
        >
          {tab.label}
          {tab.href === active && (
            <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-t bg-subnav-active" aria-hidden />
          )}
        </Link>
      ))}
    </nav>
  );
}
