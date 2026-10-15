'use client';

/**
 * Defining a custom asset type, without typing JSON Schema.
 *
 * WHAT WAS MISSING. The documentation model has been complete and versioned
 * since 0080 — a type, immutable published schema versions, records validated
 * against them, secret fields split out and encrypted. What it never had was a
 * screen. A type arrived by API call or by SQL, which means in practice that
 * nobody but its author ever created one.
 *
 * THE FORM EDITS FIELDS, NOT A SCHEMA. src/lib/flexible/fields.ts owns the
 * conversion in both directions and is unit-tested against the real schema
 * guard; this component is the editing surface over that model and holds no
 * opinion about JSON Schema at all. In particular it cannot emit a `pattern`,
 * which is the one thing in a hand-authored schema that can take the server
 * down — see the guard's header on backtracking regular expressions.
 *
 * PUBLISHING IS NOT SAVING, and the form says so rather than pretending
 * otherwise. A published version is immutable, so every edit to the fields
 * creates version N+1 and leaves N in place for the records that reference it.
 * The dialog shows how many records exist and, once the new shape is known to
 * be incompatible, that they will be flagged for migration. A "Save" button
 * that quietly forked the schema would be the wrong word for it.
 *
 * VALIDATION IS SHOWN, NOT ENFORCED HERE. validateFields() gives a message
 * next to the offending row, because an error arriving from Postgres names no
 * row. The authority is still the API: the schema guard inspects every
 * publish, and this component's agreement with it is a convenience the tests
 * pin rather than a second gate.
 */
import { useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { Modal, ModalTrigger } from './ui/modal';
import { Button } from './ui/button';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { Badge } from './ui/badge';
import {
  FIELD_KINDS, FIELD_KIND_INFO, fieldsToSchema, searchableCandidates, searchablePointers,
  validateFields, type FieldDef, type FieldKind,
} from '@/lib/flexible/fields';
import { cn } from '@/lib/ui/cn';
import { apiFetch } from '@/lib/ui/api';

export interface EditableType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  colour: string | null;
  clientVisible: boolean;
  currentVersion: number | null;
  fields: FieldDef[];
  searchableFields: string[];
  recordCount: number;
}

/** A blank field, named so two in a row do not collide. */
function blankField(index: number): FieldDef {
  return { key: `field_${index + 1}`, label: '', kind: 'text', required: false };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 63)
    .replace(/^[^a-z]/, 'f');
}

