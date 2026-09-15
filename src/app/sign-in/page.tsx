import { SignInForm } from '@/components/sign-in-form';

/**
 * /sign-in — the page auth/config.ts points at for both sign-in and errors.
 *
 * Public, and says as little as possible. It does not reveal whether a given
 * address has an account, whether local passwords are in use for anybody in
 * particular, or anything about the deployment beyond whether Entra is wired
 * up — which is visible from the presence of the button anyway.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested = typeof params.next === 'string' ? params.next : '/dashboard';

  // Only same-origin, absolute-path redirects. `next=https://evil.example` in a
  // link somebody was sent turns a sign-in page into an open redirect, and an
  // open redirect on a login page is a credible phishing primitive.
  const next = /^\/(?!\/)/.test(requested) ? requested : '/dashboard';

  const entraConfigured =
    Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID) &&
    Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET);

  return (
    <div className="grid min-h-screen place-items-center bg-surface px-6">
      <SignInForm entraConfigured={entraConfigured} next={next} />
    </div>
  );
}

export const dynamic = 'force-dynamic';
