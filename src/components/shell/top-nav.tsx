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
import {
  ChevronLeft, ChevronRight, GraduationCap, History, LifeBuoy, Search, Sparkles,
} from 'lucide-react';
import { useShell } from './shell-context';
import { cn } from '@/lib/ui/cn';
import { HelmMark } from '../ui/helm-mark';

export interface TopNavTab {
  href: string;
  label: string;
  /** Every route prefix that should light this tab up. */
  owns: readonly string[];
}

export const TOP_NAV_TABS: readonly TopNavTab[] = [
  { href: '/dashboard', label: 'Dashboard', owns: ['/dashboard'] },
  { href: '/organizations', label: 'Organizations', owns: ['/organizations', '/assets'] },
  { href: '/account', label: 'Personal', owns: ['/account'] },
  {
    href: '/search',
    label: 'Global',
    owns: ['/search', '/expirations', '/exports', '/audit', '/people', '/settings'],
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

/** One utility icon. A button, not a link, when it opens something in place. */
function Utility({
  label,
  icon: Icon,
  href,
  onClick,
}: {
  label: string;
  icon: typeof Search;
  href?: string;
  onClick?: () => void;
}) {
  const className =
    'flex size-8 items-center justify-center rounded-md text-nav-ink transition-colors ' +
    'hover:bg-white/10 hover:text-nav-ink-active focus-visible:text-nav-ink-active';
  const inner = <Icon className="size-4" aria-hidden />;
  return href ? (
    <Link href={href} className={className} title={label} aria-label={label}>
      {inner}
    </Link>
  ) : (
    <button type="button" className={className} title={label} aria-label={label} onClick={onClick}>
      {inner}
    </button>
  );
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
        <Utility label="Documentation" icon={GraduationCap} href="/settings" />
        <Utility label="Search" icon={Search} href="/search" />
        <Utility label="Recently viewed" icon={History} href="/dashboard" />
        <Utility label="Assistant" icon={Sparkles} href="/search" />
        <Utility label="Help" icon={LifeBuoy} href="/settings" />
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
