import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { Button } from './ui/button';

/**
 * The two ways to arrive without access, told apart.
 *
 * A login loop is what happens when software conflates "no session" with "no
 * authority". A former employee whose account still exists will re-authenticate
 * successfully and land right back here, and being told why saves them a call
 * to the service desk that cannot help them either.
 */
export function SignedOut({ reason }: { reason: 'unauthenticated' | 'no-membership' }) {
  return (
    <div className="grid min-h-screen place-items-center bg-surface px-6">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto grid size-11 place-items-center rounded-xl bg-brand text-sm font-bold text-on-brand">
          LE
        </div>
        <h1 className="mt-4 text-lg font-semibold tracking-tight text-ink">Lake Effect Helm</h1>

        {reason === 'unauthenticated' ? (
          <>
            <p className="mt-1 text-sm text-ink-muted">Sign in to continue.</p>
            <Button asChild variant="primary" className="mt-5 w-full">
              <Link href="/sign-in">
                <KeyRound aria-hidden />
                Sign in
              </Link>
            </Button>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-muted">
              Your account is signed in but has no active membership in any tenant. Signing in
              again will not change that — ask an administrator to restore your access.
            </p>
            <Button asChild variant="secondary" className="mt-5 w-full">
              <Link href="/api/auth/signout">Sign out</Link>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