export function FlexibleTypeEditor({
  type,
  trigger,
}: {
  /** Absent when creating. */
  type?: EditableType;
  trigger: React.ReactNode;
}) {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editing = type !== undefined;
  const [name, setName] = useState(type?.name ?? '');
  const [key, setKey] = useState(type?.key ?? '');
  const [description, setDescription] = useState(type?.description ?? '');
  const [icon, setIcon] = useState(type?.icon ?? '');
  const [colour, setColour] = useState(type?.colour ?? '');
  const [clientVisible, setClientVisible] = useState(type?.clientVisible ?? false);
  const [fields, setFields] = useState<FieldDef[]>(
    type?.fields.length ? type.fields : [blankField(0)],
  );
  const [searchable, setSearchable] = useState<Set<string>>(
    // Stored as pointers; the checkboxes are keyed by field name.
    new Set((type?.searchableFields ?? []).map((p) => p.replace(/^\//, ''))),
  );
  const [changeNote, setChangeNote] = useState('');

  const issues = useMemo(() => validateFields(fields), [fields]);
  const issueFor = (fieldKey: string) =>
    issues.filter((i) => i.key === fieldKey).map((i) => i.message);
  const listIssues = issues.filter((i) => i.key === '').map((i) => i.message);

  function patchField(index: number, patch: Partial<FieldDef>): void {
    setFields((current) => current.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  function move(index: number, by: number): void {
    const target = index + by;
    if (target < 0 || target >= fields.length) return;
    setFields((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (issues.length > 0) return;
    setBusy(true);
    setError(null);

    const { jsonSchema, uiSchema } = fieldsToSchema(fields);
    const searchableFields = searchablePointers(fields, [...searchable]);

    try {
      const result = editing
        ? await apiFetch(`/api/flexible-assets/types/${type.id}/versions`, {
            json: {
              jsonSchema, uiSchema, searchableFields,
              ...(changeNote ? { changeNote } : {}),
            },
          })
        : await apiFetch('/api/flexible-assets/types', {
            json: {
              key: key || slugify(name),
              name,
              ...(description ? { description } : {}),
              clientVisible,
              jsonSchema, uiSchema, searchableFields,
              ...(changeNote ? { changeNote } : {}),
            },
          });

      if (!result.ok) {
        // The API's issue list is the useful part when the guard refuses a
        // schema; a bare "400" sends somebody back to guess.
        const detail = result.details
          ? ` — ${JSON.stringify(result.details)}`
          : '';
        setError(`${result.message}${detail}`);
        return;
      }

      // Metadata lives on the type rather than on a version, so an edit that
      // also renames or recolours sends a second request. Only when something
      // actually changed.
      if (editing) {
        const metadata: Record<string, unknown> = {};
        if (name !== type.name) metadata.name = name;
        if ((description || null) !== type.description) metadata.description = description || null;
        if ((icon || null) !== type.icon) metadata.icon = icon || null;
        if ((colour || null) !== type.colour) metadata.colour = colour || null;
        if (clientVisible !== type.clientVisible) metadata.clientVisible = clientVisible;
        if (Object.keys(metadata).length > 0) {
          await apiFetch(`/api/flexible-assets/types/${type.id}`, {
            method: 'PATCH',
            json: metadata,
          });
        }
      }

      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ModalTrigger onOpen={() => setOpen(true)}>{trigger}</ModalTrigger>
      <Modal
        open={open}
        onOpenChange={setOpen}
        size="lg"
        title={editing ? `Edit ${type.name}` : 'New asset type'}
        description={
          editing
            ? `Publishing replaces version ${type.currentVersion ?? 1}. The old version stays for the ${type.recordCount} record${type.recordCount === 1 ? '' : 's'} written against it.`
            : 'Define the fields a record of this type will have. The schema is published as version 1.'
        }
      >
        <form id={formId} onSubmit={submit} className="space-y-5 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor={`${formId}-name`}>Name</Label>
              <Input
                id={`${formId}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Microsoft 365 tenant"
                required
              />
            </div>
            <div>
              <Label htmlFor={`${formId}-key`}>Identifier</Label>
              <Input
                id={`${formId}-key`}
                value={editing ? type.key : (key || slugify(name))}
                onChange={(e) => setKey(e.target.value)}
                disabled={editing}
                readOnly={editing}
              />
              <FieldHint>
                {editing
                  ? 'Fixed once created: an integration may refer to it.'
                  : 'Used by the API. Derived from the name unless you change it.'}
              </FieldHint>
            </div>
          </div>

          <div>
            <Label htmlFor={`${formId}-description`}>Description</Label>
            <Textarea
              id={`${formId}-description`}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor={`${formId}-icon`}>Icon</Label>
              <Input
                id={`${formId}-icon`}
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="Cloud"
              />
              <FieldHint>A lucide icon name. The sidebar falls back if it is unknown.</FieldHint>
            </div>
            <div>
              <Label htmlFor={`${formId}-colour`}>Colour</Label>
              <Input
                id={`${formId}-colour`}
                value={colour}
                onChange={(e) => setColour(e.target.value)}
                placeholder="#1188ff"
              />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-ink-muted">
                <input
                  type="checkbox"
                  checked={clientVisible}
                  onChange={(e) => setClientVisible(e.target.checked)}
                  className="size-4 rounded border-border"
                />
                Client-visible
              </label>
            </div>
          </div>
          {clientVisible && (
            <p className="rounded-md border border-sev-warning/40 bg-sev-warning/10 px-3 py-2 text-xs text-ink">
              Records of this type will be readable by client-side roles in the
              organisations they are scoped to.
            </p>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label>Fields</Label>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setFields((f) => [...f, blankField(f.length)])}
              >
                <Plus className="size-3.5" aria-hidden /> Add field
              </Button>
            </div>

            <div className="space-y-2">
              {fields.map((field, index) => {
                const problems = issueFor(field.key);
                const info = FIELD_KIND_INFO[field.kind];
                return (
                  <div
                    key={index}
                    className={cn(
                      'rounded-md border p-3',
                      problems.length > 0 ? 'border-danger/50 bg-danger/5' : 'border-border',
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex flex-col pt-1.5">
                        <button
                          type="button"
                          aria-label="Move up"
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                          className="text-ink-faint hover:text-ink disabled:opacity-30"
                        >
                          <GripVertical className="size-4" aria-hidden />
                        </button>
                      </div>
                      <div className="grid flex-1 gap-2 sm:grid-cols-3">
                        <Input
                          aria-label="Label"
                          value={field.label}
                          placeholder="Label"
                          onChange={(e) => {
                            const label = e.target.value;
                            // The identifier follows the label until somebody
                            // edits it, which is what people expect and what
                            // stops a form full of field_1, field_2.
                            patchField(index, {
                              label,
                              ...(field.key.startsWith('field_') ? { key: slugify(label) || field.key } : {}),
                            });
                          }}
                        />
                        <Input
                          aria-label="Identifier"
                          value={field.key}
                          onChange={(e) => patchField(index, { key: e.target.value })}
                          className="font-mono text-xs"
                        />
                        <Select
                          aria-label="Kind"
                          value={field.kind}
                          onChange={(e) => {
                            const kind = e.target.value as FieldKind;
                            // Replaced rather than patched: with
                            // exactOptionalPropertyTypes, `options: undefined`
                            // is not assignable to an optional string[], so the
                            // key has to be deleted. Dropping it when the kind
                            // no longer takes options is what keeps
                            // validateFields from complaining about data the
                            // form has stopped showing.
                            setFields((current) => current.map((f, i) => {
                              if (i !== index) return f;
                              const next: FieldDef = { ...f, kind };
                              if (!FIELD_KIND_INFO[kind].takesOptions) delete next.options;
                              return next;
                            }));
                            if (kind === 'secret') {
                              setSearchable((s) => {
                                const next = new Set(s);
                                next.delete(field.key);
                                return next;
                              });
                            }
                          }}
                        >
                          {FIELD_KINDS.map((kind) => (
                            <option key={kind} value={kind}>{FIELD_KIND_INFO[kind].label}</option>
                          ))}
                        </Select>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${field.label || field.key}`}
                        onClick={() => setFields((f) => f.filter((_, i) => i !== index))}
                        className="pt-1.5 text-ink-faint hover:text-danger"
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </button>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pl-6 text-xs">
                      <label className="flex items-center gap-1.5 text-ink-muted">
                        <input
                          type="checkbox"
                          checked={field.required}
                          onChange={(e) => patchField(index, { required: e.target.checked })}
                          className="size-3.5 rounded border-border"
                        />
                        Required
                      </label>
                      {field.kind !== 'secret' && (
                        <label className="flex items-center gap-1.5 text-ink-muted">
                          <input
                            type="checkbox"
                            checked={searchable.has(field.key)}
                            onChange={(e) => setSearchable((s) => {
                              const next = new Set(s);
                              if (e.target.checked) next.add(field.key); else next.delete(field.key);
                              return next;
                            })}
                            className="size-3.5 rounded border-border"
                          />
                          Searchable
                        </label>
                      )}
                      {field.kind === 'secret' && (
                        <Badge tone="critical">Encrypted, never indexed</Badge>
                      )}
                      <span className="text-ink-faint">{info.hint}</span>
                    </div>

                    {info.takesOptions && (
                      <div className="mt-2 pl-6">
                        <Input
                          aria-label="Options"
                          placeholder="bronze, silver, gold"
                          value={(field.options ?? []).join(', ')}
                          onChange={(e) => patchField(index, {
                            options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean),
                          })}
                        />
                      </div>
                    )}

                    {problems.map((message) => (
                      <p key={message} className="mt-2 pl-6 text-xs text-danger">{message}</p>
                    ))}
                  </div>
                );
              })}
            </div>

            {listIssues.map((message) => (
              <p key={message} className="mt-2 text-xs text-danger">{message}</p>
            ))}
            {searchableCandidates(fields).length === 0 && fields.length > 0 && (
              <FieldHint>Every field is a secret, so none can be indexed for search.</FieldHint>
            )}
          </div>

          {editing && (
            <div>
              <Label htmlFor={`${formId}-note`}>What changed</Label>
              <Input
                id={`${formId}-note`}
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
                placeholder="Added the renewal date"
              />
              <FieldHint>
                Stored with the version. The next person to read this history is
                probably trying to work out why a record stopped validating.
              </FieldHint>
            </div>
          )}

          {error && (
            <p className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="cta" disabled={busy || issues.length > 0}>
              {busy
                ? 'Publishing…'
                : editing
                  ? `Publish version ${(type.currentVersion ?? 1) + 1}`
                  : 'Create and publish'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
