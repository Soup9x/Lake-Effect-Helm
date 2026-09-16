'use client';

/**
 * The sign-in form. Two doors, and the order they appear in is deliberate.
 *
 * Entra is first and is the default path: on a normal day everybody uses SSO,
 * and a local password is a liability nobody should be typing out of habit.
 * The local form is present but secondary — it is the break-glass path, for the
 * morning Entra is unreachable.
 *
 * The form never explains a failure in more detail than the server does. If
 * this component ever grows a branch on "account not found", that is a
 * user-enumeration oracle that the API deliberately does not provide.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from './ui/button';
import { Input, Label } from './ui/field';

interface Props {
  entraConfigured: boolean;
  /** Where to land after a successful sign-in. */
  next: string;
}

export function SignInForm({ entraConfigured, next }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
      router.push(payload.mustChange ? '/settings?password=change' : next);
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
        <div className="mx-auto grid size-11 place-items-center rounded-xl bg-brand text-sm font-bold text-on-brand">
          LE
        </div>
        <h1 className="mt-4 text-lg font-semibold tracking-tight text-ink">Lake Effect Helm</h1>
        <p className="mt-1 text-sm text-ink-muted">Sign in to continue.</p>
      </div>

      {entraConfigured ? (
        <>
          <Button asChild variant="primary" className="mt-6 w-full">
            <a href="/api/auth/signin?provider=microsoft-entra-id">
              <KeyRound aria-hidden />
              Sign in with Microsoft
            </a>
          </Button>

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
          Microsoft Entra ID is not configured on this deployment. Local passwords
          are the only way in.
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

        <Button type="submit" variant={entraConfigured ? 'secondary' : 'primary'} className="w-full" disabled={pending}>
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Sign in
        </Button>
      </form>

      <p className="mt-4 text-center text-xs text-ink-muted">
        Forgotten your password? Ask an administrator to issue a reset code — during
        an identity provider outage that is faster than email, and it works when
        email does not.
      </p>
    </div>
  );
}
