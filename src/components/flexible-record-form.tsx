'use client';

/**
 * Filling in a technician-defined template.
 *
 * WHAT WAS MISSING. Group C gave the type a screen; a type with no records is
 * a form nobody filled in. The write path existed from 0080 — validated,
 * versioned, secrets split out and encrypted — and the only way to reach it was
 * an API call. The "+ New" button on a type's page was literally inert: a
 * styled element with no handler.
 *
 * THE FORM IS THE SCHEMA, READ BACK. Every control here comes from
 * schemaToFields() over the type's published version, so a field the author
 * added in the type editor appears here without anything being written twice.
 * The pairing is the point: the two screens share one field model and one
 * conversion, in src/lib/flexible/fields.ts.
 *
 * THE DOCUMENT IS REPLACED, NOT MERGED. The form renders every field the
 * current version declares and submits all of them, so clearing a box clears
 * the value, and a key left over from an older version of the template
 * disappears on the first save. That is what makes an edit a migration — see
 * PATCH /api/flexible-assets/records/[recordId], which is where the decision is
 * written down.
 *
 * SECRET BOXES ARE ALWAYS EMPTY. A record's secret values live in
 * flexible_asset_secret and never reach a browser, so there is nothing to
 * prefill and blank has to mean "unchanged". Typing in one rotates the stored
 * secret through the audited path; leaving it alone touches nothing.
 *
 * ERRORS COME FROM THE SERVER. The schema is the authority and Ajv is the only
 * thing that implements it, so rather than reimplement a second validator here,
 * the form marks `required` for the browser's own benefit and then renders
 * whatever the API says against the field it names. A message beside the
 * offending box is the whole reason the API returns field pointers.
 */
import { useMemo, useState } from 'react';
import { PasswordGenerator } from './password-generator';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Modal, ModalTrigger } from './ui/modal';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { FIELD_KIND_INFO, pointerFor, type FieldDef } from '@/lib/flexible/fields';
import { apiFetch } from '@/lib/ui/api';

/** The template being filled in. */
export interface RecordFormType {
  id: string;
  name: string;
  /** From the CURRENT published version — what a save will be checked against. */
  fields: FieldDef[];
}

/** The record being edited. Absent when creating. */
export interface RecordFormRecord {
  nodeId: string;
  /** flexible_asset_record.data — secret fields are not in here and never were. */
  values: Record<string, unknown>;
  /** Pointers whose secret is already stored, so the box can say "unchanged". */
  heldSecrets: string[];
}

/** One control's state. Numbers live as text until submit; see toDocument(). */
type Draft = Record<string, string | boolean>;

function initialDraft(fields: readonly FieldDef[], values: Record<string, unknown>): Draft {
  const draft: Draft = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.kind === 'boolean') {
      draft[field.key] = value === true;
    } else if (field.kind === 'secret') {
      // Nothing to prefill: the value is not in `values` and could not be.
      draft[field.key] = '';
    } else {
      draft[field.key] = value === null || value === undefined ? '' : String(value);
    }
  }
  return draft;
}

/**
 * The draft as the document the API will validate.
 *
 * Coercion happens HERE rather than being left to the server, because Ajv runs
 * with coerceTypes: false on purpose — "5" must not silently become 5. An HTML
 * input only ever produces strings, so something has to convert, and doing it
 * in the one place that knows each field's kind beats teaching the validator to
 * guess.
 *
 * A blank optional field is OMITTED rather than sent as "". An empty string
 * fails `format: 'email'` and `format: 'date'`, so sending it would turn "I
 * left this blank" into "this is not a valid address".
 */
export function toDocument(fields: readonly FieldDef[], draft: Draft): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = draft[field.key];

    if (field.kind === 'boolean') {
      // Always sent. `false` is an answer, and omitting it would make "no"
      // indistinguishable from "unanswered".
      data[field.key] = raw === true;
      continue;
    }

    const text = typeof raw === 'string' ? raw : '';

    if (field.kind === 'secret') {
      // Blank means unchanged on an edit and absent on a create. Never "".
      if (text !== '') data[field.key] = text;
      continue;
    }

    if (field.kind === 'number' || field.kind === 'integer') {
      if (text.trim() === '') continue;
      const parsed = Number(text);
      // Unparseable goes through as the text it was, so the server names the
      // field and says what it wanted. Dropping it would report "required"
      // for a box the technician can plainly see they filled in.
      data[field.key] = Number.isFinite(parsed) ? parsed : text;
      continue;
    }

    // `textarea` keeps its interior whitespace — a wrapped address or a
    // pasted connection string is meant to look the way it was typed. Every
    // other textual kind is a single line where surrounding spaces are a
    // typo, and `format: 'email'` would reject them anyway.
    const value = field.kind === 'textarea' ? text : text.trim();
    if (value.trim() === '') continue;
    data[field.key] = value;
  }

  return data;
}

