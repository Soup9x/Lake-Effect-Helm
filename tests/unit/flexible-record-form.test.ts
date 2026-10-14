/**
 * Turning form controls back into a document the schema will accept.
 *
 * toDocument() is small and entirely about edge cases, which is exactly the
 * shape of thing worth testing away from a database. The reason it exists at
 * all is that Ajv runs with `coerceTypes: false` — deliberately, so a VLAN id
 * arriving as "5" is a bug rather than a silent 5 — and an HTML input produces
 * nothing but strings. Something has to convert, and the alternative to doing
 * it here is teaching the validator to guess.
 *
 * The three rules each have a failure mode behind them:
 *
 *   1. A blank optional field is OMITTED, never sent as "". `format: 'email'`
 *      and `format: 'date'` both reject the empty string, so sending it turns
 *      "I left this blank" into "this is not a valid address" — on a field the
 *      technician was never required to fill in.
 *   2. A blank SECRET is omitted because blank means UNCHANGED. Sending "" (or
 *      null) would be the one input that could destroy a stored credential,
 *      and nothing in the UI would have asked for that.
 *   3. A boolean is ALWAYS sent. Omitting `false` makes "no" and "unanswered"
 *      the same document, and a checkbox has no third state to distinguish
 *      them with.
 */
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { fieldsToSchema, type FieldDef } from '../../src/lib/flexible/fields';
import { toDocument } from '../../src/components/flexible-record-form';

const FIELDS: FieldDef[] = [
  { key: 'hostname', label: 'Hostname', kind: 'text', required: true },
  { key: 'notes', label: 'Notes', kind: 'textarea', required: false },
  { key: 'port', label: 'Port', kind: 'integer', required: false },
  { key: 'ratio', label: 'Ratio', kind: 'number', required: false },
  { key: 'enabled', label: 'Enabled', kind: 'boolean', required: false },
  { key: 'renews_on', label: 'Renews on', kind: 'date', required: false },
  { key: 'console', label: 'Console', kind: 'url', required: false },
  { key: 'owner', label: 'Owner', kind: 'email', required: false },
  { key: 'tier', label: 'Tier', kind: 'select', required: false, options: ['gold', 'silver'] },
  { key: 'api_token', label: 'API token', kind: 'secret', required: false },
];

/** Every control at its default, as the form's initial state produces them. */
const BLANK = {
  hostname: '', notes: '', port: '', ratio: '', enabled: false,
  renews_on: '', console: '', owner: '', tier: '', api_token: '',
};

describe('a blank form', () => {
  it('sends only the booleans', () => {
    // Not {} — see rule 3. `enabled: false` is an answer.
    expect(toDocument(FIELDS, BLANK)).toEqual({ enabled: false });
  });

  it('omits every textual field rather than sending an empty string', () => {
    const document = toDocument(FIELDS, BLANK);
    for (const key of ['hostname', 'notes', 'renews_on', 'console', 'owner', 'tier']) {
      expect(key in document, `${key} was sent as a blank`).toBe(false);
    }
  });

  it('omits a blank secret, because blank means unchanged', () => {
    expect('api_token' in toDocument(FIELDS, BLANK)).toBe(false);
  });

  it('omits a blank number rather than sending NaN or 0', () => {
    const document = toDocument(FIELDS, BLANK);
    expect('port' in document).toBe(false);
    expect('ratio' in document).toBe(false);
  });
});

