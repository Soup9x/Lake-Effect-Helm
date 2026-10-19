'use client';

/**
 * The global bar.
 *
 * FOUR SCOPES, NOT EIGHT DESTINATIONS. The old shell listed every page in one
 * flat sidebar — Dashboard, Clients, Expirations, Search, Exports, Audit,
 * People, Settings — which meant the thing a technician looks at all day
 * (one client's records) sat at the same level as the thing they open twice a
 * month (an export). These four tabs are SCOPES: whose data am I looking at.
 *
 *   Dashboard      my queue, across every client
 *   Organizations  one client at a time; the drawer is that client's records
 *   Personal       my own account, my recently viewed
 *   Global         everything that spans clients — search, expirations,
 *                  exports, audit, people, settings
 *
 * The active tab is a solid white card, which is the one high-contrast element
 * on an otherwise near-black bar and is therefore unambiguous at a glance.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { SearchBox } from './search-box';
import { useShell } from './shell-context';
import { cn } from '@/lib/ui/cn';
import { HelmMark } from '../ui/helm-mark';

export interface TopNavTab {
  href: string;
  label: string;
  /** Every route prefix that should light this tab up. */
  owns: readonly string[];
}

const TOP_NAV_TABS: readonly TopNavTab[] = [
  { href: '/dashboard', label: 'Dashboard', owns: ['/dashboard'] },
  { href: '/organizations', label: 'Organizations', owns: ['/organizations', '/assets', '/contacts', '/locations', '/documents'] },
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
    owns: [
      '/global', '/search', '/coverage', '/expirations', '/exports', '/audit',
      '/people', '/settings', '/runs',
    ],
  },
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
  tabs = TOP_NAV_TABS,
  utilities,
}: {
  tabs?: readonly TopNavTab[];
  /** The account menu and anything else that needs server-resolved identity. */
  utilities?: React.ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const current = activeTab(pathname);
  const { sidebarCollapsed, toggleSidebar } = useShell();
  /*
   * Is there a drawer to collapse? True inside one organization — two segments
   * past /organizations — and false on the organization LIST, which has no
   * drawer. Derived from the route rather than from context so the toggle is
   * correct on the first paint instead of appearing a render later.
   */
  const hasDrawer = /^\/organizations\/[^/]+/.test(pathname);

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1 bg-nav-top px-3 text-sm">
      <Link
        href="/dashboard"
        className="mr-2 flex items-center gap-2 rounded-md px-1 py-1 text-nav-ink-active"
      >
        <HelmMark className="size-6" />
        <span className="font-semibold tracking-tight">Helm</span>
      </Link>

      <nav className="flex items-center gap-1" aria-label="Scope">
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

      <div className="ml-auto flex items-center gap-0.5">
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
        {/*
          Only rendered inside an organization: there is no drawer to collapse
          anywhere else, and a control that does nothing is worse than no
          control. Same reason it carries aria-expanded rather than just an icon.
        */}
        {hasDrawer && (
          <button
            type="button"
            onClick={toggleSidebar}
            aria-expanded={!sidebarCollapsed}
            aria-label={sidebarCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            title={sidebarCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            className="ml-1 flex size-8 items-center justify-center rounded-md text-nav-ink transition-colors hover:bg-white/10 hover:text-nav-ink-active"
          >
            {sidebarCollapsed ? (
              <ChevronRight className="size-4" aria-hidden />
            ) : (
              <ChevronLeft className="size-4" aria-hidden />
            )}
          </button>
        )}
      </div>
    </header>
  );
}
