'use client';

/**
 * Field view's chrome (1250): a slim top bar and four thumb-reachable tabs.
 * Deliberately nothing else — no notifications, no switcher, no settings.
 * Field view is for finding a login at a client site, and every control that
 * is not that is a reason to open the full site instead.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Home, KeyRound, LogOut, Monitor, Search } from 'lucide-react';
import { HelmMark } from '../ui/helm-mark';
import { apiFetch } from '@/lib/ui/api';
import { cn } from '@/lib/ui/cn';

export function FieldTopBar({ name }: { name: string }) {
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    try {
      await apiFetch('/api/auth/local/logout', { json: {} });
    } finally {
      window.location.assign('/sign-in');
    }
  };
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 bg-nav-top px-3 text-sm text-nav-ink-active">
      <Link href="/m" className="flex items-center gap-2">
        <HelmMark className="size-6" />
        <span className="font-semibold tracking-tight">Helm</span>
      </Link>
      <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-nav-ink">Field view · read-only</span>
      <span className="ml-auto min-w-0 truncate text-xs text-nav-ink" title={name}>{name}</span>
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        aria-label="Sign out"
        title="Sign out"
        className="flex size-9 shrink-0 items-center justify-center rounded-md text-nav-ink hover:bg-white/10 hover:text-nav-ink-active"
      >
        <LogOut className="size-4" aria-hidden />
      </button>
    </header>
  );
}

export function FieldBottomNav({ showVault }: { showVault: boolean }) {
  const pathname = usePathname() ?? '';
  const tabs = [
    { href: '/m', label: 'Home', icon: Home, active: pathname === '/m' || pathname.startsWith('/m/c/') },
    { href: '/m/search', label: 'Search', icon: Search, active: pathname.startsWith('/m/search') },
    ...(showVault
      ? [{ href: '/m/vault', label: 'My vault', icon: KeyRound, active: pathname.startsWith('/m/vault') }]
      : []),
    { href: '/m/full', label: 'Full site', icon: Monitor, active: pathname.startsWith('/m/full') },
  ];
  return (
    <nav
      aria-label="Field view"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-surface-raised pb-[env(safe-area-inset-bottom)]"
    >
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? 'page' : undefined}
          className={cn(
            'flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]',
            tab.active ? 'font-semibold text-brand' : 'text-ink-muted',
          )}
        >
          <tab.icon className="size-5" aria-hidden />
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