describe('typed values', () => {
  it('converts numbers out of their text form', () => {
    const document = toDocument(FIELDS, { ...BLANK, port: '443', ratio: '1.5' });
    expect(document.port).toBe(443);
    expect(document.ratio).toBe(1.5);
  });

  it('passes an unparseable number through as text, so the server names the field', () => {
    // Dropping it would report "required" for a box the technician can see
    // they filled in — the single most confusing thing a form can say.
    expect(toDocument(FIELDS, { ...BLANK, port: 'four forty three' }).port)
      .toBe('four forty three');
  });

  it('trims a single-line field but not a long one', () => {
    const document = toDocument(FIELDS, {
      ...BLANK,
      hostname: '  fw-01  ',
      notes: '  line one\n    line two  ',
    });
    expect(document.hostname).toBe('fw-01');
    // Interior AND surrounding whitespace preserved: a pasted connection
    // string or a wrapped address is meant to look the way it was typed.
    expect(document.notes).toBe('  line one\n    line two  ');
  });

  it('drops a single-line field that was nothing but whitespace', () => {
    expect('hostname' in toDocument(FIELDS, { ...BLANK, hostname: '   ' })).toBe(false);
  });

  it('drops a long field that was nothing but whitespace', () => {
    // Otherwise "   " is a value, and a record reads as filled in when it is
    // not. The trimmed form decides presence; the untrimmed form is stored.
    expect('notes' in toDocument(FIELDS, { ...BLANK, notes: ' \n  ' })).toBe(false);
  });

  it('sends a true boolean as true', () => {
    expect(toDocument(FIELDS, { ...BLANK, enabled: true }).enabled).toBe(true);
  });

  it('sends a typed secret, which is what rotates it', () => {
    expect(toDocument(FIELDS, { ...BLANK, api_token: 'hunter2' }).api_token).toBe('hunter2');
  });

  it('ignores a draft key the field list does not declare', () => {
    // The form cannot produce one, but a stale draft after a template edit
    // could — and additionalProperties: false would reject the whole save for
    // a field no longer on screen.
    const document = toDocument(FIELDS, { ...BLANK, removed_field: 'x' } as never);
    expect('removed_field' in document).toBe(false);
  });
});

/**
 * The differential test, and the one that would actually catch a regression:
 * run the output through the real Ajv configuration, against the schema the
 * real builder produces. Any disagreement between what the form sends and what
 * the server accepts shows up here rather than as a 400 in somebody's browser.
 */
describe('against the schema the type editor publishes', () => {
  function validator(fields: FieldDef[]) {
    const ajv = new Ajv({
      strict: true, coerceTypes: false, useDefaults: false, allErrors: true,
      keywords: [{ keyword: 'x-helm-secret', schemaType: 'boolean', valid: true }],
    });
    addFormats(ajv);
    return ajv.compile(fieldsToSchema(fields).jsonSchema);
  }

  it('accepts a filled-in form', () => {
    const validate = validator(FIELDS);
    const document = toDocument(FIELDS, {
      hostname: 'fw-01', notes: 'two\nlines', port: '443', ratio: '0.5',
      enabled: true, renews_on: '2027-01-01', console: 'https://fw-01.test/',
      owner: 'ops@acme.test', tier: 'gold', api_token: 'hunter2',
    });
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts a form with every optional field blank', () => {
    const validate = validator(FIELDS);
    const document = toDocument(FIELDS, { ...BLANK, hostname: 'fw-01' });
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  });

  it('would NOT accept the same form if blanks were sent as empty strings', () => {
    // The assertion that gives rule 1 its teeth: this is what the obvious
    // implementation does, and it fails on three formats at once.
    const validate = validator(FIELDS);
    const naive = Object.fromEntries(
      FIELDS.map((f) => [f.key, f.kind === 'boolean' ? false : '']),
    );
    expect(validate({ ...naive, hostname: 'fw-01' })).toBe(false);
    const paths = (validate.errors ?? []).map((e) => e.instancePath);
    expect(paths).toContain('/renews_on');
    expect(paths).toContain('/owner');
    expect(paths).toContain('/console');
  });

  it('reports a missing required field, rather than the form inventing one', () => {
    const validate = validator(FIELDS);
    expect(validate(toDocument(FIELDS, BLANK))).toBe(false);
    expect((validate.errors ?? []).some((e) => e.keyword === 'required')).toBe(true);
  });
});
