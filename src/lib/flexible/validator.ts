/**
 * Validating flexible asset records against their pinned schema version.
 *
 * Two jobs, and the second one is the security-relevant half:
 *
 *   1. Validate the submitted document against the schema the record's version
 *      pins. Ajv does this.
 *
 *   2. SPLIT secret fields out of the document before it is written. A field
 *      marked `x-helm-secret` never reaches the jsonb column; it goes through
 *      the audited secret API and the document keeps only a reference. Without
 *      this split, a technician's custom "Backup Repository Password" field
 *      would sit in plaintext in a searchable, replicated, backed-up column,
 *      outside the entire key hierarchy.
 *
 * The database backs both up: a trigger rejects a document that still contains
 * a declared-secret field (db/sql/0080, hardened in 0240). This layer is where
 * it is done correctly; the trigger is where it is caught if this layer is
 * wrong.
 */
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { inspectSchema, unescapePointer, type SchemaIssue } from './schema-guard';

export interface FieldError {
  /** JSON Pointer into the submitted document. */
  path: string;
  message: string;
}

export interface ValidationSuccess {
  ok: true;
  /** Safe to store in flexible_asset_record.data — secret fields removed. */
  data: Record<string, unknown>;
  /** Field pointer -> plaintext, for the secret API. Wipe after use. */
  secrets: Map<string, string>;
}

