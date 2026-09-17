'use client';

/**
 * The sign-in form. Several doors, and the order they appear in is deliberate.
 *
 * Single sign-on comes first and is the default path: on a normal day everybody
 * uses it, and a local password is a liability nobody should be typing out of
 * habit. The local form is present but secondary — it is the break-glass path,
 * for the morning the directory is unreachable.
 *
 * STARTING AN SSO SIGN-IN IS A POST, NOT A LINK, and that is not a style
 * choice. Auth.js takes the provider id from the URL PATH and requires a CSRF
 * token, so:
 *
 *   GET /api/auth/signin?provider=x     the query string is ignored and the
 *                                       request redirects back to this page
 *   GET /api/auth/signin/x              rejected as an unsupported action
 *   POST /api/auth/signin/x + csrf      starts the flow
 *
 * This component used to render the first of those as an ordinary link for
 * Entra, which meant the button returned the visitor to the page they were
 * already on. `signIn()` from next-auth/react does the CSRF fetch and the POST,
 * so both Entra and any configured OIDC provider go through it.
 *
 * The form never explains a failure in more detail than the server does. If
 * this component ever grows a branch on "account not found", that is a
 * user-enumeration oracle that the API deliberately does not provide.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { KeyRound, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from './ui/button';
import { Input, Label } from './ui/field';
import { HelmMark } from './ui/helm-mark';

export interface OidcOption {
  slug: string;
  displayName: string;
}

interface Props {
  entraConfigured: boolean;
  /** Generic OIDC providers an administrator has configured. */
  oidcOptions: OidcOption[];
  /** Auth.js error code from ?error=, if the last attempt bounced back here. */
  ssoError: string | null;
  /** Where to land after a successful sign-in. */
  next: string;
}

/**
 * Auth.js error codes, translated only where the translation is both accurate
 * and useful. Everything else stays generic: a sign-in page that explains
 * precisely why it refused is a sign-in page that answers questions for
 * somebody who should not be asking.
 */
function ssoMessage(code: string): string {
  switch (code) {
    case 'OAuthAccountNotLinked':
      return (
        'An account already exists with that email address, and this identity ' +
        'provider is not permitted to attach to it. An administrator can allow ' +
        'linking by email address in Settings.'
      );
    case 'AccessDenied':
      return (
        'That account is not permitted to sign in here. If it is new, somebody ' +
        'with administrator access has to add it first.'
      );
    case 'Configuration':
      return (
        'Single sign-on is not set up correctly on this deployment. An ' +
        'administrator can check the provider settings and run the connection test.'
      );
    default:
      return 'Sign-in failed. Try again, or use a local password below.';
  }
}

export function SignInForm({ entraConfigured, oidcOptions, ssoError, next }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(ssoError ? ssoMessage(ssoError) : null);
  const [pending, setPending] = useState(false);
  const [ssoPending, setSsoPending] = useState<string | null>(null);

  /**
   * Hand off to Auth.js. `redirect: true` means this never returns — the
   * browser leaves for the identity provider — so `ssoPending` is cleared only
   * on the failure path, where we are still here.
   */
  async function startSso(providerId: string) {
    setError(null);
    setSsoPending(providerId);
    try {
      await signIn(providerId, { callbackUrl: next });
    } catch {
      setError('Could not start single sign-on. Try again, or use a local password below.');
      setSsoPending(null);
    }
  }

  const ssoConfigured = entraConfigured || oidcOptions.length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const response = await fetch('/api/auth/local/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const payload = (await response.json()) as {
        ok?: boolean;
        mustChange?: boolean;
        error?: { message?: string };
      };

      if (!response.ok) {
        setError(payload.error?.message ?? 'Sign-in failed.');
        return;
      }

      // An administrator-issued password is a temporary one. Sending them
      // straight to the change screen is the difference between a password
      // that gets replaced and one that stays in a handover document forever.
      router.push(payload.mustChange ? '/account?password=change' : next);
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="text-center">
        <HelmMark className="mx-auto size-12" />
        <h1 className="mt-4 text-lg font-semibold tracking-tight text-ink">Lake Effect Helm</h1>
        <p className="mt-1 text-sm text-ink-muted">Sign in to continue.</p>
      </div>

      {ssoConfigured ? (
        <>
          <div className="mt-6 space-y-2">
            {entraConfigured && (
              <Button
                type="button"
                variant="primary"
                className="w-full"
                disabled={ssoPending !== null}
                onClick={() => startSso('microsoft-entra-id')}
              >
                {ssoPending === 'microsoft-entra-id' ? (
                  <Loader2 aria-hidden className="animate-spin" />
                ) : (
                  <KeyRound aria-hidden />
                )}
                Sign in with Microsoft
              </Button>
            )}

            {oidcOptions.map((option, index) => (
              <Button
                key={option.slug}
                type="button"
                // The first door offered is the primary one. With Entra present
                // that is Entra; without it, the first configured provider.
                variant={!entraConfigured && index === 0 ? 'primary' : 'secondary'}
                className="w-full"
                disabled={ssoPending !== null}
                onClick={() => startSso(option.slug)}
              >
                {ssoPending === option.slug ? (
                  <Loader2 aria-hidden className="animate-spin" />
                ) : (
                  <KeyRound aria-hidden />
                )}
                Sign in with {option.displayName}
              </Button>
            ))}
          </div>

          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase tracking-wide text-ink-faint">
              or use a local password
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
        </>
      ) : (
        <div className="mt-6 rounded-md border border-border bg-surface-raised p-3 text-xs text-ink-muted">
          No single sign-on provider is configured on this deployment. Local
          passwords are the only way in.
        </div>
      )}

      <form onSubmit={submit} className="mt-4 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger"
          >
            <ShieldAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            {error}
          </p>
        ) : null}

        <Button type="submit" variant={ssoConfigured ? 'secondary' : 'primary'} className="w-full" disabled={pending}>
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Sign in
        </Button>
      </form>
    </div>
  );
}
