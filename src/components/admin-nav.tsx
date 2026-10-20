'use client';

/**
 * The sub-navigation across Administration's pages. Wraps on a narrow screen
 * rather than scrolling sideways, so every section stays visible.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/ui/cn';
import { ADMIN_SECTIONS } from '@/lib/settings/sections';

export function AdminNav() {
  const pathname = usePathname() ?? '';
  const items = [{ href: '/settings', short: 'Overview' }, ...ADMIN_SECTIONS];

  return (
    <nav aria-label="Administration" className="-mt-1 flex flex-wrap gap-1 border-b border-border pb-2">
      {items.map((item) => {
        const active = item.href === '/settings' ? pathname === '/settings' : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-2.5 py-1 text-sm transition-colors',
              active ? 'bg-brand-tint font-medium text-brand-strong' : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
            )}
          >
            {item.short}
          </Link>
        );
      })}
    </nav>
  );
}
