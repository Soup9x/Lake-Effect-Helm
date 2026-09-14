import { describe, expect, it } from 'vitest';
import {
  detectCatastrophicBacktracking,
  escapePointer,
  inspectSchema,
  measurePatternCost,
  SCHEMA_LIMITS,
  unescapePointer,
} from '../../src/lib/flexible/schema-guard';
import { FlexibleAssetValidator, splitSecrets } from '../../src/lib/flexible/validator';

/** A well-formed template, used as the baseline for "this should be accepted". */
const backupJobSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'schedule'],
  properties: {
    target: { type: 'string', maxLength: 200 },
    schedule: { type: 'string', enum: ['hourly', 'nightly', 'weekly'] },
    retention_days: { type: 'integer', minimum: 1, maximum: 3650 },
    repository_password: { type: 'string', 'x-helm-secret': true },
    notify: { type: 'string', format: 'email', maxLength: 320 },
  },
};

describe('schema guard: structural requirements', () => {
  it('accepts a well-formed template', () => {
    const result = inspectSchema(backupJobSchema);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.secretFields).toEqual(['/repository_password']);
    expect(result.propertyNames).toContain('target');
  });

  it('requires the root to be an object schema', () => {
    expect(inspectSchema({ type: 'array' }).ok).toBe(false);
    expect(inspectSchema('not a schema').ok).toBe(false);
    expect(inspectSchema(null).ok).toBe(false);
  });

  it('requires additionalProperties: false', () => {
    // Otherwise undeclared fields land in jsonb unvalidated and unsearchable.
    const { issues } = inspectSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
    expect(issues.some((i) => /additionalProperties/.test(i.message))).toBe(true);
  });

  it('rejects a schema with no properties', () => {
    const { ok } = inspectSchema({ type: 'object', additionalProperties: false, properties: {} });
    expect(ok).toBe(false);
  });

  it('reports every problem at once rather than the first', () => {
    const { issues } = inspectSchema({ type: 'array', properties: {} });
    expect(issues.length).toBeGreaterThan(1);
  });
});

describe('schema guard: reference resolution', () => {
  it('rejects $ref anywhere', () => {
    // Compiling a schema must never become an outbound HTTP request.
    for (const schema of [
      { type: 'object', additionalProperties: false, properties: { a: { $ref: 'https://evil.test/s.json' } } },
      { type: 'object', additionalProperties: false, properties: { a: { $ref: '#/$defs/x' } } },
    ]) {
      const { issues } = inspectSchema(schema);
      expect(issues.some((i) => /\$ref is not permitted/.test(i.message))).toBe(true);
    }
  });

  it('rejects dynamic and recursive references', () => {
    const { issues } = inspectSchema({
      type: 'object',
      additionalProperties: false,
      properties: { a: { $dynamicRef: '#node' } },
    });
    expect(issues.some((i) => /\$dynamicRef/.test(i.message))).toBe(true);
  });

  it('rejects patternProperties', () => {
    const { issues } = inspectSchema({
      type: 'object',
      additionalProperties: false,
      patternProperties: { '^x-': { type: 'string' } },
      properties: { a: { type: 'string' } },
    });
    expect(issues.some((i) => /patternProperties/.test(i.message))).toBe(true);
  });
});

