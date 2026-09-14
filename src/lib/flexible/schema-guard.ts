/**
 * Vetting technician-authored JSON Schemas before they can be published.
 *
 * The flexible asset builder lets a Tier 3 engineer define a documentation
 * template at 4pm on a Friday. That schema is then compiled by Ajv and run
 * against input, which makes it *code* in every sense that matters. A schema is
 * therefore untrusted input even though only a privileged user can write one:
 * privilege protects against malice, not against a mistake.
 *
 * Four things this guards against, in rough order of how likely they are to
 * actually happen:
 *
 * 1. REGULAR EXPRESSION DENIAL OF SERVICE. A `pattern` compiles to a JS RegExp
 *    with no timeout, and a backtracking one hangs the event loop for the whole
 *    process — every tenant, not just the one whose record triggered it. This is
 *    the realistic hazard, and it arrives by accident: a pattern like
 *    "one or more word characters, optionally followed by a space, repeated"
 *    looks perfectly reasonable and is catastrophic.
 *
 *    Worth being precise about what does and does not help, because it is easy
 *    to assume a length limit is enough. It is NOT: the pattern `^((a)+)+$`
 *    against a 31-character non-matching subject runs for over a minute.
 *    Exponential backtracking is exponential in the input length, so any bound
 *    loose enough to be useful for a form field is still catastrophic.
 *
 *    There are therefore two real defences, and both are needed:
 *      - a structural scan that understands group nesting, and
 *      - an EMPIRICAL probe that runs the pattern against adversarial input at
 *        increasing lengths and rejects anything whose cost grows.
 *    Neither is a proof — deciding this in general is undecidable — but together
 *    they catch every shape that occurs in practice, and the probe covers shapes
 *    the scanner does not know about.
 *
 * 2. UNBOUNDED VALIDATION COST. Deep nesting and huge property counts turn
 *    validation into an expensive operation on a hot path.
 *
 * 3. REFERENCE RESOLUTION. `$ref` to an external URI turns schema compilation
 *    into an outbound HTTP request from the application server. Forbidden
 *    outright — a form builder has no need for it.
 *
 * 4. SILENT DATA LOSS. A schema without `additionalProperties: false` accepts
 *    fields it does not describe, which then sit in the jsonb column
 *    undocumented, unvalidated and unsearchable.
 */

export const SCHEMA_LIMITS = {
  /** Serialised schema size. Generous for a form, far below anything pathological. */
  maxBytes: 64 * 1024,
  /** Nesting depth. Two levels of object inside the root covers real templates. */
  maxDepth: 5,
  maxProperties: 120,
  maxPatternLength: 200,
  /**
   * Cap on a patterned field's maxLength.
   *
   * This reduces exposure; it does not eliminate it, and it is not what makes
   * patterns safe — see the header. 256 is ample for the identifiers,
   * hostnames and serial numbers these fields actually hold.
   */
  maxPatternedStringLength: 256,
  /**
   * Budget for the empirical probe, in milliseconds.
   *
   * A pattern whose worst observed match exceeds this at 28 characters is
   * growing faster than linearly and is rejected. Ordinary patterns finish in
   * microseconds, so there is a wide margin before a legitimate one is refused.
   */
  patternProbeBudgetMs: 5,
  maxEnumValues: 200,
} as const;

export interface SchemaIssue {
  path: string;
  message: string;
}

