'use client';

/**
 * Edit what an asset records about its own kind: a network's subnet and
 * gateway, a device's serial and warranty, a contract's dates.
 *
 * Driven entirely by the catalogue in src/lib/assets/detail-fields.ts, which
 * is the same list the Details card reads, so the form and the card cannot
 * disagree about what a network has. The header's Edit button writes the
 * columns every asset shares; this one writes the subtype row, through
 * PATCH /api/assets/:id/detail.
 *
 * Only changed fields are sent. An empty text clears a column; a required one
 * (a kind, a domain name) cannot be cleared and the form says so before the
 * database would.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, SlidersHorizontal } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { Modal } from './ui/modal';
import { PasswordGenerator } from './password-generator';
import { useStepUp } from './step-up-dialog';
import { withStepUp } from '@/lib/ui/step-up';
import { apiFetch } from '@/lib/ui/api';
import { humanise } from '@/lib/ui/format';
import { toDateTimeLocalInput, fromDateTimeLocalInput } from '@/lib/ui/format';
import type { DetailField } from '@/lib/assets/detail-fields';

export type Draft = Record<string, string | boolean>;

/** A stored value as the form holds it: text for everything but a checkbox. */
export function toDraft(fields: readonly DetailField[], values: Record<string, unknown>): Draft {
  const draft: Draft = {};
  for (const f of fields) {
    const v = values[f.key];
    switch (f.kind) {
      case 'boolean':
        draft[f.key] = v === true;
        break;
      case 'text_list':
        draft[f.key] = Array.isArray(v) ? v.join('\n') : '';
        break;
      case 'inet_list':
        draft[f.key] = Array.isArray(v) ? v.map((x) => host(String(x))).join('\n') : '';
        break;
      case 'date':
        draft[f.key] = typeof v === 'string' ? v.slice(0, 10) : '';
        break;
      case 'datetime':
        draft[f.key] = typeof v === 'string' ? toDateTimeLocalInput(v) : '';
        break;
      default:
        draft[f.key] = v === null || v === undefined ? '' : f.pg === 'inet' ? host(String(v)) : String(v);
    }
  }
  return draft;
}

/** Postgres renders a host address as 10.10.4.1/32; the form shows the address. */
const host = (v: string) => v.replace(/\/(32|128)$/, '');

/** The request value for a changed field. */
export function toPayload(f: DetailField, v: string | boolean): unknown {
  if (f.kind === 'boolean') return v === true;
  const s = String(v).trim();
  if (s === '') return null;
  if (f.kind === 'datetime') return fromDateTimeLocalInput(s);
  if (f.kind === 'text_list' || f.kind === 'inet_list') return s;
  return s;
}

/**
 * A credential's password, when the person may change it here: a rotation of
 * the stored one (a new version, and a reason for the audit log), or the
 * first one on a credential that has none.
 */
export type PasswordEdit = { mode: 'change'; secretId: string } | { mode: 'set' };