export interface ValidationFailure {
  ok: false;
  errors: FieldError[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

/**
 * One Ajv instance, configured once.
 *
 * Every option here is load-bearing:
 *
 *   strict / strictSchema  reject schema mistakes at compile time rather than
 *                          silently ignoring a misspelled keyword. A typo'd
 *                          `maxLenght` that is quietly dropped means a field the
 *                          author believes is bounded is not.
 *   coerceTypes: false     "5" must not silently become 5. A VLAN id arriving
 *                          as a string is a bug worth surfacing.
 *   useDefaults: false     defaults would mutate the submitted document, so the
 *                          record would contain values the technician never
 *                          entered and cannot see the origin of.
 *   removeAdditional:false unknown fields are an error, not something to drop
 *                          silently — the schema guard already requires
 *                          additionalProperties: false.
 *   allErrors: true        report every problem in one pass; a form that
 *                          surfaces one error at a time gets abandoned.
 *   loadSchema absent      no remote $ref resolution. The schema guard forbids
 *                          $ref anyway; this is the second lock on that door.
 */
function createAjv(): Ajv {
  const ajv = new Ajv({
    strict: true,
    strictSchema: true,
    strictTypes: true,
    strictTuples: true,
    allowUnionTypes: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    allErrors: true,
    validateSchema: true,
    // `x-helm-secret` is Helm's marker, consumed by the schema guard and the
    // splitter below. Declaring it keeps strict mode from rejecting it as an
    // unknown keyword, without giving it any validation behaviour.
    keywords: [{ keyword: 'x-helm-secret', schemaType: 'boolean', valid: true }],
  });
  addFormats(ajv);
  return ajv;
}

export interface CompiledSchema {
  validate: ValidateFunction;
  secretFields: string[];
}

/**
 * Compiles and caches validators.
 *
 * Keyed by flexible_asset_type_version.id, which is safe precisely because a
 * published schema version is immutable (enforced by trigger in db/sql/0080).
 * A mutable key would serve a stale validator after an edit; here there is no
 * such thing as an edit.
 */
export class FlexibleAssetValidator {
  readonly #ajv: Ajv;
  readonly #cache = new Map<string, CompiledSchema>();
  readonly #maxCached: number;

  constructor(options: { maxCachedSchemas?: number } = {}) {
    this.#ajv = createAjv();
    this.#maxCached = options.maxCachedSchemas ?? 200;
  }

  get cacheSize(): number {
    return this.#cache.size;
  }

  /**
   * Check a schema before publishing it.
   *
   * Runs the structural guard first, then a trial compile. The guard catches
   * what Ajv permits but Helm should not (ReDoS-prone patterns, `$ref`,
   * unbounded nesting); the compile catches what Ajv itself rejects.
   */
  inspect(schema: unknown): { ok: boolean; issues: SchemaIssue[]; secretFields: string[] } {
    const inspection = inspectSchema(schema);
    if (!inspection.ok) {
      return { ok: false, issues: inspection.issues, secretFields: inspection.secretFields };
    }

    try {
      this.#ajv.compile(schema as object);
    } catch (error) {
      return {
        ok: false,
        issues: [{ path: '', message: `schema failed to compile: ${asMessage(error)}` }],
        secretFields: inspection.secretFields,
      };
    }

    return { ok: true, issues: [], secretFields: inspection.secretFields };
  }

  /**
   * Validate a submitted document and split out its secret fields.
   *
   * `secretFields` comes from the stored schema version rather than being
   * re-derived from the schema, so the split matches exactly what the database
   * trigger will check. Deriving it twice is how the two drift.
   */
  validateRecord(
    versionId: string,
    schema: unknown,
    secretFields: readonly string[],
    input: unknown,
  ): ValidationResult {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { ok: false, errors: [{ path: '', message: 'the record must be a JSON object' }] };
    }

    const compiled = this.#compiled(versionId, schema, secretFields);

    // Split BEFORE validating, so a secret value never sits in a validation
    // error message. Ajv reports the offending data in some error shapes, and an
    // error object is exactly the sort of thing that gets logged wholesale.
    const { data, secrets, errors: splitErrors } = splitSecrets(
      input as Record<string, unknown>,
      compiled.secretFields,
    );
    if (splitErrors.length > 0) return { ok: false, errors: splitErrors };

    // Validate the full document — secrets reinstated as placeholder strings —
    // so that `required` on a secret field still means something. A schema that
    // marks the repository password required must reject a record without one.
    const forValidation: Record<string, unknown> = { ...data };
    for (const [pointer] of secrets) {
      forValidation[pointerToKey(pointer)] = SECRET_PLACEHOLDER;
    }

    if (!compiled.validate(forValidation)) {
      return { ok: false, errors: toFieldErrors(compiled.validate.errors ?? [], compiled.secretFields) };
    }

    return { ok: true, data, secrets };
  }

  #compiled(versionId: string, schema: unknown, secretFields: readonly string[]): CompiledSchema {
    const cached = this.#cache.get(versionId);
    if (cached) return cached;

    if (this.#cache.size >= this.#maxCached) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }

    const entry: CompiledSchema = {
      validate: this.#ajv.compile(schema as object),
      secretFields: [...secretFields],
    };
    this.#cache.set(versionId, entry);
    return entry;
  }
}

/**
 * Stand-in used only during validation.
 *
 * Long enough to satisfy a sensible minLength, and obviously not a real value
 * if it ever leaks into a log. It is never stored: `data` is what gets written.
 */
const SECRET_PLACEHOLDER = '••••••••••••••••';

interface SplitResult {
  data: Record<string, unknown>;
  secrets: Map<string, string>;
  errors: FieldError[];
}

/**
 * Remove declared-secret fields from the document.
 *
 * Only top-level fields, matching what the schema guard allows and what the
 * database trigger enforces. Anything else would be a marker we cannot keep.
 */
export function splitSecrets(
  input: Record<string, unknown>,
  secretFields: readonly string[],
): SplitResult {
  const data: Record<string, unknown> = { ...input };
  const secrets = new Map<string, string>();
  const errors: FieldError[] = [];

  for (const pointer of secretFields) {
    const key = pointerToKey(pointer);
    if (!(key in data)) continue;

    const value = data[key];
    delete data[key];

    // An explicit null means "leave the existing secret alone" — the UI sends it
    // for an untouched password field, so that editing a record's other fields
    // does not require re-entering every credential on it.
    if (value === null || value === undefined) continue;

    if (typeof value !== 'string') {
      errors.push({ path: pointer, message: 'a secret field must be a string' });
      continue;
    }
    if (value.length === 0) {
      errors.push({ path: pointer, message: 'a secret field must not be empty' });
      continue;
    }

    secrets.set(pointer, value);
  }

  return { data, secrets, errors };
}

function pointerToKey(pointer: string): string {
  return unescapePointer(pointer.replace(/^\//, ''));
}

/**
 * Convert Ajv errors into something a form can render.
 *
 * Errors touching a secret field are rewritten without Ajv's detail, because
 * `params` and `data` on some error types echo the offending value.
 */
function toFieldErrors(errors: ErrorObject[], secretFields: readonly string[]): FieldError[] {
  const secretKeys = new Set(secretFields.map(pointerToKey));

  return errors.map((error) => {
    const path = error.instancePath || '/';
    const key = pointerToKey(path);

    if (secretKeys.has(key)) {
      return { path, message: 'this secret field is not valid' };
    }

    // `missingProperty` lives in params, not the path, so surface it explicitly
    // — "must have required property" with an empty path is useless in a form.
    if (error.keyword === 'required') {
      const missing = (error.params as { missingProperty?: string }).missingProperty;
      return {
        path: missing ? `/${missing}` : path,
        message: missing ? 'this field is required' : error.message ?? 'invalid',
      };
    }

    if (error.keyword === 'additionalProperties') {
      const extra = (error.params as { additionalProperty?: string }).additionalProperty;
      return {
        path: extra ? `/${extra}` : path,
        message: 'this field is not declared by the template',
      };
    }

    return { path, message: error.message ?? 'invalid' };
  });
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