export interface SchemaInspection {
  ok: boolean;
  issues: SchemaIssue[];
  /** JSON Pointers to fields marked `x-helm-secret`. */
  secretFields: string[];
  /** Every top-level property, for the UI's field-ordering editor. */
  propertyNames: string[];
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Inspect a schema. Returns every problem found rather than the first, because
 * a form author fixing one error at a time across six round trips gives up and
 * asks for the validation to be turned off.
 */
export function inspectSchema(schema: unknown): SchemaInspection {
  const issues: SchemaIssue[] = [];
  const secretFields: string[] = [];
  const propertyNames: string[] = [];

  if (!isObject(schema)) {
    return { ok: false, issues: [{ path: '', message: 'schema must be an object' }], secretFields: [], propertyNames: [] };
  }

  const serialised = JSON.stringify(schema);
  if (serialised.length > SCHEMA_LIMITS.maxBytes) {
    issues.push({
      path: '',
      message: `schema is ${serialised.length} bytes; the limit is ${SCHEMA_LIMITS.maxBytes}`,
    });
  }

  if (schema.type !== 'object') {
    issues.push({ path: '', message: "the root schema must declare type: 'object'" });
  }

  if (schema.additionalProperties !== false) {
    issues.push({
      path: '',
      message:
        'the root schema must set additionalProperties: false, otherwise undeclared ' +
        'fields are stored without validation and never appear in search',
    });
  }

  const rootProperties = isObject(schema.properties) ? schema.properties : null;
  if (!rootProperties || Object.keys(rootProperties).length === 0) {
    issues.push({ path: '', message: 'the schema declares no properties' });
  }

  let propertyCount = 0;

  const walk = (node: unknown, path: string, depth: number): void => {
    if (!isObject(node)) return;

    if (depth > SCHEMA_LIMITS.maxDepth) {
      issues.push({ path, message: `nesting exceeds the depth limit of ${SCHEMA_LIMITS.maxDepth}` });
      return;
    }

    for (const key of ['$ref', '$dynamicRef', '$recursiveRef']) {
      if (key in node) {
        issues.push({
          path,
          message: `${key} is not permitted; schema references are disabled so that ` +
            'compiling a schema can never become an outbound network request',
        });
      }
    }

    if ('pattern' in node) {
      inspectPattern(node, path, issues);
    }

    if ('patternProperties' in node) {
      issues.push({
        path,
        message: 'patternProperties is not permitted; declare each field explicitly',
      });
    }

    if (Array.isArray(node.enum) && node.enum.length > SCHEMA_LIMITS.maxEnumValues) {
      issues.push({
        path,
        message: `enum has ${node.enum.length} values; the limit is ${SCHEMA_LIMITS.maxEnumValues}`,
      });
    }

    if (isObject(node.properties)) {
      for (const [name, child] of Object.entries(node.properties)) {
        propertyCount += 1;
        const childPath = `${path}/${escapePointer(name)}`;

        if (depth === 0) {
          propertyNames.push(name);
          if (isObject(child) && child['x-helm-secret'] === true) {
            inspectSecretField(child, name, childPath, issues);
            secretFields.push(`/${escapePointer(name)}`);
          }
        } else if (isObject(child) && child['x-helm-secret'] === true) {
          // The database trigger that enforces "no inline secrets" only examines
          // top-level keys. A nested field marked secret would be silently
          // stored in the clear — so the marker is refused where it cannot be
          // enforced, rather than honoured where it cannot be kept.
          issues.push({
            path: childPath,
            message:
              'x-helm-secret is only supported on top-level fields; nested secret ' +
              'fields cannot be enforced by the database and would be stored in the clear',
          });
        }

        walk(child, childPath, depth + 1);
      }
    }

    if (isObject(node.items)) walk(node.items, `${path}/items`, depth + 1);

    for (const combinator of ['allOf', 'anyOf', 'oneOf']) {
      const branches = node[combinator];
      if (Array.isArray(branches)) {
        branches.forEach((branch, index) => walk(branch, `${path}/${combinator}/${index}`, depth + 1));
      }
    }
    if ('not' in node) walk(node.not, `${path}/not`, depth + 1);
  };

  walk(schema, '', 0);

  if (propertyCount > SCHEMA_LIMITS.maxProperties) {
    issues.push({
      path: '',
      message: `schema declares ${propertyCount} properties; the limit is ${SCHEMA_LIMITS.maxProperties}`,
    });
  }

  return { ok: issues.length === 0, issues, secretFields, propertyNames };
}

function inspectSecretField(
  field: JsonObject,
  name: string,
  path: string,
  issues: SchemaIssue[],
): void {
  if (field.type !== 'string') {
    issues.push({
      path,
      message: `x-helm-secret field '${name}' must be type: 'string'`,
    });
  }
  if ('default' in field) {
    issues.push({
      path,
      message: `x-helm-secret field '${name}' must not declare a default; a default ` +
        'secret is a shared secret, and it would be stored in the schema in the clear',
    });
  }
  if ('enum' in field) {
    issues.push({
      path,
      message: `x-helm-secret field '${name}' must not declare an enum; the permitted ` +
        'values would be a public list of the possible secrets',
    });
  }
}

function inspectPattern(node: JsonObject, path: string, issues: SchemaIssue[]): void {
  const pattern = node.pattern;

  if (typeof pattern !== 'string') {
    issues.push({ path, message: 'pattern must be a string' });
    return;
  }

  if (pattern.length > SCHEMA_LIMITS.maxPatternLength) {
    issues.push({
      path,
      message: `pattern is ${pattern.length} characters; the limit is ${SCHEMA_LIMITS.maxPatternLength}`,
    });
  }

  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, 'u');
  } catch {
    issues.push({ path, message: 'pattern is not a valid regular expression' });
    return;
  }

  // The structural defence: refuse shapes known to backtrack catastrophically.
  const risky = detectCatastrophicBacktracking(pattern);
  if (risky) {
    issues.push({
      path,
      message:
        `pattern contains ${risky}, which can backtrack catastrophically and hang ` +
        'the server for every tenant. Rewrite it without nested or adjacent ' +
        'unbounded quantifiers.',
    });
  }

  // The empirical defence: actually run it. This catches shapes the structural
  // scan does not know about, which is the point — the scan is a heuristic and
  // a length bound alone is not sufficient for exponential backtracking.
  if (!risky) {
    const cost = measurePatternCost(pattern);
    if (cost.exceededBudget) {
      issues.push({
        path,
        message:
          `pattern took ${cost.worstMs.toFixed(1)}ms against a ${cost.worstLength}-character ` +
          'input, which means its cost grows faster than linearly. Against real input it ' +
          'would block the server for every tenant. Rewrite it without nested or ' +
          'overlapping unbounded quantifiers.',
      });
    }
  }

  // Reduces exposure, and required so that a field's cost is at least bounded —
  // but see the file header: this is not on its own what makes patterns safe.
  const maxLength = node.maxLength;
  if (typeof maxLength !== 'number') {
    issues.push({
      path,
      message:
        'a field with a pattern must also declare maxLength, so its matching cost is ' +
        'at least bounded',
    });
  } else if (maxLength > SCHEMA_LIMITS.maxPatternedStringLength) {
    issues.push({
      path,
      message: `maxLength ${maxLength} is above the ${SCHEMA_LIMITS.maxPatternedStringLength} ` +
        'limit for a patterned field',
    });
  }
}

