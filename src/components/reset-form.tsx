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
import { apiFetch } from '@/lib/ui/api';
import { policyProblems } from '@/lib/ui/password-problems';

/** `setup`: a first password, from an account an administrator created (1000). */
export function ResetForm({ token, setup = false }: { token: string; setup?: boolean }) {
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
      const result = await apiFetch('/api/auth/local/reset/redeem', { json: { token, password } });

      if (!result.ok) {
        setProblems(policyProblems(result.details)?.map((p) => `Your password ${p}.`) ?? [result.message]);
        return;
      }

      setDone(true);
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-semibold tracking-tight text-ink">{setup ? 'Password set' : 'Password changed'}</h1>
        <p className="mt-2 text-sm text-ink-muted">
          {setup
            ? 'Your account is ready. Sign in with your email address and the password you just chose.'
            : 'Every session on this account has been signed out, including any the previous password was holding open.'}
        </p>
        <Button variant="primary" className="mt-5 w-full" onClick={() => router.push('/sign-in')}>
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-lg font-semibold tracking-tight text-ink">{setup ? 'Choose your password' : 'Choose a new password'}</h1>
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
