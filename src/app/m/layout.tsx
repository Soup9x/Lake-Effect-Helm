import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import {
  actorOf,
  getServerIdentity,
  NoMembershipError,
  NotAuthenticatedError,
} from '@/lib/auth/server-identity';
import { installSessionResolver } from '@/lib/auth/bootstrap';
import { currentSessionIsField } from '@/lib/auth/field-server';
import { withTenant } from '@/lib/db/client';
import { readFieldViewPolicy } from '@/lib/field/policy';
import { readShellState } from '@/lib/ui/account-queries';
import { SignedOut } from '@/components/signed-out';
import { ThemeSync } from '@/components/theme-sync';
import { IdleWatcher } from '@/components/idle-watcher';
import { FieldBottomNav, FieldTopBar } from '@/components/field/field-nav';
import { FieldGate } from '@/components/field/field-gate';

/**
 * Field view (/m): Helm on a phone, read-only (1250).
 *
 * Outside the (app) group on purpose: none of the full site's chrome, and the
 * full site's layout sends a Field view session here. What makes it read-only
 * is not this layout but the session flag the API checks on every request
 * (lib/auth/identity.ts); this only decides what is offered.
 *
 * A session that is not a Field view session yet is asked first (FieldGate),
 * or switched on arrival when it came from a phone's single sign-on.
 */
export default async function FieldLayout({ children }: { children: ReactNode }) {
  await installSessionResolver();

  let identity;
  try {
    identity = await getServerIdentity();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return <SignedOut reason="unauthenticated" />;
    if (error instanceof NoMembershipError) return <SignedOut reason="no-membership" />;
    throw error;
  }

  const [field, policy, shell] = await Promise.all([
    currentSessionIsField(),
    withTenant(actorOf(identity), (tx) => readFieldViewPolicy(tx)),
    readShellState(identity),
  ]);

  if (!field) {
    // Switched off: the phone gets the full site, which fits a phone now.
    if (!policy.enabled) redirect('/dashboard');
    return (
      <Suspense>
        <FieldGate />
      </Suspense>
    );
  }

  return (
    <>
      <ThemeSync accountTheme={shell.preferences.theme} />
      <div className="min-h-screen bg-canvas pb-20">
        <FieldTopBar name={identity.name} />
        <main className="mx-auto max-w-xl px-3 py-3">{children}</main>
        <FieldBottomNav showVault={policy.sections.includes('vault')} />
      </div>
      {/* The shorter of the two limits, so the warning comes before the server ends it. */}
      <IdleWatcher idleMinutes={Math.min(shell.idleMinutes, policy.idleMinutes)} />
    </>
  );
}