/**
 * Structural scan for catastrophically backtracking patterns.
 *
 * Walks the pattern tracking group nesting, so it sees through arbitrary
 * nesting rather than pattern-matching on the source text. The shape that
 * matters is a quantified group whose body itself contains an unbounded
 * quantifier or an alternation — `(a+)+`, `((a)+)+`, `(a|ab)*` — because that is
 * what produces exponentially many ways to split the same input.
 *
 * Deliberately not exhaustive: a complete decision procedure is undecidable, and
 * anything claiming otherwise is lying. The empirical probe below is what
 * catches the shapes this misses.
 */
export function detectCatastrophicBacktracking(pattern: string): string | null {
  interface Frame {
    hasUnboundedQuantifier: boolean;
    hasAlternation: boolean;
  }

  const root: Frame = { hasUnboundedQuantifier: false, hasAlternation: false };
  const stack: Frame[] = [root];
  let inClass = false;

  const top = (): Frame => stack[stack.length - 1] ?? root;

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];

    if (ch === '\\') {
      // A quantified backreference multiplies the same way.
      const next = pattern[i + 1];
      if (next && /\d/.test(next) && isUnboundedQuantifier(pattern, i + 2)) {
        return 'a quantified backreference';
      }
      i += 1;
      continue;
    }

    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }

    if (ch === '[') {
      inClass = true;
      continue;
    }

    if (ch === '(') {
      stack.push({ hasUnboundedQuantifier: false, hasAlternation: false });
      continue;
    }

    if (ch === ')') {
      const frame = stack.pop() ?? root;
      const quantified = isUnboundedQuantifier(pattern, i + 1);

      if (quantified && frame.hasUnboundedQuantifier) {
        return 'a quantified group containing another unbounded quantifier, such as (a+)+';
      }
      if (quantified && frame.hasAlternation) {
        return 'a quantified alternation such as (a|b)*';
      }

      // Propagate the quantifier upward whether or not THIS group is quantified.
      // An intervening plain group changes nothing: `((a+))+` is exactly as
      // catastrophic as `(a+)+`, and only looking at directly-quantified groups
      // misses it.
      const parent = top();
      if (quantified || frame.hasUnboundedQuantifier) {
        parent.hasUnboundedQuantifier = true;
      }

      // Alternation is deliberately NOT propagated through an unquantified
      // group. `((a|b)c)+` is safe — the branches cannot match the same text —
      // and propagating would reject it. Genuinely overlapping alternations that
      // escape this scan are what the empirical probe is for.
      continue;
    }

    if (ch === '|') {
      top().hasAlternation = true;
      continue;
    }

    if (isUnboundedQuantifier(pattern, i)) {
      top().hasUnboundedQuantifier = true;
    }
  }

  // Two unbounded quantifiers over the same class, back to back.
  if (/(\\[dswDSW]|\[[^\]]+\]|\.)[+*]\s*\1[+*]/.test(pattern)) {
    return 'adjacent unbounded quantifiers over the same class';
  }

  return null;
}

