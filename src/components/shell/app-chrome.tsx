/**
 * The chrome every authenticated page sits inside.
 *
 * A SERVER COMPONENT wrapping a client provider, which is the only arrangement
 * that works here: identity is resolved on the server and must not be shipped as
 * props to a client tree any larger than it has to be, while the collapse state
 * is browser state and cannot live on the server at all. So the provider is a
 * client boundary and everything server-rendered — the account menu, the page
 * itself — passes through it as children rather than props.
 *
 * SCROLLING. This is `min-h-screen`, not `h-screen`, so a page outside an
 * organization scrolls the window exactly as it did before this redesign — nine
 * existing pages keep working untouched. The organization view opts into a fixed
 * drawer by giving ITS row an explicit height (see that layout), which is the
 * only place the two-pane behaviour is wanted.
 *
 * The top bar is `sticky` rather than `fixed`: sticky participates in layout, so
 * the content below it needs no compensating offset that someone has to remember
 * to keep in step with the bar's height.
 */
import type { ReactNode } from 'react';
import { ShellProvider } from './shell-context';
import { TopNav } from './top-nav';
import { NotificationBell } from './notification-bell';
import { AccountMenu } from '../account-menu';
import { RecentlyViewed } from '../recently-viewed';
import { TenantSwitcher } from '../tenant-switcher';
import type { ServerIdentity } from '@/lib/auth/server-identity';
import { isClientRole } from '@/lib/ui/roles';
import { IdleWatcher } from '../idle-watcher';

export function AppChrome({
  identity,
  unreadNotifications,
  idleMinutes,
  children,
}: {
  identity: ServerIdentity;
  /**
   * 0700's unread count, read in the layout's own transaction alongside the
   * theme. A prop rather than a fetch: the badge is what draws somebody to the
   * bell, so it has to be there on first paint.
   */
  unreadNotifications: number;
  /** The session policy's idle timeout (0890); the shell warns before it. */
  idleMinutes: number;
  children: ReactNode;
}) {
  const isClient = isClientRole(identity.roleKey);
  const active = identity.memberships.find((m) => m.tenantId === identity.tenantId);

  return (
    <ShellProvider>
      <div className="flex min-h-screen flex-col bg-canvas">
        <TopNav
          isClient={isClient}
          utilities={
            <>
              {/*
                The per-user controls, in the order somebody reaches for them:
                where was I, what happened, who am I. Composed here rather than
                inside TopNav because each one needs something only the server
                has — the recents list its own fetch, the bell a count read with
                the identity, the switcher the membership list.
              */}
              <RecentlyViewed />
              <NotificationBell unread={unreadNotifications} />
              {/* Only when there is somewhere to switch TO. One tenant plus a
                  switcher is a control that exists to say "no". */}
              {identity.memberships.length > 1 && (
                <TenantSwitcher
                  memberships={identity.memberships}
                  activeTenantId={identity.tenantId}
                />
              )}
              <AccountMenu
                name={identity.name}
                email={identity.email}
                roleName={active?.roleName ?? identity.roleKey}
                isClient={isClient}
              />
            </>
          }
        />
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
      <IdleWatcher idleMinutes={idleMinutes} />
    </ShellProvider>
  );
}
