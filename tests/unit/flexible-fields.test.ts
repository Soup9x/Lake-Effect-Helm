/**
 * The field list, and the JSON Schema it compiles to.
 *
 * THE PROPERTY THAT MATTERS IS THE ROUND TRIP. A published schema version is
 * immutable, so editing a type means loading the stored schema back into a
 * field list and publishing a new version from it. If that load is lossy then
 * "change one field" silently rewrites the other eleven — and the technician
 * who does it has no way to see what moved. So schemaToFields(fieldsToSchema(x))
 * must equal x, for every kind, and that is asserted first.
 *
 * The second thing asserted here is that what the builder emits SURVIVES THE
 * REAL GUARD. schema-guard.ts is the authority on what may be published; this
 * module is a convenience that has to agree with it. Running the actual
 * inspection over generated schemas is the only way to know they agree, rather
 * than two files holding compatible opinions until one is edited.
 */
import { describe, expect, it } from 'vitest';
import {
  FIELD_KINDS, FIELD_KIND_INFO, fieldsToSchema, pointerFor, schemaToFields,
  searchableCandidates, searchablePointers, validateFields, type FieldDef,
} from '../../src/lib/flexible/fields';
import { inspectSchema, SCHEMA_LIMITS } from '../../src/lib/flexible/schema-guard';

/** One field of every kind, with each kind's extras populated. */
const EVERY_KIND: FieldDef[] = [
  { key: 'hostname',    label: 'Hostname',     kind: 'text',     required: true,  maxLength: 253 },
  { key: 'notes',       label: 'Notes',        kind: 'textarea', required: false, help: 'Free text.' },
  { key: 'throughput',  label: 'Throughput',   kind: 'number',   required: false, min: 0.5, max: 1000 },
  { key: 'port',        label: 'Port',         kind: 'integer',  required: true,  min: 1, max: 65535 },
  { key: 'monitored',   label: 'Monitored',    kind: 'boolean',  required: false },
  { key: 'renews_on',   label: 'Renews on',    kind: 'date',     required: false },
  { key: 'console_url', label: 'Console',      kind: 'url',      required: false },
  { key: 'owner_email', label: 'Owner',        kind: 'email',    required: false },
  { key: 'tier',        label: 'Support tier', kind: 'select',   required: true,  options: ['bronze', 'silver', 'gold'] },
  { key: 'api_token',   label: 'API token',    kind: 'secret',   required: false, help: 'Encrypted.' },
];

describe('the round trip', () => {
  it('survives every field kind without losing anything', () => {
    const { jsonSchema, uiSchema } = fieldsToSchema(EVERY_KIND);
    expect(schemaToFields(jsonSchema, uiSchema)).toEqual(EVERY_KIND);
  });

  it('covers every kind the catalogue declares', () => {
    // So a kind added to FIELD_KINDS without a mapping fails here rather than
    // round-tripping into 'text' and quietly changing somebody's form.
    expect([...FIELD_KINDS].sort()).toEqual([...new Set(EVERY_KIND.map((f) => f.kind))].sort());
  });

  it('keeps long text long', () => {
    // text and textarea are both type:'string'. Without the ui_schema widget
    // this is the field that silently becomes a one-line input on every edit.
    const { jsonSchema, uiSchema } = fieldsToSchema(EVERY_KIND);
    expect(uiSchema.widgets).toEqual({ notes: 'textarea' });
    expect(schemaToFields(jsonSchema, uiSchema).find((f) => f.key === 'notes')?.kind)
      .toBe('textarea');
    // ...and dropping the widget map is exactly what demotes it.
    expect(schemaToFields(jsonSchema, { order: uiSchema.order }).find((f) => f.key === 'notes')?.kind)
      .toBe('text');
  });

  it('preserves order, which is the form', () => {
    const { jsonSchema, uiSchema } = fieldsToSchema(EVERY_KIND);
    expect(uiSchema.order).toEqual(EVERY_KIND.map((f) => f.key));
    expect(schemaToFields(jsonSchema, uiSchema).map((f) => f.key))
      .toEqual(EVERY_KIND.map((f) => f.key));
  });

  it('appends fields an order list does not mention rather than dropping them', () => {
    // A schema posted through the API has no ui_schema at all. Losing its
    // fields in the editor would turn "edit this type" into "delete most of it".
    const { jsonSchema } = fieldsToSchema(EVERY_KIND);
    const recovered = schemaToFields(jsonSchema, {});
    expect(recovered.map((f) => f.key).sort()).toEqual(EVERY_KIND.map((f) => f.key).sort());
  });

  it('returns nothing for something that is not a schema', () => {
    for (const junk of [null, undefined, 42, 'object', [], {}, { properties: 7 }]) {
      expect(schemaToFields(junk, {})).toEqual([]);
    }
  });
});

