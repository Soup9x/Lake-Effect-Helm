'use client';

/**
 * The organization drawer.
 *
 * Scoped to ONE client, which is the whole point: a technician working a ticket
 * is inside one customer's records for twenty minutes at a time, and every
 * destination they need should be one click away without first choosing the
 * customer again.
 *
 * COLLAPSED IS NOT HIDDEN. At 3.5rem the drawer still shows every icon and
 * every count — it loses the labels, not the navigation. A drawer that
 * disappeared would make the collapse toggle a thing you press once and undo,
 * and the counts are half the reason to look at it.
 *
 * THE PRIMARY LIST IS NOW DATA. It used to be ORG_CATEGORIES filtered by a
 * hardcoded `secondary` flag; it is now whatever `layout` says, with everything
 * else falling through to "More". The flag still decides the DEFAULT (see
 * DEFAULT_SIDEBAR), so a person who has never touched the control sees exactly
 * the drawer they saw before — but it has stopped being the only possible
 * answer for every MSP.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  AppWindow, BadgeCheck, Binary, BookOpen, Boxes, Cable, ChevronLeft, ChevronRight,
  FileSignature, FileText, FolderTree, Globe, KeyRound, LayoutGrid, MapPin, MoreHorizontal,
  Network, PanelLeftOpen, Server, Settings2, ShieldCheck, Truck, Users, Workflow, X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useShell } from './shell-context';
import type { CategoryCounts } from '@/lib/nav/org-categories';
import { splitSidebar } from '@/lib/nav/sidebar-layout';
import type { FlexibleAssetNav } from '@/lib/nav/org-sidebar';
import { SidebarCustomise } from '../sidebar-customise';
import { cn } from '@/lib/ui/cn';

/**
 * Icon names are resolved here rather than imported in the registry, because the
 * registry is a server module and a lucide component is not serialisable across
 * that boundary. An unknown name falls back rather than throwing: a tenant can
 * type anything into flexible_asset_type.icon.
 */
const ICONS: Record<string, typeof Server> = {
  AppWindow, BadgeCheck, Binary, BookOpen, Boxes, Cable, FileSignature, FileText,
  FolderTree, Globe, KeyRound, LayoutGrid, MapPin, Network, Server, ShieldCheck, Truck, Users,
  Workflow,
};

function Icon({ name, className }: { name: string | null; className?: string }) {
  const Resolved = (name && ICONS[name]) || Boxes;
  return <Resolved className={className} aria-hidden />;
}

function CountBadge({ count, collapsed }: { count: number; collapsed: boolean }) {
  if (count === 0) return null;
  return (
    <span
      className={cn(
        'tabular-nums text-nav-ink',
        collapsed
          ? 'absolute -right-0.5 -top-0.5 rounded-full bg-nav-side-active px-1 text-[10px] leading-4'
          : 'ml-auto text-xs',
      )}
    >
      {count}
    </span>
  );
}

function Row({
  href,
  label,
  iconName,
  count,
  active,
  collapsed,
}: {
  href: string;
  label: string;
  iconName: string | null;
  count: number;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? `${label}${count ? ` (${count})` : ''}` : undefined}
      className={cn(
        'relative flex items-center gap-2.5 rounded-md text-sm transition-colors',
        collapsed ? 'justify-center px-0 py-2' : 'px-2.5 py-1.5',
        active
          ? 'bg-nav-side-active font-medium text-nav-ink-active'
          : 'text-nav-ink hover:bg-white/5 hover:text-nav-ink-active',
      )}
    >
      <Icon name={iconName} className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
      <CountBadge count={count} collapsed={collapsed} />
    </Link>
  );
}

function SectionLabel({ children, collapsed }: { children: string; collapsed: boolean }) {
  if (collapsed) {
    return <div className="mx-auto my-2 h-px w-6 bg-nav-border" role="presentation" />;
  }
  return (
    <p className="px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-nav-ink/70">
      {children}
    </p>
  );
}

