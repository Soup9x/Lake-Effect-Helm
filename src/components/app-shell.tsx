import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  Building2,
  CalendarClock,
  FileDown,
  KeyRound,
  LayoutDashboard,
  ScrollText,
  Search,
  Settings,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { TenantSwitcher } from './tenant-switcher';
import type { ServerIdentity } from '@/lib/auth/server-identity';
import { AccountMenu } from './account-menu';
import { RecentlyViewed } from './recently-viewed';
import { HelmMark } from './ui/helm-mark';
import { isClientRole } from '@/lib/ui/roles';
import { Breadcrumbs, type Crumb } from './ui/breadcrumbs';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Hidden when the signed-in role lacks this permission. */
  permission?: string;
}

/**
 * Navigation is filtered by ROLE, not by permission checks in the browser.
 *
 * Hiding a link is a convenience, never a control: every page independently
 * establishes a tenant context and every query runs under RLS, so typing the
 * URL of a page this role cannot use produces an empty result or a refusal from
 * the database — not a leak. The filter exists so a client's read-only user is
 * not shown five things that will all say "not permitted".
 */
const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/organizations', label: 'Clients', icon: Building2 },
  { href: '/expirations', label: 'Expirations', icon: CalendarClock },
  { href: '/search', label: 'Search', icon: Search },
  { href: '/exports', label: 'Exports', icon: FileDown },
  { href: '/audit', label: 'Audit', icon: ScrollText },
  { href: '/people', label: 'People', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const HIDDEN_FROM_CLIENTS = new Set(['/audit', '/settings', '/people']);

export function AppShell({
  identity,
  children,
}: {
  identity: ServerIdentity;
  children: ReactNode;
}) {
  const isClient = isClientRole(identity.roleKey);
  const items = NAV.filter((item) => !(isClient && HIDDEN_FROM_CLIENTS.has(item.href)));
  const active = identity.memberships.find((m) => m.tenantId === identity.tenantId);

  return (
    <div className="flex min-h-screen bg-surface">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface-raised">
        <div className="flex items-center gap-2 px-4 py-4">
          <HelmMark className="size-7" />
          <span className="text-sm font-semibold tracking-tight">Helm</span>
        </div>

        <div className="px-2 pb-2">
          <TenantSwitcher memberships={identity.memberships} activeTenantId={identity.tenantId} />
        </div>

        <nav className="flex-1 space-y-0.5 px-2 py-2">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
            >
              <item.icon className="size-4 shrink-0" aria-hidden />
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The account lives top right, where every other tool an MSP uses all
            day puts it. Slim on purpose: each page renders its own header
            underneath, and two tall bars stacked is how a dashboard loses the
            screen it is meant to be showing. */}
        <header className="flex h-12 shrink-0 items-center justify-end gap-1 border-b border-border bg-surface-raised px-4">
          <RecentlyViewed />
          <AccountMenu
            name={identity.name}
            email={identity.email}
            roleName={active?.roleName ?? identity.roleKey}
            isClient={isClient}
          />
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

/**
 * Every page's header, and therefore the one place breadcrumbs belong.
 *
 * `trail` is a prop here rather than a component each page remembers to render,
 * because "applied consistently across every nested view" is a property of the
 * shell or it is not a property at all: a breadcrumb that appears on the pages
 * somebody thought of is a navigation aid you cannot rely on, which is worse
 * than none.
 */
export function PageHeader({
  title,
  description,
  trail = [],
  actions,
}: {
  title: string;
  // Explicitly `| undefined`: under exactOptionalPropertyTypes a caller
  // computing a description that may come out empty would otherwise have to
  // build the prop conditionally at every call site.
  description?: string | undefined;
  /** Ancestors only, nearest root first. The page's own name is `title`. */
  trail?: readonly Crumb[];
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-surface-raised px-6 py-5">
      <div className="min-w-0">
        <Breadcrumbs trail={trail} />
        <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-0.5 max-w-2xl text-sm text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="space-y-6 px-6 py-6">{children}</div>;
}

export function EmptyState({
  icon: Icon = ShieldAlert,
  title,
  description,
  action,
}: {
  icon?: typeof ShieldAlert;
  title: string;
  description?: string | undefined;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <Icon className="size-8 text-ink-faint" aria-hidden />
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="max-w-md text-sm text-ink-muted">{description}</p>}
      {action}
    </div>
  );
}

export { KeyRound };
