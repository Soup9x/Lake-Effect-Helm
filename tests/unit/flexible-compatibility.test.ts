/**
 * Is publishing this schema capable of invalidating records already stored?
 *
 * THE CLAIM IS TESTED AGAINST AJV, NOT AGAINST MY REASONING. schemaCompatibility
 * answers "can the new schema reject a document the old one accepted", and that
 * is a statement about two compiled validators. So the central test compiles
 * both with the real Ajv — the same instance configuration the record path uses
 * — throws a corpus of documents at them, and asserts the implication directly:
 *
 *     compatible  =>  for every document d, valid(before, d) implies valid(after, d)
 *
 * A hand-written list of "this pair should be compatible" would only ever test
 * that I agree with myself. This way a rule I got backwards produces a
 * counterexample rather than a passing test.
 *
 * ONE-SIDED ON PURPOSE. The function is allowed to be pessimistic: saying
 * "incompatible" about a change that happens to break nothing costs a flag
 * somebody clears. So the implication above is asserted only for pairs it calls
 * compatible. What stops it being vacuously pessimistic is the second block,
 * which requires the everyday additive changes to come back compatible.
 */
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { schemaCompatibility } from '../../src/lib/flexible/compatibility';
import { fieldsToSchema, type FieldDef } from '../../src/lib/flexible/fields';

/** The record path's configuration, so this tests what actually validates. */
function ajv(): Ajv {
  const instance = new Ajv({
    strict: true, strictSchema: true, strictTypes: true, allowUnionTypes: false,
    coerceTypes: false, useDefaults: false, removeAdditional: false, allErrors: true,
    keywords: [{ keyword: 'x-helm-secret', schemaType: 'boolean', valid: true }],
  });
  addFormats(instance);
  return instance;
}

const base: FieldDef[] = [
  { key: 'hostname', label: 'Hostname', kind: 'text', required: true },
  { key: 'port', label: 'Port', kind: 'integer', required: false },
  { key: 'tier', label: 'Tier', kind: 'select', required: false, options: ['bronze', 'silver'] },
  { key: 'notes', label: 'Notes', kind: 'textarea', required: false },
];

const schemaOf = (fields: FieldDef[]) => fieldsToSchema(fields).jsonSchema;

/**
 * Documents to probe with. Deliberately includes shapes that are valid under
 * some of these schemas and not others — a corpus that only held valid
 * documents would make the implication trivially true.
 */
const CORPUS: unknown[] = [
  {},
  { hostname: 'fw-01' },
  { hostname: 'fw-01', port: 443 },
  { hostname: 'fw-01', port: 0 },
  { hostname: 'fw-01', port: 70000 },
  { hostname: 'fw-01', tier: 'bronze' },
  { hostname: 'fw-01', tier: 'silver' },
  { hostname: 'fw-01', tier: 'gold' },
  { hostname: '', notes: '' },
  // Mid-length, and the corpus needs it: with only 'fw-01' and 300 a's, nothing
  // distinguishes maxLength 253 from maxLength 10 — both accept the short one
  // and reject the long one. A sabotage run that deleted the bound-tightening
  // rule passed because of that gap, which is how this entry got here.
  { hostname: 'a'.repeat(50) },
  { hostname: 'a'.repeat(300) },
  { hostname: 'fw-01', notes: 'x'.repeat(500) },
  { hostname: 'fw-01', port: 443, tier: 'bronze', notes: 'all four' },
  { port: 443 },
  { hostname: 'fw-01', unexpected: true },
  { hostname: 42 },
  { hostname: 'fw-01', port: 1.5 },
];

/** Every document the first schema accepts must be accepted by the second. */
function findCounterexample(before: unknown, after: unknown): unknown | null {
  const instance = ajv();
  const validBefore = instance.compile(before as object);
  const validAfter = instance.compile(after as object);
  for (const document of CORPUS) {
    if (validBefore(document) && !validAfter(document)) return document;
  }
  return null;
}

