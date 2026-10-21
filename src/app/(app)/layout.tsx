import type { ReactNode } from 'react';
import { AppChrome } from '@/components/shell/app-chrome';
import {
  getServerIdentity,
  NoMembershipError,
  NotAuthenticatedError,
} from '@/lib/auth/server-identity';
import { installSessionResolver } from '@/lib/auth/bootstrap';
import { SignedOut } from '@/components/signed-out';
import { ThemeSync } from '@/components/theme-sync';
import { readShellState } from '@/lib/ui/account-queries';

/**
 * The authenticated shell.
 *
 * Every page under (app) renders inside this, so identity resolution happens in
 * exactly one place. A page that forgot to check would still be inside a layout
 * that did — and, more importantly, would still be running every query through
 * withTenant(), which is what actually enforces anything.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  // Idempotent and memoised. Here rather than in a module side effect so the
  // worker process, which imports the same db client, never opens the auth pool.
  await installSessionResolver();

  let identity;
  try {
    identity = await getServerIdentity();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return <SignedOut reason="unauthenticated" />;
    }
    if (error instanceof NoMembershipError) {
      // 'Sign in again' will not help: the account is real and has no active
      // membership anywhere. Saying so is kinder than a login loop.
      return <SignedOut reason="no-membership" />;
    }
    throw error;
  }

  /*
   * The account's own preferences and the unread notification count, read here
   * because this is the one place every authenticated page passes through: the
   * theme has to be applied before the page below it paints, and the bell is in
   * the header on every page. ONE transaction for both — a second withTenant()
   * would open another connection and set the session context again to fetch a
   * number for the corner of the screen.
   *
   * The preferences FORM reads its own copy on the account page, because that
   * page needs the name halves too.
   */
  const { preferences, unreadNotifications, idleMinutes, avatarUrl } = await readShellState(identity);

  /*
   * Pages that are NOT inside an organization get the content column straight
   * from here. The organization layout supplies its own, because it has to put
   * the drawer beside it — see organizations/[organizationId]/layout.tsx.
   */
  return (
    <>
      <ThemeSync accountTheme={preferences.theme} />
      <AppChrome identity={identity} unreadNotifications={unreadNotifications} idleMinutes={idleMinutes} avatarUrl={avatarUrl}>
        {children}
      </AppChrome>
    </>
  );
}
