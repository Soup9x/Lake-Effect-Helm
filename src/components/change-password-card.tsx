'use client';

/**
 * Change your own password.
 *
 * Asks for the current one even though the person is already signed in. That is
 * not belt-and-braces: a stolen session cookie is the most likely way somebody
 * reaches this form who should not, and letting it set a new password would
 * turn a temporary theft into permanent ownership of the account.
 *
 * Renders in two states. The `mustChange` one is what a person sees straight
 * after signing in with a password an administrator issued — the point at which
 * a temporary password either gets replaced or lives in a handover document
 * forever.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label } from './ui/field';

interface Props {
  /** True when the current password was issued by somebody else. */
  mustChange: boolean;
  /** Null when this account has no local password — SSO only. */
  passwordChangedAt: string | null;
}

export function ChangePasswordCard({ mustChange, passwordChangedAt }: Props) {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  if (passwordChangedAt === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Local password</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-muted">
            This account has no local password and signs in through your identity
            provider. An administrator can issue one — worth having on at least a
            couple of accounts, because it is what still works when the identity
            provider does not.
          </p>
        </CardContent>
      </Card>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblems([]);

    if (next !== confirm) {
      setProblems(['The two new passwords do not match.']);
      return;
    }

    setPending(true);
    try {
      const response = await fetch('/api/auth/local/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });

      const payload = (await response.json()) as {
        ok?: boolean;
        error?: { message?: string; problems?: string[] };
      };

      if (!response.ok) {
        setProblems(
          payload.error?.problems?.map((p) => `Your new password ${p}.`) ?? [
            payload.error?.message ?? 'Could not change your password.',
          ],
        );
        return;
      }

      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
      router.refresh();
    } catch {
      setProblems(['Could not reach the server. Check your connection and try again.']);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className={mustChange ? 'border-sev-warning/50' : undefined}>
      <CardHeader>
        <CardTitle>{mustChange ? 'Choose your own password' : 'Local password'}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {mustChange ? (
          <p className="text-sm text-ink">
            The password you signed in with was issued by somebody else, which
            means it has been spoken aloud or sat in a terminal. Replace it now.
          </p>
        ) : (
          <p className="text-sm text-ink-muted">
            Last changed {new Date(passwordChangedAt).toLocaleDateString()}. This is
            the password that gets you in when your identity provider cannot be
            reached.
          </p>
        )}

        <form onSubmit={submit} className="max-w-sm space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <FieldHint>
              At least 12 characters. Not your name or email address, and not one you
              have used here before.
            </FieldHint>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Repeat it</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>

          {problems.length > 0 ? (
            <ul
              role="alert"
              className="space-y-1 rounded-md border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger"
            >
              {problems.map((problem) => (
                <li key={problem} className="flex items-start gap-2">
                  <ShieldAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                  {problem}
                </li>
              ))}
            </ul>
          ) : null}

          {done ? (
            <p className="flex items-center gap-2 text-xs text-ok">
              <CheckCircle2 aria-hidden className="size-3.5" />
              Your password has been changed.
            </p>
          ) : null}

          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