describe('schema guard: regular expression denial of service', () => {
  it('detects nested unbounded quantifiers', () => {
    // The classic: (a+)+ against a long non-matching subject.
    expect(detectCatastrophicBacktracking('^(a+)+$')).toMatch(/quantified group/);
    expect(detectCatastrophicBacktracking('^(\\w+\\s?)*$')).toBeTruthy();
    expect(detectCatastrophicBacktracking('(x*)*')).toMatch(/quantified group/);
  });

  it('detects quantified alternation with overlapping branches', () => {
    expect(detectCatastrophicBacktracking('^(a|a)*$')).toMatch(/alternation/);
    expect(detectCatastrophicBacktracking('^(a|ab)*$')).toMatch(/alternation/);
  });

  it('detects adjacent unbounded quantifiers over the same class', () => {
    expect(detectCatastrophicBacktracking('\\s*\\s*')).toMatch(/adjacent/);
    expect(detectCatastrophicBacktracking('[a-z]+[a-z]+')).toMatch(/adjacent/);
  });

  it('detects quantified backreferences', () => {
    expect(detectCatastrophicBacktracking('(a)\\1+')).toMatch(/backreference/);
  });

  it('passes ordinary patterns', () => {
    for (const safe of [
      '^[a-z0-9-]+$',
      '^\\d{1,5}$',
      '^[A-F0-9]{2}(:[A-F0-9]{2}){5}$',
      '^https://',
    ]) {
      expect(detectCatastrophicBacktracking(safe)).toBeNull();
    }
  });

  it('rejects a schema carrying a risky pattern', () => {
    const { issues } = inspectSchema({
      type: 'object',
      additionalProperties: false,
      properties: { code: { type: 'string', pattern: '^(a+)+$', maxLength: 50 } },
    });
    expect(issues.some((i) => /backtrack catastrophically/.test(i.message))).toBe(true);
  });

  it('requires maxLength on any patterned field', () => {
    // The defence that holds even for a shape the detector misses: bounding the
    // subject bounds the worst case regardless of the expression.
    const { issues } = inspectSchema({
      type: 'object',
      additionalProperties: false,
      properties: { code: { type: 'string', pattern: '^[a-z]+$' } },
    });
    expect(issues.some((i) => /must also declare maxLength/.test(i.message))).toBe(true);
  });

  it('caps maxLength on a patterned field', () => {
    const { issues } = inspectSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', pattern: '^[a-z]+$', maxLength: SCHEMA_LIMITS.maxPatternedStringLength + 1 },
      },
    });
    expect(issues.some((i) => /limit for a patterned field/.test(i.message))).toBe(true);
  });

  it('rejects an invalid regular expression', () => {
    const { issues } = inspectSchema({
      type: 'object',
      additionalProperties: false,
      properties: { code: { type: 'string', pattern: '([', maxLength: 10 } },
    });
    expect(issues.some((i) => /not a valid regular expression/.test(i.message))).toBe(true);
  });
});

describe('schema guard: cost bounds', () => {
  it('rejects excessive nesting', () => {
    let node: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < SCHEMA_LIMITS.maxDepth + 3; i += 1) {
      node = { type: 'object', additionalProperties: false, properties: { child: node } };
    }
    expect(inspectSchema(node).ok).toBe(false);
  });

  it('rejects too many properties', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < SCHEMA_LIMITS.maxProperties + 5; i += 1) {
      properties[`field_${i}`] = { type: 'string' };
    }
    const { issues } = inspectSchema({ type: 'object', additionalProperties: false, properties });
    expect(issues.some((i) => /properties; the limit is/.test(i.message))).toBe(true);
  });

  it('rejects an oversized schema', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 60; i += 1) {
      properties[`f${i}`] = { type: 'string', description: 'x'.repeat(2000) };
    }
    const { issues } = inspectSchema({ type: 'object', additionalProperties: false, properties });
    expect(issues.some((i) => /bytes; the limit is/.test(i.message))).toBe(true);
  });

  it('rejects an oversized enum', () => {
    const { issues } = inspectSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        choice: { type: 'string', enum: Array.from({ length: 500 }, (_, i) => `v${i}`) },
      },
    });
    expect(issues.some((i) => /enum has 500 values/.test(i.message))).toBe(true);
  });
});

describe('schema guard: secret field markers', () => {
  it('refuses x-helm-secret on a nested field', () => {
    // The database trigger only inspects top-level keys, so a nested marker
    // would be honoured by the UI and silently ignored by the enforcement.
    const { issues } = inspectSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        nested: {
          type: 'object',
          additionalProperties: false,
          properties: { password: { type: 'string', 'x-helm-secret': true } },
        },
      },
    });
    expect(issues.some((i) => /only supported on top-level fields/.test(i.message))).toBe(true);
  });

  it('requires a secret field to be a string', () => {
    const { issues } = inspectSchema({
      type: 'object',
      additionalProperties: false,
      properties: { key: { type: 'integer', 'x-helm-secret': true } },
    });
    expect(issues.some((i) => /must be type: 'string'/.test(i.message))).toBe(true);
  });

  it('refuses a default on a secret field', () => {
    // A default secret is a shared secret, stored in the schema in the clear.
    const { issues } = inspectSchema({
      type: 'object',
      additionalProperties: false,
      properties: { key: { type: 'string', 'x-helm-secret': true, default: 'changeme' } },
    });
    expect(issues.some((i) => /must not declare a default/.test(i.message))).toBe(true);
  });

  it('refuses an enum on a secret field', () => {
    const { issues } = inspectSchema({
      type: 'object',
      additionalProperties: false,
      properties: { key: { type: 'string', 'x-helm-secret': true, enum: ['a', 'b'] } },
    });
    expect(issues.some((i) => /must not declare an enum/.test(i.message))).toBe(true);
  });
});

describe('JSON Pointer escaping', () => {
  it('round-trips awkward field names', () => {
    for (const name of ['plain', 'with/slash', 'with~tilde', 'a/b~c']) {
      expect(unescapePointer(escapePointer(name))).toBe(name);
    }
  });
});

