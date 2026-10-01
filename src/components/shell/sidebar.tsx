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
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  AppWindow, BadgeCheck, Binary, BookOpen, Boxes, Cable, ChevronLeft, ChevronRight,
  FileSignature, FileText, FolderTree, Globe, KeyRound, LayoutGrid, MapPin, MoreHorizontal,
  Network, Server, ShieldCheck, Truck, Users,
} from 'lucide-react';
import { useState } from 'react';
import { useShell } from './shell-context';
import { ORG_CATEGORIES, type CategoryCounts } from '@/lib/nav/org-categories';
import type { FlexibleAssetNav } from '@/lib/nav/org-sidebar';
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
}: {
  org: { id: string; name: string };
  counts: CategoryCounts;
  flexibleAssets: readonly FlexibleAssetNav[];
}) {
  const pathname = usePathname() ?? '';
  const { sidebarCollapsed, toggleSidebar } = useShell();
  const [showMore, setShowMore] = useState(false);

  const base = `/organizations/${org.id}`;
  const primary = ORG_CATEGORIES.filter((c) => !c.secondary);
  const secondary = ORG_CATEGORIES.filter((c) => c.secondary);
  const collapsed = sidebarCollapsed;

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col overflow-y-auto bg-nav-side',
        collapsed ? 'w-14' : 'w-60',
      )}
      aria-label={`${org.name} records`}
    >
      {/*
        The organization's own name, with the collapse toggle inline. Duplicated
        from the top bar on purpose: this is the control's natural home, and the
        one in the utility bar is for people who have already collapsed it and
        need a way back that does not depend on finding a 14px drawer.
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
        <button
          type="button"
          onClick={toggleSidebar}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          className="flex size-6 shrink-0 items-center justify-center rounded text-nav-ink transition-colors hover:bg-white/10 hover:text-nav-ink-active"
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
        </button>
      </div>

      <nav className="flex-1 px-2 pb-3">
        <SectionLabel collapsed={collapsed}>Core assets</SectionLabel>
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
          "More" holds the node types a technician reaches less often. It is a
          disclosure rather than a second page because the alternative is a
          sixteen-item list where the eight that matter stop being scannable.
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
      </nav>
    </aside>
  );
}
