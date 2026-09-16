import Link from 'next/link';
import { ResetForm } from '@/components/reset-form';

/**
 * /sign-in/reset?token=… — where a reset code is spent.
 *
 * The token arrives in the query string, which is the conventional shape and
 * the one an administrator can read down the phone as a URL. It is never
 * logged: Helm's request logger records the path, not the query.
 *
 * This page does not validate the token. Checking it here, before the person
 * has typed anything, would turn the page into an oracle for whether a guessed
 * token is live. It is checked once, at redemption, and the answer is the same
 * for expired, spent and fabricated.
 */
export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';

  return (
    <div className="grid min-h-screen place-items-center bg-surface px-6">
      {token ? (
        <ResetForm token={token} />
      ) : (
        <div className="w-full max-w-sm text-center">
          <h1 className="text-lg font-semibold tracking-tight text-ink">No reset code</h1>
          <p className="mt-2 text-sm text-ink-muted">
            This page needs the code from your reset link. Ask an administrator to
            issue a new one — during an identity provider outage that is the path
            that still works.
          </p>
          <Link href="/sign-in" className="mt-5 inline-block text-sm text-brand underline">
            Back to sign in
          </Link>
        </div>
      )}
    </div>
  );
}

export const dynamic = 'force-dynamic';