/** Pairs to run the implication over, named for the failure message. */
const PAIRS: [string, FieldDef[], FieldDef[]][] = [
  ['no change', base, base],
  ['added an optional field', base, [...base, { key: 'extra', label: 'Extra', kind: 'text', required: false }]],
  ['added a required field', base, [...base, { key: 'extra', label: 'Extra', kind: 'text', required: true }]],
  ['made an optional field required', base, base.map((f) => f.key === 'port' ? { ...f, required: true } : f)],
  ['made a required field optional', base, base.map((f) => f.key === 'hostname' ? { ...f, required: false } : f)],
  ['removed a field', base, base.filter((f) => f.key !== 'notes')],
  ['added an enum option', base, base.map((f) => f.key === 'tier' ? { ...f, options: ['bronze', 'silver', 'gold'] } : f)],
  ['removed an enum option', base, base.map((f) => f.key === 'tier' ? { ...f, options: ['bronze'] } : f)],
  ['added a maxLength', base, base.map((f) => f.key === 'hostname' ? { ...f, maxLength: 253 } : f)],
  ['relaxed a maxLength',
    base.map((f) => f.key === 'hostname' ? { ...f, maxLength: 100 } : f),
    base.map((f) => f.key === 'hostname' ? { ...f, maxLength: 253 } : f)],
  ['tightened a maxLength',
    base.map((f) => f.key === 'hostname' ? { ...f, maxLength: 253 } : f),
    base.map((f) => f.key === 'hostname' ? { ...f, maxLength: 10 } : f)],
  ['added a numeric bound', base, base.map((f) => f.key === 'port' ? { ...f, min: 1, max: 65535 } : f)],
  ['widened a numeric bound',
    base.map((f) => f.key === 'port' ? { ...f, min: 10, max: 100 } : f),
    base.map((f) => f.key === 'port' ? { ...f, min: 1, max: 65535 } : f)],
  // The mirror of the above, so tightening a numeric bound is probed too and
  // not only tightening a length. port: 443 in the corpus is the witness.
  ['tightened a numeric bound',
    base.map((f) => f.key === 'port' ? { ...f, min: 1, max: 65535 } : f),
    base.map((f) => f.key === 'port' ? { ...f, min: 10, max: 100 } : f)],
  ['integer became number', base, base.map((f) => f.key === 'port' ? { ...f, kind: 'number' as const } : f)],
  ['number became integer',
    base.map((f) => f.key === 'port' ? { ...f, kind: 'number' as const } : f),
    base],
  ['text became a choice', base, base.map((f) => f.key === 'notes' ? { ...f, kind: 'select' as const, options: ['a', 'b'] } : f)],
  ['text gained a format', base, base.map((f) => f.key === 'notes' ? { ...f, kind: 'email' as const } : f)],
  ['format was dropped',
    base.map((f) => f.key === 'notes' ? { ...f, kind: 'email' as const } : f),
    base],
  ['became a secret', base, base.map((f) => f.key === 'notes' ? { ...f, kind: 'secret' as const } : f)],
  ['renamed a field', base, base.map((f) => f.key === 'notes' ? { ...f, key: 'remarks' } : f)],
];

describe('soundness, against Ajv', () => {
  for (const [name, beforeFields, afterFields] of PAIRS) {
    it(`is not wrong about: ${name}`, () => {
      const before = schemaOf(beforeFields);
      const after = schemaOf(afterFields);
      const verdict = schemaCompatibility(before, after);
      if (!verdict.compatible) {
        // Pessimism is allowed; it must still give a reason.
        expect(verdict.reasons.length).toBeGreaterThan(0);
        return;
      }
      const counterexample = findCounterexample(before, after);
      expect(
        counterexample,
        `called "${name}" compatible, but Ajv rejects ${JSON.stringify(counterexample)} under the new schema`,
      ).toBeNull();
    });
  }
});

