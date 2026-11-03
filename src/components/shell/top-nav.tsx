'use client';

/**
 * The global bar.
 *
 * SCOPES, NOT EIGHT DESTINATIONS. The old shell listed every page in one
 * flat sidebar — Dashboard, Clients, Expirations, Search, Exports, Audit,
 * People, Settings — which meant the thing a technician looks at all day
 * (one client's records) sat at the same level as the thing they open twice a
 * month (an export). These tabs are SCOPES: whose data am I looking at.
 *
 *   Dashboard      my queue, across every client
 *   Organizations  one client at a time; the drawer is that client's records
 *   Personal       my own account, my recently viewed
 *   Global         everything that spans clients — search, assets,
 *                  configurations, credentials, expirations, exports
 *   Administration the settings that govern the MSP, people, the audit log
 *
 * The active tab is a solid white card, which is the one high-contrast element
 * on an otherwise near-black bar and is therefore unambiguous at a glance.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SearchBox } from './search-box';
import { cn } from '@/lib/ui/cn';
import { HelmMark } from '../ui/helm-mark';

export interface TopNavTab {
  href: string;
  label: string;
  /** Every route prefix that should light this tab up. */
  owns: readonly string[];
  /** Hidden from client-side roles. */
  adminOnly?: boolean;
}

const TOP_NAV_TABS: readonly TopNavTab[] = [
  { href: '/dashboard', label: 'Dashboard', owns: ['/dashboard'] },
  { href: '/organizations', label: 'Organizations', owns: ['/organizations', '/assets', '/contacts', '/locations', '/diagrams', '/documents'] },
  /*
   * PERSONAL AND GLOBAL POINT AT PAGES NOW, not at aliases. Until group L,
   * Personal was /account and Global was /search — which is why both read as
   * parity on the summary table and were not: a scope whose tab opens one of
   * its own sub-pages has no landing page, so there is nowhere for the things
   * that scope collects to appear together.
   *
   * `owns` still lists every route the scope covers, so the tab lights up when
   * somebody is deep inside it. /tasks belongs to Personal and /coverage to
   * Global, which is also the answer to "where did My Tasks go" — it is still
   * at /tasks and now has a scope that claims it.
   */
  { href: '/personal', label: 'Personal', owns: ['/personal', '/account', '/profile', '/tasks'] },
  {
    href: '/global',
    label: 'Global',
    owns: ['/global', '/search', '/coverage', '/expirations', '/exports', '/runs'],
  },
  /*
   * ADMINISTRATION IS ITS OWN SCOPE. It sat inside Global as a card, but the
   * settings that govern the whole MSP are a different visit from the work
   * that spans clients, and People and the audit log belong with them. Not
   * offered to client-side roles, whose pages there would all refuse them.
   */
  { href: '/settings', label: 'Administration', owns: ['/settings', '/people', '/audit'], adminOnly: true },
];

function activeTab(pathname: string): TopNavTab | undefined {
  // Longest prefix wins, so /organizations/x/passwords does not also match a
  // shorter tab that happens to share a leading segment.
  let best: TopNavTab | undefined;
  let bestLen = -1;
  for (const tab of TOP_NAV_TABS) {
    for (const prefix of tab.owns) {
      if ((pathname === prefix || pathname.startsWith(`${prefix}/`)) && prefix.length > bestLen) {
        best = tab;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

export function TopNav({
  tabs: allTabs = TOP_NAV_TABS,
  isClient = false,
  utilities,
}: {
  tabs?: readonly TopNavTab[];
  /** A client-side role: the administrative tab is not offered. */
  isClient?: boolean;
  /** The account menu and anything else that needs server-resolved identity. */
  utilities?: React.ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const current = activeTab(pathname);
  const tabs = isClient ? allTabs.filter((t) => !t.adminOnly) : allTabs;

  /*
   * NARROW SCREENS. Five tabs, the search box and the per-user controls need
   * about 1,100px in one row; a phone has 390. Below `lg` the tabs move into a
   * menu behind one button, so the bar never runs past the edge of the screen —
   * which it used to, taking search, the bell and Sign out off-screen with it.
   */
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1 bg-nav-top px-2 text-sm sm:px-3">
      <ScopeMenu tabs={tabs} current={current} />
      <Link
        href="/dashboard"
        className="mr-1 flex shrink-0 items-center gap-2 rounded-md px-1 py-1 text-nav-ink-active sm:mr-2"
      >
        <HelmMark className="size-6" />
        <span className="hidden font-semibold tracking-tight sm:inline">Helm</span>
      </Link>

      <nav className="hidden items-center gap-1 lg:flex" aria-label="Scope">
        {tabs.map((tab) => {
          const isActive = current?.href === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'rounded-md px-3 py-1.5 font-medium transition-colors',
                isActive
                  ? 'bg-nav-tab-active text-on-nav-tab-active'
                  : 'text-nav-ink hover:bg-white/10 hover:text-nav-ink-active',
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-0.5 lg:flex-none">
        {/*
          ONE ICON, AND IT GOES WHERE IT SAYS. Four of the five that used to be
          here did not: Documentation and Help both opened /settings, Assistant
          opened /search, and Recently viewed opened /dashboard. An icon that
          lies is worse than an absent one — somebody clicks it, lands
          somewhere unrelated, and learns to distrust the row.

          Documentation and Assistant are gone rather than wired, because
          neither exists to wire: there is no documentation site in this
          deployment and no assistant, and an icon promising a feature nobody
          is building is the same problem with an extra step. Help is gone
          because it was a second copy of the floating Support badge —
          same icon, same destination — and the badge is the one that says in
          its own comment that it is the route to a human.

          What remains is the search box — suggestions as you type, in this
          client or all of them — plus the per-user controls the shell passes
          in: Recently viewed (a real popover now) and the notification bell.
        */}
        <SearchBox />
        {utilities}
      </div>
    </header>
  );
}

/**
 * The scope tabs as a menu, for screens too narrow to show them in a row.
 * Closes on navigation, on a click outside and on Escape.
 */
function ScopeMenu({
  tabs,
  current,
}: {
  tabs: readonly TopNavTab[];
  current: TopNavTab | undefined;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const box = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: closing on navigation is the point; pathname is the trigger, not an input.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="scope-menu"
        aria-label={open ? 'Close the menu' : 'Open the menu'}
        className="flex size-9 items-center justify-center rounded-md text-nav-ink-active hover:bg-white/10"
      >
        {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
      </button>
      {open && (
        <nav
          id="scope-menu"
          aria-label="Scope"
          className="absolute left-0 top-11 z-40 w-60 overflow-hidden rounded-lg border border-border bg-surface-raised py-1 text-sm shadow-lg"
        >
          {tabs.map((tab) => {
            const isActive = current?.href === tab.href;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => setOpen(false)}
                className={cn(
                  'block px-4 py-2.5 font-medium',
                  isActive ? 'bg-brand-tint text-brand' : 'text-ink hover:bg-surface-sunken',
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
