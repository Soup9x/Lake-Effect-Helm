'use client';

/**
 * How one person signs in, and what an administrator can do about it (1000):
 * email them a link to choose (or reset) a password, email them that they have
 * access, set a password to hand over, or make a one-time link to read down
 * the phone when email is the thing that is down.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, KeyRound, Loader2, Mail } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';
import { Modal } from './ui/modal';
import { PasswordGenerator } from './password-generator';
import { apiFetch, type Feedback } from '@/lib/ui/api';
import { copyUnaudited } from '@/lib/ui/clipboard';
import { formatDateTime } from '@/lib/ui/format';

export interface MemberSignIn {
  hasLocalPassword: boolean;
  mustChange: boolean;
  lastEmail: { kind: string; status: string; error: string | null; at: string | null } | null;
}

const EMAIL_KIND: Record<string, string> = {
  access_granted: 'Access email',
  password_setup: 'Password setup link',
  password_reset: 'Password reset link',
};

/** One line for the People table: what went, or why it did not. */
export function lastEmailLine(signIn: MemberSignIn): { text: string; tone: 'ok' | 'muted' | 'danger' } | null {
  const e = signIn.lastEmail;
  if (!e) return null;
  const what = EMAIL_KIND[e.kind] ?? 'Email';
  if (e.status === 'sent') return { text: `${what} sent ${formatDateTime(e.at)}`, tone: 'ok' };
  if (e.status === 'failed') return { text: `${what} not sent: ${e.error ?? 'unknown error'}`, tone: 'danger' };
  return { text: `${what} waiting to send${e.error ? ` (retrying: ${e.error})` : ''}`, tone: 'muted' };
}

export function SignInDialog({
  userId, email, label, signIn, open, onOpenChange,
}: {
  userId: string;
  email: string;
  label: string;
  signIn: MemberSignIn;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [oneTime, setOneTime] = useState<{ url: string; expiresAt: string } | null>(null);

  async function post(action: string, json: Record<string, unknown>, success: string) {
    setBusy(action);
    setFeedback(null);
    try {
      const result = await apiFetch(`/api/users/${userId}/password`, { json });
      if (!result.ok) {
        setFeedback({ ok: false, message: result.message });
        return;
      }
      setFeedback({ ok: true, message: success });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function setNow(event: FormEvent) {
    event.preventDefault();
    await post('set', { action: 'set', password, mustChange },
      mustChange
        ? 'Password set. Give it to them directly; they choose their own at their first sign-in.'
        : 'Password set. Give it to them directly.');
    setPassword('');
  }

  async function makeOneTime() {
    setBusy('code');
    setFeedback(null);
    try {
      const result = await apiFetch<{ resetUrl: string; expiresAt: string }>('/api/auth/local/reset', {
        json: { email, outOfBand: true },
      });
      if (!result.ok) {
        setFeedback({ ok: false, message: result.message });
        return;
      }
      setOneTime({ url: result.value.resetUrl, expiresAt: result.value.expiresAt });
    } finally {
      setBusy(null);
    }
  }

  const spin = (key: string) => busy === key && <Loader2 className="animate-spin" aria-hidden />;

  return (
    <Modal open={open} onOpenChange={onOpenChange} icon={KeyRound} title={`Sign-in for ${label}`}
      description={signIn.hasLocalPassword
        ? `Has a local password${signIn.mustChange ? ', which they must change at their next sign-in' : ''}.`
        : 'No local password: signs in with single sign-on, or not yet at all.'}>
      <div className="space-y-5">
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-ink">By email</h3>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={!!busy} onClick={() =>
              post('email', { action: 'email' }, signIn.hasLocalPassword
                ? 'A reset link is on its way. Its status shows on their row.'
                : 'A link to choose a password is on its way. Its status shows on their row.')}>
              {spin('email') || <Mail aria-hidden />}
              {signIn.hasLocalPassword ? 'Email a reset link' : 'Email a link to set a password'}
            </Button>
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={() =>
              post('access', { action: 'access_email' }, 'An email saying they have access is on its way.')}>
              {spin('access')}
              Email that they have access
            </Button>
          </div>
          <FieldHint>Sent through your mail relay to {email}. Links work once.</FieldHint>
        </section>

        <form onSubmit={setNow} className="space-y-2">
          <h3 className="text-sm font-medium text-ink">Set a password now</h3>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label htmlFor="admin-password" className="sr-only">Password</Label>
              <Input id="admin-password" type="text" autoComplete="off" spellCheck={false} minLength={12}
                value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 12 characters" />
            </div>
            <PasswordGenerator onUse={setPassword} />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)}
              className="size-4 rounded border-border-strong" />
            They must choose their own at their first sign-in
          </label>
          <Button type="submit" variant="primary" size="sm" disabled={!!busy || password.length < 12}>
            {spin('set')}
            Set password
          </Button>
        </form>

        <section className="space-y-2">
          <h3 className="text-sm font-medium text-ink">When email is down</h3>
          {oneTime ? (
            <div className="space-y-1.5 rounded-md border border-border bg-surface-sunken p-2.5">
              <code className="block break-all font-mono text-xs text-ink">{oneTime.url}</code>
              <div className="flex items-center justify-between gap-2 text-xs text-ink-muted">
                <span>Works once, until {formatDateTime(oneTime.expiresAt)}. Shown once — read it to them directly.</span>
                <Button variant="ghost" size="sm" onClick={() => void copyUnaudited(oneTime.url)}>
                  <Copy aria-hidden /> Copy
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={makeOneTime}>
              {spin('code')}
              Make a one-time link to read to them
            </Button>
          )}
        </section>

        {feedback && (
          <p role={feedback.ok ? undefined : 'alert'} className={feedback.ok ? 'text-sm text-ok' : 'text-sm text-danger'}>
            {feedback.message}
          </p>
        )}
      </div>
    </Modal>
  );
}
