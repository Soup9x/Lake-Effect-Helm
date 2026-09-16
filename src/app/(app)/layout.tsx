import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import {
  getServerIdentity,
  NoMembershipError,
  NotAuthenticatedError,
} from '@/lib/auth/server-identity';
import { installSessionResolver } from '@/lib/auth/bootstrap';
import { SignedOut } from '@/components/signed-out';

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

  return <AppShell identity={identity}>{children}</AppShell>;
}