describe('precision, so it is not merely pessimistic', () => {
  const compatible = (b: FieldDef[], a: FieldDef[]) => schemaCompatibility(schemaOf(b), schemaOf(a));

  it('accepts the everyday change: a new optional field', () => {
    // The single most common edit. Flagging every record for it would train
    // people to ignore the flag, which is worse than not having one.
    const result = compatible(base, [...base, { key: 'extra', label: 'Extra', kind: 'text', required: false }]);
    expect(result.reasons).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  it('accepts a relabelled field, which changes no validation', () => {
    expect(compatible(base, base.map((f) => ({ ...f, label: `${f.label} (edited)` }))).compatible).toBe(true);
  });

  it('accepts added help text', () => {
    expect(compatible(base, base.map((f) => ({ ...f, help: 'now explained' }))).compatible).toBe(true);
  });

  it('accepts dropping a requirement, widening a bound and growing an enum', () => {
    expect(compatible(base, base.map((f) => f.key === 'hostname' ? { ...f, required: false } : f)).compatible).toBe(true);
    expect(compatible(
      base.map((f) => f.key === 'port' ? { ...f, min: 10, max: 100 } : f),
      base.map((f) => f.key === 'port' ? { ...f, min: 1, max: 65535 } : f),
    ).compatible).toBe(true);
    expect(compatible(base, base.map((f) => f.key === 'tier' ? { ...f, options: ['bronze', 'silver', 'gold'] } : f)).compatible).toBe(true);
  });

  it('accepts reordering, which is ui_schema rather than schema', () => {
    expect(compatible(base, [...base].reverse()).compatible).toBe(true);
  });
});

describe('the reasons it gives', () => {
  const reasons = (b: FieldDef[], a: FieldDef[]) => schemaCompatibility(schemaOf(b), schemaOf(a)).reasons.join(' | ');

  it('names a newly required field', () => {
    expect(reasons(base, [...base, { key: 'extra', label: 'E', kind: 'text', required: true }]))
      .toContain('"extra" is now required');
  });

  it('names a removed field and says why it matters', () => {
    expect(reasons(base, base.filter((f) => f.key !== 'notes')))
      .toContain('records still carrying it would be rejected');
  });

  it('names the enum values that went away', () => {
    expect(reasons(base, base.map((f) => f.key === 'tier' ? { ...f, options: ['bronze'] } : f)))
      .toContain('"silver"');
  });

  it('calls out a field that became a secret', () => {
    // The value moves to flexible_asset_secret, so every stored record is wrong
    // in a way no bound describes.
    expect(reasons(base, base.map((f) => f.key === 'notes' ? { ...f, kind: 'secret' as const } : f)))
      .toContain('secret field');
  });
});

describe('what it refuses to reason about', () => {
  it('treats an unmodelled keyword as possibly narrowing', () => {
    // A schema posted through the API can carry anything the guard allows. A
    // pattern is the obvious case: assuming it harmless is how a narrowing
    // constraint slips past.
    const before = schemaOf(base);
    const after = schemaOf(base) as Record<string, Record<string, Record<string, unknown>>>;
    after.properties!.hostname!.pattern = '^[a-z]+$';
    const verdict = schemaCompatibility(before, after);
    expect(verdict.compatible).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('does not model');
  });

  it('refuses a schema that is not an object', () => {
    for (const junk of [null, 'object', 7, []]) {
      expect(schemaCompatibility(schemaOf(base), junk).compatible).toBe(false);
      expect(schemaCompatibility(junk, schemaOf(base)).compatible).toBe(false);
    }
  });

  it('refuses a new schema that allows additional properties', () => {
    // additionalProperties: true would let undescribed data accumulate, and the
    // guard refuses it anyway — but this analysis must not call it compatible.
    const after = { ...schemaOf(base), additionalProperties: true };
    expect(schemaCompatibility(schemaOf(base), after).compatible).toBe(false);
  });
});
