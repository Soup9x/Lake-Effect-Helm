'use client';

/**
 * Redeem a reset code and choose a new password.
 *
 * The policy is enforced server-side and the server's list of problems is what
 * gets shown — there is no client-side copy of the rules to drift out of step
 * with it. The only client-side check is "the two boxes match", which the
 * server has no opinion about because it only ever receives one value.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldAlert } from 'lucide-react';
import { Button } from './ui/button';
import { Input, Label, FieldHint } from './ui/field';

export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblems([]);

    if (password !== confirm) {
      setProblems(['The two passwords do not match.']);
      return;
    }

    setPending(true);
    try {
      const response = await fetch('/api/auth/local/reset/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });

      const payload = (await response.json()) as {
        ok?: boolean;
        error?: { message?: string; problems?: string[] };
      };

      if (!response.ok) {
        setProblems(
          payload.error?.problems?.map((p) => `Your password ${p}.`) ?? [
            payload.error?.message ?? 'That reset link is no longer valid.',
          ],
        );
        return;
      }

      setDone(true);
    } catch {
      setProblems(['Could not reach the server. Check your connection and try again.']);
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-semibold tracking-tight text-ink">Password changed</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Every session on this account has been signed out, including any the
          previous password was holding open.
        </p>
        <Button variant="primary" className="mt-5 w-full" onClick={() => router.push('/sign-in')}>
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-lg font-semibold tracking-tight text-ink">Choose a new password</h1>
      <p className="mt-1 text-sm text-ink-muted">
        At least 12 characters. A passphrase of several unrelated words is both
        stronger and easier to type than a short one with symbols in it.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <FieldHint>Not your name, your email address, or one you have used here before.</FieldHint>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirm">Repeat it</Label>
          <Input
            id="confirm"
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

        <Button type="submit" variant="primary" className="w-full" disabled={pending}>
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Set password
        </Button>
      </form>
    </div>
  );
}