describe('record validation', () => {
  const validator = new FlexibleAssetValidator();
  const versionId = '1f000000-0000-0000-0000-000000000002';
  const secretFields = ['/repository_password'];

  const validate = (input: unknown) =>
    validator.validateRecord(versionId, backupJobSchema, secretFields, input);

  it('accepts a conforming record', () => {
    const result = validate({ target: 'nas01', schedule: 'nightly', retention_days: 30 });
    expect(result.ok).toBe(true);
  });

  it('rejects a missing required field with a usable path', () => {
    const result = validate({ target: 'nas01' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({ path: '/schedule', message: 'this field is required' });
  });

  it('rejects an undeclared field by name', () => {
    const result = validate({ target: 'nas01', schedule: 'nightly', sneaky: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: '/sneaky',
      message: 'this field is not declared by the template',
    });
  });

  it('does not coerce types', () => {
    // "30" silently becoming 30 hides a real bug in whatever produced it.
    const result = validate({ target: 'nas01', schedule: 'nightly', retention_days: '30' });
    expect(result.ok).toBe(false);
  });

  it('enforces enum, format and numeric bounds', () => {
    expect(validate({ target: 'n', schedule: 'fortnightly' }).ok).toBe(false);
    expect(validate({ target: 'n', schedule: 'nightly', notify: 'not-an-email' }).ok).toBe(false);
    expect(validate({ target: 'n', schedule: 'nightly', retention_days: 0 }).ok).toBe(false);
  });

  it('reports every error in one pass', () => {
    const result = validate({ schedule: 'fortnightly', retention_days: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a non-object record', () => {
    expect(validate([]).ok).toBe(false);
    expect(validate('nope').ok).toBe(false);
    expect(validate(null).ok).toBe(false);
  });
});

describe('secret splitting', () => {
  const validator = new FlexibleAssetValidator();
  const versionId = '1f000000-0000-0000-0000-000000000002';
  const secretFields = ['/repository_password'];

  it('removes the secret from the stored document and returns it separately', () => {
    const result = validator.validateRecord(versionId, backupJobSchema, secretFields, {
      target: 'nas01',
      schedule: 'nightly',
      repository_password: 'restic-repo-passphrase',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The value must not survive anywhere in the document that gets stored.
    expect(result.data).not.toHaveProperty('repository_password');
    expect(JSON.stringify(result.data)).not.toContain('restic-repo-passphrase');
    expect(result.secrets.get('/repository_password')).toBe('restic-repo-passphrase');
  });

  it('still enforces required on a secret field', () => {
    // The document handed to Ajv has a placeholder in the secret's place, so a
    // schema that requires the field is not quietly satisfied by the split.
    const requiring = { ...backupJobSchema, required: ['target', 'schedule', 'repository_password'] };
    const result = validator.validateRecord(
      'requiring-version',
      requiring,
      secretFields,
      { target: 'nas01', schedule: 'nightly' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: '/repository_password',
      message: 'this field is required',
    });
  });

  it('treats null as "leave the existing secret alone"', () => {
    // Editing a record's other fields must not require re-entering every
    // credential attached to it.
    const result = validator.validateRecord(versionId, backupJobSchema, secretFields, {
      target: 'nas02',
      schedule: 'weekly',
      repository_password: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secrets.size).toBe(0);
    expect(result.data).not.toHaveProperty('repository_password');
  });

  it('rejects a non-string or empty secret', () => {
    const numeric = splitSecrets({ repository_password: 12345 }, secretFields);
    expect(numeric.errors[0]?.message).toMatch(/must be a string/);

    const empty = splitSecrets({ repository_password: '' }, secretFields);
    expect(empty.errors[0]?.message).toMatch(/must not be empty/);
  });

  it('keeps a secret value out of validation error messages', () => {
    // Ajv echoes offending data in some error shapes, and error objects get
    // logged wholesale.
    const constrained = {
      ...backupJobSchema,
      properties: {
        ...backupJobSchema.properties,
        repository_password: { type: 'string', 'x-helm-secret': true, minLength: 500 },
      },
    };
    const result = validator.validateRecord('constrained-version', constrained, secretFields, {
      target: 'nas01',
      schedule: 'nightly',
      repository_password: 'too-short-but-secret',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.errors)).not.toContain('too-short-but-secret');
    expect(result.errors).toContainEqual({
      path: '/repository_password',
      message: 'this secret field is not valid',
    });
  });

  it('handles a field name needing pointer escaping', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { 'api/key': { type: 'string', 'x-helm-secret': true } },
    };
    const result = validator.validateRecord('escaped-version', schema, ['/api~1key'], {
      'api/key': 'sk-live-abc123',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).not.toHaveProperty('api/key');
    expect(result.secrets.get('/api~1key')).toBe('sk-live-abc123');
  });
});

describe('schema inspection through the validator', () => {
  const validator = new FlexibleAssetValidator();

  it('accepts and reports the secret fields of a good schema', () => {
    const result = validator.inspect(backupJobSchema);
    expect(result.ok).toBe(true);
    expect(result.secretFields).toEqual(['/repository_password']);
  });

  it('surfaces guard issues before attempting to compile', () => {
    const result = validator.inspect({
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'string', pattern: '^(a+)+$', maxLength: 20 } },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => /backtrack/.test(i.message))).toBe(true);
  });

  it('reports a schema Ajv itself rejects', () => {
    // Passes the structural guard, fails strict-mode compilation: `maxLenght`
    // is a typo that Ajv would otherwise ignore, leaving a field the author
    // believes is bounded unbounded.
    const result = validator.inspect({
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'string', maxLenght: 10 } },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => /failed to compile/.test(i.message))).toBe(true);
  });
});

describe('validator caching', () => {
  it('reuses a compiled schema across records', () => {
    const validator = new FlexibleAssetValidator();
    for (let i = 0; i < 20; i += 1) {
      validator.validateRecord('one-version', backupJobSchema, ['/repository_password'], {
        target: `nas${i}`,
        schedule: 'nightly',
      });
    }
    // Immutable published versions make the version id a safe cache key.
    expect(validator.cacheSize).toBe(1);
  });

  it('bounds the cache', () => {
    const validator = new FlexibleAssetValidator({ maxCachedSchemas: 3 });
    for (let i = 0; i < 10; i += 1) {
      validator.validateRecord(`version-${i}`, backupJobSchema, [], { target: 'x', schedule: 'nightly' });
    }
    expect(validator.cacheSize).toBeLessThanOrEqual(3);
  });
});

describe('the structural scan sees through group nesting', () => {
  it('catches a nested-group form that a source-text heuristic misses', () => {
    // `((a)+)+` is the shape that motivated rewriting the detector as a scanner:
    // the inner quantifier sits inside its own group, so no amount of regex over
    // the pattern source finds it. Against 31 characters it runs for minutes.
    expect(detectCatastrophicBacktracking('^((a)+)+$')).toMatch(/quantified group/);
    expect(detectCatastrophicBacktracking('^(((a)+))+$')).toMatch(/quantified group/);
    expect(detectCatastrophicBacktracking('^(?:[a-z]+[a-z0-9]*)*!$')).toBeTruthy();
  });

  it('treats an unbounded brace quantifier as unbounded', () => {
    expect(detectCatastrophicBacktracking('^(a{1,})+$')).toBeTruthy();
    // A bounded repetition cannot blow up the same way.
    expect(detectCatastrophicBacktracking('^(a{1,3}){1,3}$')).toBeNull();
  });

  it('ignores quantifiers inside a character class', () => {
    // `[+*]` is a class containing literal + and *, not a quantifier.
    expect(detectCatastrophicBacktracking('^[+*]+$')).toBeNull();
  });

  it('still passes ordinary patterns', () => {
    for (const safe of [
      '^[a-z0-9-]+$',
      '^\\d{1,5}$',
      '^[A-F0-9]{2}(:[A-F0-9]{2}){5}$',
      '^(?:v4|v6)$',
    ]) {
      expect(detectCatastrophicBacktracking(safe)).toBeNull();
    }
  });
});

describe('the empirical probe catches what the scan does not', () => {
  it('finishes quickly for ordinary patterns', () => {
    for (const safe of ['^[a-z0-9-]+$', '^\\d{1,5}$', '^[A-F0-9]{2}(:[A-F0-9]{2}){5}$']) {
      const cost = measurePatternCost(safe);
      expect(cost.exceededBudget).toBe(false);
    }
  });

  it('flags a catastrophic pattern, and returns promptly while doing so', () => {
    // The probe must not itself hang: it steps lengths by 4 up to 28 and aborts
    // the moment the budget is exceeded, so an exponential pattern trips while
    // the subject is still short.
    const started = performance.now();
    const cost = measurePatternCost('^((a)+)+$');
    const elapsed = performance.now() - started;

    expect(cost.exceededBudget).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });

  it('rejects such a pattern at publish time even with a maxLength', () => {
    // The whole point: a length bound does NOT make this safe, so declaring one
    // must not be enough to get it published.
    const { issues } = inspectSchema({
      type: 'object',
      additionalProperties: false,
      properties: { code: { type: 'string', pattern: '^((a)+)+$', maxLength: 40 } },
    });
    expect(issues.length).toBeGreaterThan(0);
  });
});
