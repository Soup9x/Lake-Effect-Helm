'use client';

/**
 * The boundary this application did not have.
 *
 * Until now there was no error.tsx anywhere under src/app, so ANY error thrown
 * while rendering any page — a failed query, a null dereference in a widget,
 * a client component that threw on mount — replaced the whole screen with
 * Next's default error page. For a documentation platform somebody opens
 * mid-incident, "the entire client page is gone" and "one card could not load"
 * should not look the same.
 *
 * WHAT THIS DOES AND DOES NOT CATCH, because the distinction is what a
 * production outage just taught us.
 *
 * It catches errors THROWN DURING RENDER: inside a Server Component's body,
 * inside a Client Component's render, in an event handler that re-renders. The
 * segment is replaced with this, the rest of the shell (navigation, tenant
 * switcher) survives, and `reset()` re-renders without a full reload.
 *
 * It does NOT catch a Server Component serialisation failure — "Functions
 * cannot be passed directly to Client Components". That is not thrown by a
 * component; React raises it while walking the finished tree to serialise it
 * for the client, with no component on the stack to attribute it to and no
 * boundary inside the tree able to intervene. The whole RSC payload for the
 * route fails. No error boundary anywhere, at any level, would have contained
 * the icon bug — which is why the fix for that one is a type and a test rather
 * than a boundary. See tests/support/rsc-boundary.ts.
 */
import { useEffect } from 'react';
import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server logs the stack; the browser gets only a digest. Putting the
    // digest in the console is what lets somebody on a support call read out
    // the one string that finds the real error in the server log.
    console.error('[helm] page render failed', error.digest ?? '(no digest)', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center gap-3 px-6 py-20 text-center">
      <ShieldAlert className="size-8 text-danger" aria-hidden />
      <p className="text-sm font-medium text-ink">This page could not be displayed.</p>
      <p className="max-w-md text-sm text-ink-muted">
        The rest of Helm is still working. If this keeps happening, quote the reference below —
        it identifies the error in the server log.
      </p>
      {error.digest && (
        <p className="font-mono text-xs text-ink-faint">reference {error.digest}</p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="secondary" asChild>
          <Link href="/dashboard">Go to the dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
