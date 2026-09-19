'use client';

/**
 * Editing a stored credential.
 *
 * Credentials were the one item type with NO update path at all — no route, no
 * service call from the interface, nothing. A credential entered with a typo in
 * its username stayed that way, and a password that needed changing had to be
 * stored again as a second credential beside the wrong one.
 *
 * TWO ACTS, TWO FORMS, and the split is the point rather than tidiness:
 *
 *   DOCUMENTATION — the label, the username, the URL, what it unlocks, how
 *   protected it is. A PATCH that updates rows. Correcting a username is not an
 *   event anybody needs to be told about.
 *
 *   THE VALUE — a rotation. It writes a new encrypted version through the same
 *   audited handshake a reveal goes through. The gate is enforced in the
 *   database, not here; this form has to render the refusal honestly and — as
 *   of the step-up flow — offer the one thing that clears it.
 *
 *   WHICH GATE, PRECISELY. This comment used to say a credential flagged
 *   `requires_step_up` could not be rotated without one. That was wrong, and
 *   measurably so: helm.write_secret_version() gates on `sensitivity =
 *   'critical'`, while `requires_step_up` gates the READ path in
 *   helm.reveal_secret(). A standard-sensitivity secret flagged
 *   requires_step_up rotates without a step-up today. The asymmetry is real and
 *   is left as it is; documenting it wrongly is what had to stop.
 *
 * The plaintext lives in this component's state for as long as the form is open
 * and is never read back from the server — there is no endpoint that would
 * return it without an audited reveal, and this form deliberately does not call
 * one. Editing a credential should not require seeing it.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Loader2, Pencil, RotateCw } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { Modal } from './ui/modal';
import { useStepUp } from './step-up-dialog';
import { toAttemptResult, withStepUp } from '@/lib/ui/step-up';
import { changedFields, hasChanges, type FieldValue } from '@/lib/ui/form-diff';

const SENSITIVITIES = ['standard', 'elevated', 'critical'] as const;

const CREDENTIAL_TYPES = [
  'local_admin', 'domain_admin', 'service_account', 'standard_user', 'api',
  'database', 'wifi', 'vpn', 'root', 'recovery', 'shared_mailbox', 'other',
] as const;

const humanise = (v: string) => v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export interface CredentialValues extends Record<string, FieldValue> {
  label: string;
  name: string;
  username: string;
  url: string;
  notes: string;
  sensitivity: string;
  credentialType: string;
  requiresStepUp: boolean;
  requiresReason: boolean;
  isBreakGlass: boolean;
  criticality: number;
}

export function CredentialEditForm({
  secretId,
  values: initial,
  canEdit,
}: {
  secretId: string;
  values: CredentialValues;
  canEdit: boolean;
}) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<CredentialValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // The rotation half. Kept out of `values` so it can never be swept into the
  // metadata PATCH by a future edit to changedFields().
  const [rotating, setRotating] = useState(false);
  const [newValue, setNewValue] = useState('');
  const [reason, setReason] = useState('');

  const set = <K extends keyof CredentialValues>(key: K, value: CredentialValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  /*
   * `critical` is not a label, it is a policy. The schema enforces that a
   * critical credential requires both a step-up and a written reason, so
   * choosing it here turns both on rather than letting the save come back
   * refused — and the two boxes lock, because unticking one would make the
   * sensitivity unsaveable for a reason the form had not explained.
   */
  const locked = values.sensitivity === 'critical';
  function setSensitivity(next: string) {
    setValues((v) => ({
      ...v,
      sensitivity: next,
      requiresStepUp: next === 'critical' ? true : v.requiresStepUp,
      requiresReason: next === 'critical' ? true : v.requiresReason,
    }));
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setValues(initial);
      setRotating(false);
      setNewValue('');
      setReason('');
      setError(null);
      setSaved(null);
    }
  }

  async function saveMetadata(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const response = await fetch(`/api/secrets/${secretId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changedFields(initial, values)),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `The changes could not be saved (${response.status}).`);
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  /** One rotation attempt, reduced to stored-or-refused. */
  async function attemptRotate() {
    const response = await fetch(`/api/secrets/${secretId}/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: newValue, reason: reason.trim() }),
    });
    const body = await response.json().catch(() => null);
    return toAttemptResult<{ version?: number }>(
      response.ok,
      response.status,
      body,
      (b) => (b ?? {}) as { version?: number },
    );
  }

  async function rotate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      // A step-up refusal is not a failure, it is an instruction — and now one
      // the person can act on. The prompt opens; a success retries the rotation
      // they already typed, so the new value is not lost to a re-auth.
      const result = await withStepUp(attemptRotate, stepUp.prompt);

      if (!result.ok) {
        setError(result.message);
        return;
      }

      setNewValue('');
      setReason('');
      setRotating(false);
      setSaved(`Stored as version ${result.value.version ?? '?'}. The previous value is superseded.`);
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!canEdit) return null;

  return (
    <>
      {stepUp.dialog}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label={`Edit ${initial.label}`}
        title="Edit this credential"
      >
        <Pencil />
      </Button>

      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={`Edit ${initial.label}`}
        icon={KeyRound}
        description="Changing the stored value is a rotation, further down — it is audited differently from a correction."
        size="lg"
      >
        <form onSubmit={saveMetadata} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="cred-label">Label</Label>
              <Input
                id="cred-label"
                value={values.label}
                onChange={(e) => set('label', e.target.value)}
                required
                autoFocus
                maxLength={200}
              />
              <FieldHint>What the vault calls it.</FieldHint>
            </div>
            <div>
              <Label htmlFor="cred-name">Documented as</Label>
              <Input
                id="cred-name"
                value={values.name}
                onChange={(e) => set('name', e.target.value)}
                maxLength={200}
              />
              <FieldHint>What the asset list calls it.</FieldHint>
            </div>
            <div>
              <Label htmlFor="cred-username">Username</Label>
              <Input
                id="cred-username"
                value={values.username}
                onChange={(e) => set('username', e.target.value)}
                maxLength={200}
              />
            </div>
            <div>
              <Label htmlFor="cred-url">URL</Label>
              <Input
                id="cred-url"
                value={values.url}
                onChange={(e) => set('url', e.target.value)}
                maxLength={2000}
              />
            </div>
            <div>
              <Label htmlFor="cred-type">Account type</Label>
              <Select
                id="cred-type"
                value={values.credentialType}
                onChange={(e) => set('credentialType', e.target.value)}
              >
                {CREDENTIAL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanise(t)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="cred-sensitivity">Sensitivity</Label>
              <Select
                id="cred-sensitivity"
                value={values.sensitivity}
                onChange={(e) => setSensitivity(e.target.value)}
              >
                {SENSITIVITIES.map((s) => (
                  <option key={s} value={s}>
                    {humanise(s)}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="cred-notes">Notes</Label>
            <Textarea
              id="cred-notes"
              value={values.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={2}
              maxLength={4000}
            />
          </div>

          <fieldset className="space-y-2 rounded-md border border-border p-3">
            <legend className="px-1 text-xs font-medium text-ink-muted">Who may read it</legend>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={values.requiresStepUp}
                disabled={locked}
                onChange={(e) => set('requiresStepUp', e.target.checked)}
                className="size-4 rounded border-border-strong"
              />
              Require re-authentication to reveal
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={values.requiresReason}
                disabled={locked}
                onChange={(e) => set('requiresReason', e.target.checked)}
                className="size-4 rounded border-border-strong"
              />
              Require a written reason to reveal
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={values.isBreakGlass}
                onChange={(e) => set('isBreakGlass', e.target.checked)}
                className="size-4 rounded border-border-strong"
              />
              Break-glass account
            </label>
            <FieldHint>
              {locked
                ? 'A critical credential always requires both. Lower the sensitivity to change them.'
                : 'Tightening these takes effect on the next read.'}{' '}
              Tightening takes effect on the next read. They apply to rotation too — a
              credential that needs re-authentication to see needs it to change.
            </FieldHint>
          </fieldset>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {saved && <p className="text-sm text-ok">{saved}</p>}

          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !hasChanges(initial, values) || !values.label.trim()}
            >
              {busy && <Loader2 className="animate-spin" />}
              Save changes
            </Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>

        <div className="mt-5 border-t border-border pt-4">
          {!rotating ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setRotating(true)}>
              <RotateCw />
              Change the stored value
            </Button>
          ) : (
            // A nested <form> is invalid HTML, so the rotation fields are a
            // plain block whose button submits them explicitly.
            <div className="space-y-3">
              <div>
                <Label htmlFor="cred-value">New value</Label>
                <Input
                  id="cred-value"
                  type="password"
                  value={newValue}
                  autoComplete="new-password"
                  onChange={(e) => setNewValue(e.target.value)}
                />
                <FieldHint>
                  Stored as a new version. The old one is superseded, not deleted, so an export
                  taken yesterday still makes sense.
                </FieldHint>
              </div>
              <div>
                <Label htmlFor="cred-reason">Why</Label>
                <Input
                  id="cred-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. rotated after the Miller offboarding"
                  maxLength={500}
                />
                <FieldHint>
                  At least ten characters. This is the line somebody reads in the audit log a year
                  from now.
                </FieldHint>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  disabled={busy || !newValue || reason.trim().length < 10}
                  onClick={rotate}
                >
                  {busy && <Loader2 className="animate-spin" />}
                  Rotate
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setRotating(false);
                    setNewValue('');
                    setReason('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
