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

export function DetailEditForm({
  nodeId,
  nodeType,
  fields,
  values,
}: {
  nodeId: string;
  nodeType: string;
  fields: readonly DetailField[];
  values: Record<string, unknown>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(fields, values));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initial = toDraft(fields, values);
  const changed = fields.filter((f) => draft[f.key] !== initial[f.key]);
  const missing = changed.filter((f) => f.required && f.kind !== 'boolean' && String(draft[f.key]).trim() === '');

  function reset() {
    setDraft(toDraft(fields, values));
    setError(null);
  }

  async function save() {
    if (missing.length > 0) {
      setError(`${missing.map((f) => f.label).join(', ')} cannot be empty`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = Object.fromEntries(changed.map((f) => [f.key, toPayload(f, draft[f.key]!)]));
      const result = await apiFetch(`/api/assets/${nodeId}/detail`, { method: 'PATCH', json: payload });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const set = (key: string, value: string | boolean) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <>
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

          {error && (
            <p role="alert" className="text-sm text-danger">{error}</p>
          )}

          <div className="flex gap-2 border-t border-border pt-3">
            <Button type="button" variant="primary" onClick={() => void save()} disabled={busy || changed.length === 0}>
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
