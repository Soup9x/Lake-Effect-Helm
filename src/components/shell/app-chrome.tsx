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
import { SupportBadge } from './support-badge';
import { AccountMenu } from '../account-menu';
import { TenantSwitcher } from '../tenant-switcher';
import type { ServerIdentity } from '@/lib/auth/server-identity';
import { isClientRole } from '@/lib/ui/roles';

export function AppChrome({
  identity,
  children,
}: {
  identity: ServerIdentity;
  children: ReactNode;
}) {
  const isClient = isClientRole(identity.roleKey);
  const active = identity.memberships.find((m) => m.tenantId === identity.tenantId);

  return (
    <ShellProvider>
      <div className="flex min-h-screen flex-col bg-canvas">
        <TopNav
          utilities={
            <>
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
      <SupportBadge />
    </ShellProvider>
  );
}