describe('what the builder emits', () => {
  it('passes the real schema guard', () => {
    const { jsonSchema } = fieldsToSchema(EVERY_KIND);
    const inspection = inspectSchema(jsonSchema);
    expect(inspection.issues).toEqual([]);
    expect(inspection.ok).toBe(true);
  });

  it('marks exactly the secret fields, and the guard agrees', () => {
    // secretFields is derived from the schema by the API, never accepted from
    // the caller — so the builder's job is to emit the marker and nothing else.
    const { jsonSchema } = fieldsToSchema(EVERY_KIND);
    // JSON POINTERS, not bare names — '/api_token'. The guard's own field is
    // documented as 'JSON Pointers to fields marked x-helm-secret', and this
    // assertion was written expecting bare names until it failed. The
    // difference is load-bearing; see the searchable-overlap test below.
    expect(inspectSchema(jsonSchema).secretFields).toEqual(['/api_token']);
  });

  it('refuses additional properties, as the guard requires', () => {
    const { jsonSchema } = fieldsToSchema(EVERY_KIND);
    expect(jsonSchema.additionalProperties).toBe(false);
    expect(jsonSchema.type).toBe('object');
  });

  it('emits no pattern anywhere', () => {
    // The guard's own header: a hand-written pattern compiles to a RegExp with
    // no timeout, and a backtracking one hangs the event loop for every tenant.
    // Formats cover what a form needs and are implemented in Ajv instead.
    const { jsonSchema } = fieldsToSchema(EVERY_KIND);
    expect(JSON.stringify(jsonSchema)).not.toContain('pattern');
  });

  it('gives a secret field no default and no enum', () => {
    // Both are refused by the guard on a secret field, for good reasons: a
    // default would be a secret sitting in the schema in clear text.
    const { jsonSchema } = fieldsToSchema([
      { key: 'api_token', label: 'Token', kind: 'secret', required: false },
    ]);
    const property = (jsonSchema.properties as Record<string, Record<string, unknown>>).api_token!;
    expect(property['x-helm-secret']).toBe(true);
    expect(property.default).toBeUndefined();
    expect(property.enum).toBeUndefined();
    expect(property.type).toBe('string');
  });

  it('omits required entirely when nothing is required', () => {
    const { jsonSchema } = fieldsToSchema([
      { key: 'notes', label: 'Notes', kind: 'text', required: false },
    ]);
    expect('required' in jsonSchema).toBe(false);
    expect(inspectSchema(jsonSchema).ok).toBe(true);
  });

  it('lists required fields, and only those', () => {
    const { jsonSchema } = fieldsToSchema(EVERY_KIND);
    expect(jsonSchema.required).toEqual(['hostname', 'port', 'tier']);
  });
});

