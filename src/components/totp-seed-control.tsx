'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';
import { useStepUp } from './step-up-dialog';
import { withStepUp } from '@/lib/ui/step-up';
import { apiFetch } from '@/lib/ui/api';

/**
 * Adding, replacing or removing the one-time code seed on a credential.
 *
 * A sibling of the password rather than a field in the details form: this
 * writes encrypted material through an audited endpoint, and a PATCH that
 * swept it up with a corrected username would be a very different event
 * wearing the same name.
 *
 * The seed only ever travels one way. `hasTotp` chooses the wording and
 * whether removal is offered; nothing here reads a seed back.
 */
export function TotpSeedControl({ nodeId, hasTotp }: { nodeId: string; hasTotp: boolean }) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [editing, setEditing] = useState(false);
  const [seed, setSeed] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  /**
   * PUT rather than POST: there is one TOTP slot on a credential and this sets
   * it, whether or not something was there. The route decides between creating a
   * secret and rotating the existing one — that is its business, not the form's,
   * and it is the part that keeps one audit chain per slot.
   */
  const attempt = () =>
    apiFetch(`/api/assets/${nodeId}/totp`, {
      method: 'PUT',
      json: { seed: seed.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) },
    });

  const cancel = () => {
    setEditing(false);
    setSeed('');
    setReason('');
    setError(null);
  };

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await withStepUp(attempt, stepUp.prompt);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      cancel();
      setSaved(
        hasTotp
          ? 'The one-time code seed was replaced. The previous one is superseded, not deleted.'
          : 'The one-time code seed was stored. Codes are generated on the credential page.',
      );
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await apiFetch(`/api/assets/${nodeId}/totp`, { method: 'DELETE' });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      cancel();
      setSaved('The one-time code seed was detached. Its history is kept for the audit trail.');
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {stepUp.dialog}
      {!editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={hasTotp ? 'ghost' : 'secondary'} size="sm" onClick={() => setEditing(true)}>
            <KeyRound />
            {hasTotp ? 'Replace one-time code' : 'Add a one-time code'}
          </Button>
          {hasTotp && (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={remove}>
              {busy && <Loader2 className="animate-spin" />}
              Remove one-time code
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <Label htmlFor={`totp-seed-${nodeId}`}>One-time code seed</Label>
            <Input
              id={`totp-seed-${nodeId}`}
              value={seed}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              placeholder="otpauth://… or a base32 seed"
              onChange={(e) => setSeed(e.target.value)}
            />
            <FieldHint>
              Prefer the otpauth:// URI from the vendor&rsquo;s setup page: it carries
              the digit count, period and algorithm, which are not always 6, 30
              and SHA1. Checked before anything is stored, so a bad paste is
              refused rather than saved.
            </FieldHint>
          </div>
          {hasTotp && (
            <div>
              <Label htmlFor={`totp-reason-${nodeId}`}>Why</Label>
              <Input
                id={`totp-reason-${nodeId}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. re-enrolled after the vendor reset MFA"
                maxLength={500}
              />
              <FieldHint>Recorded against the replacement, like a password rotation.</FieldHint>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !seed.trim()}
              onClick={save}
            >
              {busy && <Loader2 className="animate-spin" />}
              {hasTotp ? 'Replace' : 'Store'}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      {saved && <p className="text-xs text-ok">{saved}</p>}
    </div>
  );
}
