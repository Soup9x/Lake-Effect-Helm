/**
 * The field list a technician edits, and the JSON Schema it compiles to.
 *
 * WHY THIS LAYER EXISTS. `flexible_asset_type_version.json_schema` is JSON
 * Schema 2020-12, and an authoring screen that asked somebody to type JSON
 * Schema would not be an authoring screen. So the UI edits a flat list of
 * fields — name, kind, required, help — and this module is the only place that
 * knows how such a list becomes a schema, and how a stored schema becomes the
 * list again.
 *
 * ONE DIRECTION IS NOT ENOUGH. Published versions are immutable (trigger, in
 * 0080), so editing a type means publishing a NEW version — which means the
 * editor has to load the current schema back into a field list first. A
 * conversion that only went forwards would leave "edit" meaning "start again",
 * and a technician who re-typed twelve fields to change one would get a
 * different schema. `schemaToFields(fieldsToSchema(x))` is therefore required
 * to equal `x`, and a test asserts it over every kind.
 *
 * WHAT THIS DELIBERATELY DOES NOT EMIT: `pattern`. src/lib/flexible/
 * schema-guard.ts exists largely because a hand-written regular expression
 * compiles to a RegExp with no timeout and a backtracking one hangs the event
 * loop for every tenant. Formats cover what a form actually needs — a date, a
 * URL, an address — and they are implemented in Ajv rather than in a string
 * somebody typed at 4pm on a Friday. The guard is still the backstop (an API
 * client can post whatever it likes); this is about not aiming a loaded foot-gun
 * at the people the UI is for.
 *
 * THE GUARD IS THE AUTHORITY, NOT THIS FILE. validateFields() below checks what
 * it can in order to give a useful message next to the offending row, and the
 * API still runs the full inspection. Anything this file believes about limits
 * is a courtesy; the limits themselves live in SCHEMA_LIMITS.
 */
import { SCHEMA_LIMITS } from './schema-guard';