export function DetailEditForm({
  nodeId,
  nodeType,
  fields,
  values,
  password,
}: {
  nodeId: string;
  nodeType: string;
  fields: readonly DetailField[];
  values: Record<string, unknown>;
  password?: PasswordEdit | undefined;
}) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(fields, values));
  const [newPassword, setNewPassword] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initial = toDraft(fields, values);
  const changed = fields.filter((f) => draft[f.key] !== initial[f.key]);
  const missing = changed.filter((f) => f.required && f.kind !== 'boolean' && String(draft[f.key]).trim() === '');
  const changingPassword = password !== undefined && newPassword !== '';
  // A rotation is the one credential event whose reason is read later.
  const reasonShort = changingPassword && password.mode === 'change' && reason.trim().length < 10;

  function reset() {
    setDraft(toDraft(fields, values));
    setNewPassword('');
    setReason('');
    setError(null);
  }

  /*
   * The password goes through its own audited endpoint, never the detail
   * PATCH: a rotation and a corrected username are different events, and
   * the second must not carry the first under its name. Read at call time so
   * the step-up retry sends what is in the boxes then.
   */
  const attemptPassword = () =>
    password?.mode === 'change'
      ? apiFetch(`/api/secrets/${password.secretId}/rotate`, { json: { value: newPassword, reason: reason.trim() } })
      : apiFetch(`/api/assets/${nodeId}/password`, { method: 'PUT', json: { value: newPassword } });

  async function save() {
    if (missing.length > 0) {
      setError(`${missing.map((f) => f.label).join(', ')} cannot be empty`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (changed.length > 0) {
        const payload = Object.fromEntries(changed.map((f) => [f.key, toPayload(f, draft[f.key]!)]));
        const result = await apiFetch(`/api/assets/${nodeId}/detail`, { method: 'PATCH', json: payload });
        if (!result.ok) {
          setError(result.message);
          return;
        }
      }
      if (changingPassword) {
        const result = await withStepUp(attemptPassword, stepUp.prompt);
        if (!result.ok) {
          setError(changed.length > 0
            ? `The details were saved, but the password was not changed: ${result.message}`
            : result.message);
          router.refresh();
          return;
        }
      }
      setOpen(false);
      reset();
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const set = (key: string, value: string | boolean) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <>
      {stepUp.dialog}
      <Button variant="secondary" size="sm" onClick={() => { reset(); setOpen(true); }}>
        <SlidersHorizontal className="size-3.5" aria-hidden />
        Edit details
      </Button>
      <Modal
        open={open}
        onOpenChange={(next) => { setOpen(next); if (!next) reset(); }}
        title={`${humanise(nodeType)} details`}
        description="What this kind of asset records about itself. Leave a field blank to clear it."
        size="lg"
      >
        <div className="space-y-4">
          <DetailFieldInputs fields={fields} draft={draft} set={set} />

          {password && (
            <fieldset className="space-y-3 rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium text-ink">
                {password.mode === 'change' ? 'Change password' : 'Set a password'}
              </legend>
              <div className="space-y-1.5">
                <Label htmlFor={`detail-password-${nodeId}`}>
                  {password.mode === 'change' ? 'New password' : 'Password'}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id={`detail-password-${nodeId}`}
                    type="password"
                    value={newPassword}
                    autoComplete="new-password"
                    placeholder={password.mode === 'change' ? 'Leave empty to keep the current one' : 'None is stored yet'}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                  <PasswordGenerator onUse={setNewPassword} />
                </div>
                {password.mode === 'change' && (
                  <FieldHint>Stored as a new version. The previous one is superseded, not deleted.</FieldHint>
                )}
              </div>
              {password.mode === 'change' && changingPassword && (
                <div className="space-y-1.5">
                  <Label htmlFor={`detail-password-reason-${nodeId}`}>Why</Label>
                  <Input
                    id={`detail-password-reason-${nodeId}`}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. rotated after the Miller offboarding"
                    maxLength={500}
                  />
                  <FieldHint>At least ten characters. Recorded in the audit log with the change.</FieldHint>
                </div>
              )}
            </fieldset>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">{error}</p>
          )}

          <div className="flex gap-2 border-t border-border pt-3">
            <Button type="button" variant="primary" onClick={() => void save()} disabled={busy || (changed.length === 0 && !changingPassword) || reasonShort}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setOpen(false); reset(); }} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/**
 * The inputs for a kind's detail fields, one per field, laid out in two
 * columns. Shared by Edit details and by the create dialog for kinds that ask
 * for everything up front (a domain), so a field looks and behaves the same in
 * both — and a field added to the catalogue appears in both.
 */
export function DetailFieldInputs({
  fields,
  draft,
  set,
  idPrefix = 'detail',
}: {
  fields: readonly DetailField[];
  draft: Draft;
  set: (key: string, value: string | boolean) => void;
  idPrefix?: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const value = draft[f.key];
        const wide = f.kind === 'textarea' || f.kind === 'text_list' || f.kind === 'inet_list';
        return (
          <div key={f.key} className={wide ? 'sm:col-span-2' : undefined}>
            {f.kind === 'boolean' ? (
              <label htmlFor={id} className="flex items-center gap-2 pt-5 text-sm text-ink">
                <input
                  id={id}
                  type="checkbox"
                  checked={value === true}
                  onChange={(e) => set(f.key, e.target.checked)}
                />
                {f.label}
              </label>
            ) : (
              <>
                <Label htmlFor={id}>{f.label}{f.required && ' *'}</Label>
                {f.kind === 'select' ? (
                  <Select id={id} value={String(value ?? '')} onChange={(e) => set(f.key, e.target.value)}>
                    {!f.required && <option value="">—</option>}
                    {f.options?.map((o) => (
                      <option key={o} value={o}>{humanise(o)}</option>
                    ))}
                  </Select>
                ) : wide ? (
                  <Textarea
                    id={id}
                    rows={f.kind === 'textarea' ? 3 : 2}
                    value={String(value ?? '')}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                ) : (
                  <Input
                    id={id}
                    type={
                      f.kind === 'number' ? 'number'
                        : f.kind === 'date' ? 'date'
                          : f.kind === 'datetime' ? 'datetime-local'
                            : 'text'
                    }
                    {...(f.min !== undefined ? { min: f.min } : {})}
                    {...(f.max !== undefined ? { max: f.max } : {})}
                    {...(f.kind === 'number' && f.pg === 'numeric' ? { step: 'any' } : {})}
                    value={String(value ?? '')}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                )}
                {f.hint && <FieldHint>{f.hint}</FieldHint>}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
