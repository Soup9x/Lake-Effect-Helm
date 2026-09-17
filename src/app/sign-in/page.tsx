import { SignInForm } from '@/components/sign-in-form';
import { oidcSignInOptions } from '@/lib/auth/oidc-config';

/**
 * /sign-in — the page auth/config.ts points at for both sign-in and errors.
 *
 * Public, and says as little as possible. It does not reveal whether a given
 * address has an account, whether local passwords are in use for anybody in
 * particular, or anything about the deployment beyond which sign-in methods
 * exist — which is visible from the presence of the buttons anyway.
 *
 * The OIDC options carry a label and a path and nothing else. The issuer is
 * withheld even though it is not secret: a public page naming the deployment's
 * internal identity provider tells an unauthenticated visitor where to point
 * their next scan.
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

  /*
   * A provider that cannot be listed must not take the login page down with it.
   * This runs on the auth pool, and if that is unreachable the local password
   * form is the one thing still standing — which is exactly the morning
   * somebody needs it.
   */
  let oidcOptions: { slug: string; displayName: string }[] = [];
  try {
    oidcOptions = await oidcSignInOptions();
  } catch (error) {
    console.error('helm: could not list OIDC sign-in options', error);
  }

  /*
   * Auth.js turns an error into ?error=<code> on this page. The codes are
   * deliberately coarse, and two of them mean something specific enough to
   * explain — the rest stay generic so the page does not become an oracle.
   */
  const error = typeof params.error === 'string' ? params.error : null;

  return (
    <div className="grid min-h-screen place-items-center bg-surface px-6">
      <SignInForm
        entraConfigured={entraConfigured}
        oidcOptions={oidcOptions}
        ssoError={error}
        next={next}
      />
    </div>
  );
}

export const dynamic = 'force-dynamic';
