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
import { Badge } from './ui/badge';
import { SignOutButton } from './sign-out-button';
import { ThemeToggle } from './theme-toggle';
import { initials } from '@/lib/ui/format';
import { isClientRole } from '@/lib/ui/roles';

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

  return (
    <div className="flex min-h-screen bg-surface">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface-raised">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="grid size-7 place-items-center rounded-md bg-brand text-xs font-bold text-on-brand">
            LE
          </div>
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

        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2">
            <div className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-sunken text-xs font-medium text-ink-muted">
              {initials(identity.name)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-ink">{identity.name}</div>
              <div className="truncate text-xs text-ink-faint">{identity.email}</div>
            </div>
          </div>
          {isClient && (
            <div className="mt-2">
              {/* Said plainly. A co-managed customer looking at their own
                  documentation should know which view they are in. */}
              <Badge tone="brand">Co-managed access</Badge>
            </div>
          )}
          <div className="mt-2">
            <ThemeToggle />
          </div>
          <SignOutButton />
        </div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  // Explicitly `| undefined`: under exactOptionalPropertyTypes a caller
  // computing a description that may come out empty would otherwise have to
  // build the prop conditionally at every call site.
  description?: string | undefined;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-surface-raised px-6 py-5">
      <div>
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