/** `+`, `*`, `{n,}` — anything with no upper bound. `{n,m}` is bounded and fine. */
function isUnboundedQuantifier(pattern: string, index: number): boolean {
  const ch = pattern[index];
  if (ch === '+' || ch === '*') return true;
  if (ch !== '{') return false;
  const close = pattern.indexOf('}', index);
  if (close === -1) return false;
  return /^\{\d*,\}$/.test(pattern.slice(index, close + 1));
}

export interface PatternCost {
  worstMs: number;
  worstLength: number;
  /** True when probing stopped early because the pattern was already too slow. */
  exceededBudget: boolean;
}

/**
 * Empirically measure what a pattern costs on adversarial input.
 *
 * This is the defence that does not depend on recognising a shape. It runs the
 * pattern against strings designed to force backtracking — a long run of a
 * plausible character followed by one that cannot match — at increasing lengths,
 * and stops the moment the cost exceeds the budget.
 *
 * Probing is itself bounded: lengths step by 4 up to 28, never doubling, so an
 * exponential pattern trips the budget while the subject is still short enough
 * that the probe returns in well under a second. Probing a truly exponential
 * pattern at 64 characters would hang the very request trying to protect
 * against hanging.
 *
 * Runs once, when a schema is published — never on the record write path.
 */
export function measurePatternCost(
  pattern: string,
  budgetMs: number = SCHEMA_LIMITS.patternProbeBudgetMs,
): PatternCost {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'u');
  } catch {
    return { worstMs: 0, worstLength: 0, exceededBudget: false };
  }

  // Characters a pattern is likely to be able to consume, each followed by one
  // it almost certainly cannot.
  const fillers = ['a', '0', ' ', 'ab', 'a1', '-'];
  const terminators = ['!', '\u0000', 'Z'];

  let worstMs = 0;
  let worstLength = 0;

  for (let length = 4; length <= 28; length += 4) {
    for (const filler of fillers) {
      const base = filler.repeat(Math.ceil(length / filler.length)).slice(0, length);
      for (const terminator of terminators) {
        const subject = base.slice(0, -1) + terminator;
        const started = performance.now();
        try {
          regex.test(subject);
        } catch {
          // A pattern that throws at match time is the compile check's problem.
        }
        const elapsed = performance.now() - started;

        if (elapsed > worstMs) {
          worstMs = elapsed;
          worstLength = subject.length;
        }
        if (worstMs > budgetMs) {
          return { worstMs, worstLength, exceededBudget: true };
        }
      }
    }
  }

  return { worstMs, worstLength, exceededBudget: false };
}

/** RFC 6901: `~` becomes `~0`, `/` becomes `~1`. */
export function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