export const FIELD_KINDS = [
  'text', 'textarea', 'number', 'integer', 'boolean',
  'date', 'url', 'email', 'select', 'secret',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface FieldKindInfo {
  label: string;
  hint: string;
  /** Whether `options` is required and offered. */
  takesOptions?: boolean;
  /** Whether min/max apply. */
  numeric?: boolean;
  /** Whether maxLength applies. */
  textual?: boolean;
}

export const FIELD_KIND_INFO: Record<FieldKind, FieldKindInfo> = {
  text:     { label: 'Text',           hint: 'A single line.', textual: true },
  textarea: { label: 'Long text',      hint: 'Several lines. Stored the same way as Text.', textual: true },
  number:   { label: 'Number',         hint: 'Decimals allowed.', numeric: true },
  integer:  { label: 'Whole number',   hint: 'No decimals.', numeric: true },
  boolean:  { label: 'Yes / no',       hint: 'A checkbox.' },
  date:     { label: 'Date',           hint: 'Stored as YYYY-MM-DD.' },
  url:      { label: 'Link',           hint: 'Validated as a URI.' },
  email:    { label: 'Email address',  hint: 'Validated as an address.' },
  select:   { label: 'Choice',         hint: 'One of a fixed list.', takesOptions: true },
  secret:   {
    label: 'Secret',
    hint: 'Encrypted per tenant and revealed through the audited path, like a credential. '
        + 'Never stored in the record itself.',
  },
};

export interface FieldDef {
  /** The JSON property name. Lowercase, because it ends up in queries. */
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  help?: string;
  /** `select` only. */
  options?: string[];
  /** Text kinds only. */
  maxLength?: number;
  /** Numeric kinds only. */
  min?: number;
  max?: number;
}

/**
 * `searchable_fields` AND `secret_fields` HOLD JSON POINTERS, not bare names.
 *
 * This is not cosmetic and it is not documented anywhere a caller would look,
 * so it is written down here. The indexing trigger (0240) does:
 *
 *     FOREACH v_path IN ARRAY coalesce(v_searchable, '{}') LOOP
 *       CONTINUE WHEN v_path = ANY (coalesce(v_secret, '{}'));
 *       v_key := substring(v_path from 2);
 *       v_val := NEW.data ->> v_key;
 *
 * `substring(v_path from 2)` strips a leading '/'. So '/hostname' indexes
 * `data->>'hostname'`, and a bare 'hostname' indexes `data->>'ostname'`, which
 * is NULL, which indexes nothing — silently. A technician who ticks "searchable"
 * on a field and finds search never returns it has hit exactly that.
 *
 * It is a usability trap rather than a leak, and the difference is worth being
 * precise about. With bare names the overlap guards also miss each other —
 * the route's `secretFields.includes(f)` compares '/api_token' to 'api_token',
 * and the `flexible_version_secrets_not_searchable` CHECK compares the same two
 * arrays — so a secret field CAN be marked searchable. Nothing leaks, because
 * the same off-by-one mangles the key and the lookup returns NULL, and because a
 * secret's value never reaches `data` in the first place: it is split out and
 * encrypted. Verified against the running database rather than reasoned about.
 *
 * So: this module always emits pointers, and the API refuses anything that is
 * not one rather than storing it to do nothing.
 */
export function pointerFor(key: string): string {
  return `/${key}`;
}

/** What `searchable_fields` may contain: a secret can never be indexed. */
export function searchableCandidates(fields: readonly FieldDef[]): FieldDef[] {
  return fields.filter((f) => f.kind !== 'secret');
}

/**
 * The stored `searchable_fields` value for a chosen set of field keys.
 *
 * Secrets are dropped rather than rejected: the checkbox is not offered for
 * one, so a secret arriving here means a caller built the list another way, and
 * the CHECK constraint would refuse the row anyway.
 */
export function searchablePointers(
  fields: readonly FieldDef[],
  chosenKeys: readonly string[],
): string[] {
  const chosen = new Set(chosenKeys);
  return searchableCandidates(fields)
    .filter((f) => chosen.has(f.key))
    .map((f) => pointerFor(f.key));
}

export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export interface FieldIssue {
  /** The field's key, or '' for an issue about the list as a whole. */
  key: string;
  message: string;
}

/**
 * Author-facing checks, run as the form is edited.
 *
 * Deliberately NOT a reimplementation of the schema guard — it cannot be, since
 * the guard probes patterns empirically and this runs on every keystroke. What
 * it catches is the handful of mistakes whose error would otherwise arrive from
 * Postgres or Ajv with no idea which row caused it.
 */
export function validateFields(fields: readonly FieldDef[]): FieldIssue[] {
  const issues: FieldIssue[] = [];

  if (fields.length === 0) {
    issues.push({ key: '', message: 'A type needs at least one field.' });
  }
  if (fields.length > SCHEMA_LIMITS.maxProperties) {
    issues.push({
      key: '',
      message: `A type may have at most ${SCHEMA_LIMITS.maxProperties} fields; this has ${fields.length}.`,
    });
  }

  const seen = new Map<string, number>();
  for (const field of fields) {
    if (!KEY_PATTERN.test(field.key)) {
      issues.push({
        key: field.key,
        message: 'Field names start with a lowercase letter and use only lowercase letters, digits and underscores.',
      });
    }
    seen.set(field.key, (seen.get(field.key) ?? 0) + 1);

    if (field.label.trim() === '') {
      issues.push({ key: field.key, message: 'Every field needs a label.' });
    }

    const info = FIELD_KIND_INFO[field.kind];
    if (info.takesOptions) {
      const options = field.options ?? [];
      if (options.length < 2) {
        issues.push({ key: field.key, message: 'A choice field needs at least two options.' });
      }
      if (options.length > SCHEMA_LIMITS.maxEnumValues) {
        issues.push({
          key: field.key,
          message: `A choice field may have at most ${SCHEMA_LIMITS.maxEnumValues} options.`,
        });
      }
      if (new Set(options).size !== options.length) {
        issues.push({ key: field.key, message: 'Options must be distinct.' });
      }
      if (options.some((o) => o.trim() === '')) {
        issues.push({ key: field.key, message: 'An option cannot be blank.' });
      }
    } else if ((field.options ?? []).length > 0) {
      // The guard refuses `x-helm-secret` with an enum outright; for the rest
      // it is simply meaningless, and silently dropping it would lose work.
      issues.push({
        key: field.key,
        message: `Options only apply to a choice field, not to ${FIELD_KIND_INFO[field.kind].label}.`,
      });
    }

    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      issues.push({ key: field.key, message: 'The minimum is above the maximum.' });
    }
    if (field.kind === 'integer') {
      for (const [name, value] of [['minimum', field.min], ['maximum', field.max]] as const) {
        if (value !== undefined && !Number.isInteger(value)) {
          issues.push({ key: field.key, message: `A whole-number field needs a whole ${name}.` });
        }
      }
    }
  }

  for (const [key, count] of seen) {
    if (count > 1) issues.push({ key, message: `Two fields are both called "${key}".` });
  }

  return issues;
}

/** The subset of ui_schema this module owns. */
export interface UiSchema {
  /**
   * Field order. Kept explicitly because JSON object key order is not something
   * to rely on across a jsonb round trip, and because the order IS the form.
   */
  order: string[];
  /**
   * Only what the JSON Schema cannot express. Today that is one thing: `text`
   * and `textarea` are both `type: 'string'` and differ only in how they are
   * drawn, so without this an edit would silently turn every long text field
   * into a single line.
   */
  widgets?: Record<string, 'textarea'>;
}