describe('author-facing validation', () => {
  const one: FieldDef = { key: 'ok_field', label: 'Fine', kind: 'text', required: false };

  it('accepts a sound list', () => {
    expect(validateFields(EVERY_KIND)).toEqual([]);
  });

  it('wants at least one field', () => {
    expect(validateFields([]).map((i) => i.message)).toContain('A type needs at least one field.');
  });

  it('names both fields when two share a key', () => {
    const issues = validateFields([one, { ...one, label: 'Also fine' }]);
    expect(issues.some((i) => i.key === 'ok_field' && i.message.includes('both called'))).toBe(true);
  });

  it('rejects a key the database would reject', () => {
    // flexible_type_key_shape and the property name both want this shape; a
    // CHECK violation arriving from Postgres names no row.
    for (const key of ['Capital', '1leading', 'has-dash', 'has space', '']) {
      const issues = validateFields([{ ...one, key }]);
      expect(issues.some((i) => i.message.includes('lowercase')), `accepted ${JSON.stringify(key)}`)
        .toBe(true);
    }
  });

  it('wants two options on a choice field', () => {
    const issues = validateFields([{ ...one, kind: 'select', options: ['only'] }]);
    expect(issues.some((i) => i.message.includes('at least two options'))).toBe(true);
  });

  it('refuses options on a kind that has none, rather than dropping them', () => {
    // Silently discarding them would lose work the author can see on screen.
    const issues = validateFields([{ ...one, kind: 'secret', options: ['a', 'b'] }]);
    expect(issues.some((i) => i.message.includes('Options only apply'))).toBe(true);
  });

  it('catches an inverted range and a fractional integer bound', () => {
    expect(validateFields([{ ...one, kind: 'integer', min: 10, max: 1 }])
      .some((i) => i.message.includes('minimum is above the maximum'))).toBe(true);
    expect(validateFields([{ ...one, kind: 'integer', min: 1.5 }])
      .some((i) => i.message.includes('whole minimum'))).toBe(true);
  });

  it('enforces the guard"s own limits rather than inventing its own', () => {
    const many = Array.from({ length: SCHEMA_LIMITS.maxProperties + 1 }, (_, i) => ({
      ...one, key: `f_${i}`,
    }));
    expect(validateFields(many).some((i) => i.message.includes(String(SCHEMA_LIMITS.maxProperties))))
      .toBe(true);

    const tooManyOptions = {
      ...one,
      kind: 'select' as const,
      options: Array.from({ length: SCHEMA_LIMITS.maxEnumValues + 1 }, (_, i) => `o${i}`),
    };
    expect(validateFields([tooManyOptions])
      .some((i) => i.message.includes(String(SCHEMA_LIMITS.maxEnumValues)))).toBe(true);
  });
});

describe('searchable fields', () => {
  it('never offers a secret field', () => {
    // flexible_version_secrets_not_searchable is a CHECK, and the API refuses
    // the overlap too; this is so the checkbox is simply absent.
    const offered = searchableCandidates(EVERY_KIND).map((f) => f.key);
    expect(offered).not.toContain('api_token');
    expect(offered).toHaveLength(EVERY_KIND.length - 1);
  });

  it('emits JSON POINTERS, because the indexing trigger strips a leading slash', () => {
    /*
     * 0240's trigger does `v_key := substring(v_path from 2)` and then
     * `NEW.data ->> v_key`. So '/hostname' reads data->>'hostname' and a bare
     * 'hostname' reads data->>'ostname', which is NULL — the field is stored as
     * searchable and indexes nothing, with no error anywhere. Confirmed against
     * the running database, not inferred.
     */
    expect(pointerFor('hostname')).toBe('/hostname');
    expect(searchablePointers(EVERY_KIND, ['hostname', 'tier']))
      .toEqual(['/hostname', '/tier']);
  });

  it('drops a secret even when a caller names one', () => {
    // The UI does not offer the checkbox, so this is the belt to the CHECK's
    // braces rather than the only guard.
    expect(searchablePointers(EVERY_KIND, ['hostname', 'api_token']))
      .toEqual(['/hostname']);
  });

  it('agrees with what the guard reports as secret', () => {
    // The two lists are compared by the route and by a CHECK constraint, so
    // they have to be in the same namespace. This is the assertion that would
    // have caught the bare-name form before it was stored.
    const { jsonSchema } = fieldsToSchema(EVERY_KIND);
    const secret = inspectSchema(jsonSchema).secretFields;
    expect(secret).toEqual([pointerFor('api_token')]);
    const searchable = searchablePointers(EVERY_KIND, EVERY_KIND.map((f) => f.key));
    expect(searchable.filter((p) => secret.includes(p))).toEqual([]);
    // ...and every pointer resolves to a property that exists.
    const properties = jsonSchema.properties as Record<string, unknown>;
    for (const pointer of [...secret, ...searchable]) {
      expect(pointer.startsWith('/'), `${pointer} is not a pointer`).toBe(true);
      expect(pointer.slice(1) in properties, `${pointer} names no property`).toBe(true);
    }
  });
});

describe('the kind catalogue', () => {
  it('describes every kind', () => {
    for (const kind of FIELD_KINDS) {
      const info = FIELD_KIND_INFO[kind];
      expect(info, `no info for ${kind}`).toBeTruthy();
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.hint.length).toBeGreaterThan(0);
    }
  });
});