export function Sidebar({
  org,
  counts,
  flexibleAssets,
  layout,
  customised,
}: {
  org: { id: string; name: string };
  counts: CategoryCounts;
  flexibleAssets: readonly FlexibleAssetNav[];
  /** The categories in the primary list, in order. See lib/nav/sidebar-layout. */
  layout: string[];
  /** Whether this person has their own saved layout, so "follow the default" is offered. */
  customised: boolean;
}) {
  const pathname = usePathname() ?? '';
  const { sidebarCollapsed, toggleSidebar, drawerOpen, setDrawerOpen } = useShell();
  const [showMore, setShowMore] = useState(false);

  const base = `/organizations/${org.id}`;
  const { primary, more: secondary } = splitSidebar(layout);
  // Slid in over the page on a phone, the drawer is always the labelled one:
  // it is a menu there, and icons alone would make it a puzzle.
  const collapsed = sidebarCollapsed && !drawerOpen;

  // Getting somewhere is the end of the drawer's job on a phone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not an input.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname, setDrawerOpen]);

  /*
   * BELOW `md` THE DRAWER IS AN OVERLAY. A 240px column on a 390px phone left
   * the page 150px — a credentials table showed a checkbox and half a name. So
   * at phone width the column is hidden and MobileDrawerButton, at the top of
   * the page, slides it in over the content; from `md` up nothing changes.
   */
  return (
    <>
      {drawerOpen && (
        <button
          type="button"
          aria-label="Close the client menu"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 top-14 z-30 bg-black/40 md:hidden"
        />
      )}
    <aside
      className={cn(
        'shrink-0 flex-col overflow-y-auto bg-nav-side',
        drawerOpen
          ? 'fixed bottom-0 left-0 top-14 z-40 flex w-72 max-w-[85vw] shadow-xl md:static md:z-auto md:w-60 md:max-w-none md:shadow-none'
          : 'hidden md:flex',
        !drawerOpen && (collapsed ? 'w-14' : 'w-60'),
      )}
      aria-label={`${org.name} records`}
    >
      {/*
        The organization's own name, with the collapse toggle inline. The only
        copy of the control: the top bar's duplicate was removed, and this one
        stays drawn when collapsed, so the way back is always where it went.
      */}
      <div
        className={cn(
          'flex items-center gap-2 border-b border-nav-border px-3 py-3',
          collapsed && 'justify-center px-0',
        )}
      >
        {!collapsed && (
          <Link
            href={base}
            className="min-w-0 flex-1 truncate text-sm font-semibold text-nav-ink-active"
            title={org.name}
          >
            {org.name}
          </Link>
        )}
        {drawerOpen ? (
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close the client menu"
            className="flex size-8 shrink-0 items-center justify-center rounded text-nav-ink transition-colors hover:bg-white/10 hover:text-nav-ink-active"
          >
            <X className="size-5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={toggleSidebar}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            className="flex size-6 shrink-0 items-center justify-center rounded text-nav-ink transition-colors hover:bg-white/10 hover:text-nav-ink-active"
          >
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
          </button>
        )}
      </div>

      <nav className="flex-1 px-2 pb-3">
        <SectionLabel collapsed={collapsed}>Core assets</SectionLabel>
        {primary.length === 0 && !collapsed && (
          // Somebody removed everything. Saying so beats an empty gap above a
          // "More" button, which reads as a drawer that failed to load.
          <p className="px-2.5 pb-1 text-xs text-nav-ink/70">
            Everything is under “More”.
          </p>
        )}
        <div className="space-y-0.5">
          {primary.map((category) => (
            <Row
              key={category.slug}
              href={`${base}/${category.slug}`}
              label={category.label}
              iconName={category.icon}
              count={counts[category.slug] ?? 0}
              active={pathname === `${base}/${category.slug}`}
              collapsed={collapsed}
            />
          ))}
        </div>

        {flexibleAssets.length > 0 && (
          <>
            <SectionLabel collapsed={collapsed}>Apps &amp; services</SectionLabel>
            <div className="space-y-0.5">
              {flexibleAssets.map((type) => (
                <Row
                  key={type.id}
                  href={`${base}/flexible/${type.id}`}
                  label={type.name}
                  iconName={type.icon}
                  count={type.count}
                  active={pathname === `${base}/flexible/${type.id}`}
                  collapsed={collapsed}
                />
              ))}
            </div>
          </>
        )}

        {/*
          "More" holds whatever is not in the primary list. It is a disclosure
          rather than a second page because the alternative is a sixteen-item
          list where the ones that matter stop being scannable — and it holds
          EVERY remaining category, so nothing a person removes becomes
          unreachable. Removing a category from the drawer hides it from the
          first glance; it does not take it away.
        */}
        <div className="pt-3">
          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            aria-expanded={showMore}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md py-1.5 text-sm text-nav-ink transition-colors hover:bg-white/5 hover:text-nav-ink-active',
              collapsed ? 'justify-center px-0' : 'px-2.5',
            )}
            title={collapsed ? 'More' : undefined}
          >
            <MoreHorizontal className="size-4 shrink-0" aria-hidden />
            {!collapsed && <span>{showMore ? 'Less' : 'More'}</span>}
          </button>
          {showMore && (
            <div className="mt-0.5 space-y-0.5">
              {secondary.map((category) => (
                <Row
                  key={category.slug}
                  href={`${base}/${category.slug}`}
                  label={category.label}
                  iconName={category.icon}
                  count={counts[category.slug] ?? 0}
                  active={pathname === `${base}/${category.slug}`}
                  collapsed={collapsed}
                />
              ))}
            </div>
          )}
        </div>

        {/*
          The control that makes the list above a choice. At the FOOT of the
          drawer, below "More", because it is not a destination: it is the thing
          you reach for once, having noticed that the order is wrong for the way
          you work.
        */}
        <div className="pt-3">
          <SidebarCustomise
            scope="user"
            layout={layout}
            customised={customised}
            trigger={
              <button
                type="button"
                title={collapsed ? 'Customise the sidebar' : undefined}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md py-1.5 text-sm text-nav-ink transition-colors hover:bg-white/5 hover:text-nav-ink-active',
                  collapsed ? 'justify-center px-0' : 'px-2.5',
                )}
              >
                <Settings2 className="size-4 shrink-0" aria-hidden />
                {!collapsed && <span>Customise sidebar</span>}
              </button>
            }
          />
        </div>
      </nav>
    </aside>
    </>
  );
}

/**
 * Phone width only: the strip at the top of a client's pages that opens the
 * drawer. Names the client, so it doubles as "where am I".
 */
export function MobileDrawerButton({ orgName }: { orgName: string }) {
  const { drawerOpen, setDrawerOpen } = useShell();
  return (
    <button
      type="button"
      onClick={() => setDrawerOpen(!drawerOpen)}
      aria-expanded={drawerOpen}
      className="flex w-full items-center gap-2 border-b border-nav-border bg-nav-side px-4 py-2.5 text-left text-sm font-medium text-nav-ink-active md:hidden"
    >
      <PanelLeftOpen className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{orgName}</span>
      <span className="shrink-0 text-xs text-nav-ink">Records</span>
    </button>
  );
}
