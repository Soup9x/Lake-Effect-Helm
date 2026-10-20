'use client';

/**
 * Sign-in and session limits (0890), for everybody in this MSP.
 *
 * Five numbers and one button. The numbers apply to every session from its
 * next request; the button — Sign everybody else out — is for when "from the
 * next request" is not soon enough: after an incident, or after a departure.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, LogOut, Timer } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label } from './ui/field';
import { Modal } from './ui/modal';
import { formatDateTime } from '@/lib/ui/format';
import { apiFetch } from '@/lib/ui/api';
import type { SessionPolicySettings } from '@/lib/auth/session-policy-settings';

type Draft = Record<'idleMinutes' | 'absoluteHours' | 'stepUpMinutes' | 'lockoutThreshold' | 'lockoutMaxMinutes', string>;

const draftOf = (p: SessionPolicySettings): Draft => ({
  idleMinutes: String(p.idleMinutes),
  absoluteHours: p.absoluteHours === null ? '' : String(p.absoluteHours),
  stepUpMinutes: String(p.stepUpMinutes),
  lockoutThreshold: String(p.lockoutThreshold),
  lockoutMaxMinutes: String(p.lockoutMaxMinutes),
});

export function SessionPolicyCard({ initial }: { initial: SessionPolicySettings }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState<Draft>(draftOf(initial));
  const [requireTotp, setRequireTotp] = useState(initial.requireLocalTotp);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [ending, setEnding] = useState(false);

  const set = (key: keyof Draft, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(saved))
    || requireTotp !== saved.requireLocalTotp;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<{ policy: SessionPolicySettings }>('/api/auth/session-policy', {
        method: 'PUT',
        json: {
          idleMinutes: Number(draft.idleMinutes),
          absoluteHours: draft.absoluteHours.trim() === '' ? null : Number(draft.absoluteHours),
          stepUpMinutes: Number(draft.stepUpMinutes),
          lockoutThreshold: Number(draft.lockoutThreshold),
          lockoutMaxMinutes: Number(draft.lockoutMaxMinutes),
          requireLocalTotp: requireTotp,
        },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSaved(result.value.policy);
      setDraft(draftOf(result.value.policy));
      setRequireTotp(result.value.policy.requireLocalTotp);
      setNotice('Saved. It applies to every session from its next request.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function endAll() {
    setEnding(true);
    setError(null);
    try {
      const result = await apiFetch<{ ended: number }>('/api/auth/session-policy/end-sessions', { method: 'POST' });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setNotice(`${result.value.ended} ${result.value.ended === 1 ? 'session' : 'sessions'} ended. Your own stays signed in.`);
      setConfirming(false);
    } finally {
      setEnding(false);
    }
  }

  const number = (key: keyof Draft, label: string, hint: string, min: number, max: number, optional = false) => (
    <div>
      <Label htmlFor={`sp-${key}`}>{label}</Label>
      <Input id={`sp-${key}`} type="number" inputMode="numeric" min={min} max={max}
        required={!optional} placeholder={optional ? 'No limit' : undefined}
        value={draft[key]} onChange={(e) => set(key, e.target.value)} />
      <FieldHint>{hint}</FieldHint>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Timer className="size-4 text-ink-faint" aria-hidden /> Sessions and sign-in
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-5">
          <p className="text-sm text-ink-muted">
            For everybody in this MSP, whichever way they sign in. Somebody who also belongs to another
            MSP on this deployment is held to whichever of the two is stricter.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {number('idleMinutes', 'Idle timeout (minutes)',
              'Signed out after this long with no activity, with a minute’s warning. 5 to 1440.', 5, 1440)}
            {number('absoluteHours', 'Sign in again every (hours)',
              'However active the session. Leave empty for no limit. 1 to 720.', 1, 720, true)}
            {number('stepUpMinutes', 'Step-up lasts (minutes)',
              'How long re-entering a password unlocks protected credentials. 1 to 60.', 1, 60)}
          </div>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-ink">Local password lockout</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {number('lockoutThreshold', 'Lock after (wrong passwords)',
                'The first lock is a minute, doubling with each further miss. 3 to 20.', 3, 20)}
              {number('lockoutMaxMinutes', 'Longest lock (minutes)',
                'Never permanent, so a stranger cannot lock out your break-glass account for good. 1 to 1440.', 1, 1440)}
            </div>
          </fieldset>

          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" checked={requireTotp} onChange={(e) => setRequireTotp(e.target.checked)}
              className="mt-0.5 size-4 rounded border-border-strong" />
            <span>
              Require an authenticator-app code for every local sign-in
              <span className="block text-xs text-ink-muted">
                Anybody without one is walked through setting it up at their next local sign-in.
                Single sign-on is unaffected — set two-step there in your identity provider.
              </span>
            </span>
          </label>

          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          {notice && <p className="text-sm text-ok">{notice}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={busy || !dirty}>
              {busy && <Loader2 className="animate-spin" />} Save
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setConfirming(true)}>
              <LogOut aria-hidden /> Sign everybody else out
            </Button>
            {saved.updatedAt && (
              <span className="text-xs text-ink-faint">Last changed {formatDateTime(saved.updatedAt)}</span>
            )}
          </div>
        </form>

        <Modal open={confirming} onOpenChange={setConfirming} title="Sign everybody else out?" icon={LogOut}>
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">
              Every session of everybody with access to this MSP ends now, except yours. They sign in
              again on their next click. Nothing they have saved is lost.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={ending}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={() => void endAll()} disabled={ending}>
                {ending && <Loader2 className="animate-spin" />} Sign them out
              </Button>
            </div>
          </div>
        </Modal>
      </CardContent>
    </Card>
  );
}