type JsonObject = Record<string, unknown>;

/** A field list as a published schema. */
export function fieldsToSchema(fields: readonly FieldDef[]): {
  jsonSchema: JsonObject;
  uiSchema: UiSchema;
} {
  const properties: JsonObject = {};
  const required: string[] = [];
  const widgets: Record<string, 'textarea'> = {};

  for (const field of fields) {
    const property: JsonObject = { title: field.label };
    if (field.help !== undefined && field.help !== '') property.description = field.help;

    switch (field.kind) {
      case 'text':
      case 'textarea':
        property.type = 'string';
        if (field.maxLength !== undefined) property.maxLength = field.maxLength;
        if (field.kind === 'textarea') widgets[field.key] = 'textarea';
        break;
      case 'secret':
        // No default and no enum, both of which the guard refuses on a secret
        // field — a default would be a secret sitting in the schema, and an
        // enum would be the permitted values of one.
        property.type = 'string';
        property['x-helm-secret'] = true;
        break;
      case 'select':
        property.type = 'string';
        property.enum = [...(field.options ?? [])];
        break;
      case 'number':
      case 'integer':
        property.type = field.kind;
        if (field.min !== undefined) property.minimum = field.min;
        if (field.max !== undefined) property.maximum = field.max;
        break;
      case 'boolean':
        property.type = 'boolean';
        break;
      case 'date':
        property.type = 'string';
        property.format = 'date';
        break;
      case 'url':
        property.type = 'string';
        property.format = 'uri';
        break;
      case 'email':
        property.type = 'string';
        property.format = 'email';
        break;
    }

    properties[field.key] = property;
    if (field.required) required.push(field.key);
  }

  const jsonSchema: JsonObject = {
    type: 'object',
    // The guard requires this, and the reason is in its header: a schema that
    // accepts undescribed fields collects data nothing validates or searches.
    additionalProperties: false,
    properties,
  };
  // Omitted rather than empty: Ajv runs in strict mode and an empty `required`
  // is noise in a stored artefact that is read by people.
  if (required.length > 0) jsonSchema.required = required;

  const uiSchema: UiSchema = { order: fields.map((f) => f.key) };
  if (Object.keys(widgets).length > 0) uiSchema.widgets = widgets;

  return { jsonSchema, uiSchema };
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function kindOf(property: JsonObject, widget: string | undefined): FieldKind {
  if (property['x-helm-secret'] === true) return 'secret';
  if (Array.isArray(property.enum)) return 'select';
  if (property.type === 'boolean') return 'boolean';
  if (property.type === 'integer') return 'integer';
  if (property.type === 'number') return 'number';
  if (property.format === 'date') return 'date';
  if (property.format === 'uri') return 'url';
  if (property.format === 'email') return 'email';
  return widget === 'textarea' ? 'textarea' : 'text';
}

/**
 * A published schema back into the field list that produced it.
 *
 * Tolerant on purpose. A schema may have arrived through the API rather than
 * this builder, so it can carry keywords the field model has no slot for. Those
 * are dropped from the EDITOR's view, which is why the caller must treat the
 * result as a new draft rather than as a faithful copy — and why the UI says so
 * before publishing a version derived from one.
 */
export function schemaToFields(jsonSchema: unknown, uiSchema: unknown): FieldDef[] {
  const schema = asObject(jsonSchema);
  const properties = schema ? asObject(schema.properties) : null;
  if (!properties) return [];

  const ui = asObject(uiSchema) ?? {};
  const order = Array.isArray(ui.order) ? ui.order.filter((k): k is string => typeof k === 'string') : [];
  const widgets = asObject(ui.widgets) ?? {};
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((k): k is string => typeof k === 'string')
      : [],
  );

  // Ordered fields first in their stated order, then anything the order list
  // does not mention — a schema written by hand has no order at all, and
  // dropping its fields would be worse than appending them.
  const keys = [
    ...order.filter((k) => k in properties),
    ...Object.keys(properties).filter((k) => !order.includes(k)),
  ];

  return keys.flatMap((key) => {
    const property = asObject(properties[key]);
    if (!property) return [];

    const widget = widgets[key];
    const kind = kindOf(property, typeof widget === 'string' ? widget : undefined);
    const field: FieldDef = {
      key,
      label: typeof property.title === 'string' ? property.title : key,
      kind,
      required: required.has(key),
    };
    if (typeof property.description === 'string') field.help = property.description;
    if (kind === 'select' && Array.isArray(property.enum)) {
      field.options = property.enum.map((v) => String(v));
    }
    if (typeof property.maxLength === 'number') field.maxLength = property.maxLength;
    if (typeof property.minimum === 'number') field.min = property.minimum;
    if (typeof property.maximum === 'number') field.max = property.maximum;
    return [field];
  });
}