export function FlexibleRecordForm({
  type,
  organizationId,
  sites,
  record,
  trigger,
}: {
  type: RecordFormType;
  organizationId: string;
  /** The client's sites, for the create form's picker. Editing uses AssetForm. */
  sites: { id: string; name: string }[];
  record?: RecordFormRecord;
  trigger: React.ReactNode;
}) {
  const router = useRouter();
  const editing = record !== undefined;
  const held = useMemo(() => new Set(record?.heldSecrets ?? []), [record]);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState('');
  const [draft, setDraft] = useState<Draft>(() => initialDraft(type.fields, record?.values ?? {}));

  /**
   * Reset on BOTH edges, and the opening one is not symmetry for its own sake.
   *
   * A successful edit calls router.refresh(), which re-renders the server
   * component and delivers the saved values as new props. React reconciles
   * this component in place, so its state survives — and a draft initialised
   * once, or reset only on close, would still be holding what was on screen
   * BEFORE the save. Reopening the dialog would show the pre-edit values over
   * a record that no longer has them, and saving again would quietly put them
   * back.
   */
  function onOpenChange(next: boolean) {
    setOpen(next);
    setName('');
    setSiteId('');
    setDraft(initialDraft(type.fields, record?.values ?? {}));
    setError(null);
    setFieldErrors({});
  }

  const set = (key: string, value: string | boolean) =>
    setDraft((d) => ({ ...d, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const data = toDocument(type.fields, draft);

    try {
      const result = editing
        ? await apiFetch(`/api/flexible-assets/records/${record.nodeId}`, {
            method: 'PATCH',
            json: { data },
          })
        : await apiFetch<{ nodeId?: string }>('/api/flexible-assets/records', {
            json: {
              typeId: type.id,
              organizationId,
              name: name.trim(),
              ...(siteId === '' ? {} : { siteId }),
              data,
            },
          });

      if (!result.ok) {
        // `path` is a JSON Pointer into the document, which is the field key
        // with a leading slash. The root pointer belongs to the whole form.
        const fields = (result.details?.fields ?? []) as { path: string; message: string }[];
        const byKey: Record<string, string> = {};
        let unplaced = 0;
        for (const issue of fields) {
          const key = issue.path.replace(/^\//, '');
          if (key !== '' && key in draft) byKey[key] = issue.message;
          else unplaced += 1;
        }
        setFieldErrors(byKey);
        // The form-level message is suppressed only when EVERY issue found a
        // field to sit beside. Counting placements rather than comparing sizes,
        // because two issues on one field collapse to one entry and the sizes
        // would stop matching for a reason that is not a missed message.
        setError(fields.length > 0 && unplaced === 0 ? null : result.message);
        return;
      }

      onOpenChange(false);
      if (editing) {
        router.refresh();
      } else {
        const created = result.value as { nodeId?: string } | undefined;
        if (created?.nodeId) router.push(`/assets/${created.nodeId}`);
        else router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* onOpenChange rather than setOpen: opening is where the draft is
          re-seeded from props, so bypassing it is the bug the comment above
          describes. */}
      <ModalTrigger onOpen={() => onOpenChange(true)}>{trigger}</ModalTrigger>

      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={editing ? `Edit ${type.name} details` : `New ${type.name}`}
        description={
          editing
            ? 'Saving checks this against the template’s current version. Secret boxes are blank because stored secrets are never sent to a browser — leave one alone to keep its value.'
            : 'The fields below come from the template. Name, site and the rest of the asset can be changed afterwards.'
        }
        size={type.fields.length > 6 ? 'lg' : 'md'}
      >
        <form onSubmit={submit} className="space-y-4">
          {!editing && (
            <>
              <div>
                <Label htmlFor="record-name">Name</Label>
                <Input
                  id="record-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoFocus
                  maxLength={200}
                />
                <FieldHint>How this appears in lists, search and dependency links.</FieldHint>
              </div>

              {sites.length > 0 && (
                <div>
                  <Label htmlFor="record-site">Site</Label>
                  <Select
                    id="record-site"
                    value={siteId}
                    onChange={(e) => setSiteId(e.target.value)}
                  >
                    <option value="">No site</option>
                    {sites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </>
          )}

          {type.fields.length === 0 ? (
            <p className="text-sm text-ink-faint">
              This template has no fields yet. Add some in Administration → Documentation types.
            </p>
          ) : (
            <div className="space-y-4">
              {type.fields.map((field) => (
                <RecordField
                  key={field.key}
                  field={field}
                  value={draft[field.key] ?? ''}
                  onChange={(value) => set(field.key, value)}
                  error={fieldErrors[field.key]}
                  secretHeld={held.has(pointerFor(field.key))}
                />
              ))}
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || (!editing && name.trim() === '')}
            >
              {busy && <Loader2 className="animate-spin" />}
              {editing ? 'Save changes' : `Create ${type.name}`}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/** One field, drawn according to its kind. */
function RecordField({
  field,
  value,
  onChange,
  error,
  secretHeld,
}: {
  field: FieldDef;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
  error: string | undefined;
  secretHeld: boolean;
}) {
  const id = `record-field-${field.key}`;
  const text = typeof value === 'string' ? value : '';
  // `required` is given to the browser as a courtesy, and withheld from a
  // secret the record already holds: the box is blank because the value is
  // stored, and demanding it again is the thing this form exists not to do.
  const required = field.required && !(field.kind === 'secret' && secretHeld);

  const described = [
    error ? `${id}-error` : null,
    field.help || field.kind === 'secret' ? `${id}-hint` : null,
  ].filter((v): v is string => v !== null);
  const shared = {
    id,
    required,
    ...(described.length > 0 ? { 'aria-describedby': described.join(' ') } : {}),
    ...(error ? { 'aria-invalid': true as const } : {}),
  };

  return (
    <div>
      {field.kind === 'boolean' ? (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="size-4 rounded border-border-strong"
            {...shared}
          />
          {field.label}
        </label>
      ) : (
        <>
          <Label htmlFor={id}>
            {field.label}
            {required && <span className="ml-1 text-danger">*</span>}
            {field.kind === 'secret' && (
              <Badge tone="neutral" className="ml-2">
                Encrypted
              </Badge>
            )}
          </Label>

          {field.kind === 'textarea' ? (
            <Textarea
              {...shared}
              value={text}
              onChange={(e) => onChange(e.target.value)}
              rows={3}
              {...(field.maxLength === undefined ? {} : { maxLength: field.maxLength })}
            />
          ) : field.kind === 'select' ? (
            <Select {...shared} value={text} onChange={(e) => onChange(e.target.value)}>
              {/* A blank first option, so an optional choice can stay unanswered
                  rather than silently defaulting to whichever option is first. */}
              <option value="">{field.required ? 'Choose…' : 'Not set'}</option>
              {(field.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          ) : field.kind === 'secret' ? (
            <div className="flex gap-2">
              <Input
                {...shared}
                type={inputType(field)}
                value={text}
                onChange={(e) => onChange(e.target.value)}
                autoComplete="new-password"
                placeholder={secretHeld ? 'Unchanged' : ''}
              />
              <PasswordGenerator onUse={onChange} />
            </div>
          ) : (
            <Input
              {...shared}
              type={inputType(field)}
              value={text}
              onChange={(e) => onChange(e.target.value)}
              {...(field.kind === 'number' || field.kind === 'integer'
                ? {
                    step: field.kind === 'integer' ? 1 : 'any',
                    ...(field.min === undefined ? {} : { min: field.min }),
                    ...(field.max === undefined ? {} : { max: field.max }),
                  }
                : {})}
              {...(field.maxLength === undefined ? {} : { maxLength: field.maxLength })}
            />
          )}
        </>
      )}

      {(field.help || field.kind === 'secret') && (
        <FieldHint id={`${id}-hint`}>
          {field.help}
          {field.help && field.kind === 'secret' ? ' ' : ''}
          {field.kind === 'secret' &&
            (secretHeld
              ? 'Leave blank to keep the stored value. Typing a new one rotates it, and the old one stays in the history.'
              : FIELD_KIND_INFO.secret.hint)}
        </FieldHint>
      )}

      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function inputType(field: FieldDef): string {
  switch (field.kind) {
    case 'secret':
      return 'password';
    case 'date':
      return 'date';
    case 'email':
      return 'email';
    case 'url':
      return 'url';
    case 'number':
    case 'integer':
      return 'number';
    default:
      return 'text';
  }
}
