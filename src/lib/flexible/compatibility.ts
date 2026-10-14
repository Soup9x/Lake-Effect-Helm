/**
 * Could publishing this schema have invalidated the records already stored?
 *
 * WHY THIS EXISTS RATHER THAN A LOOP OVER THE RECORDS.
 * `flexible_asset_record.needs_migration` is documented as "Set when a schema
 * migration leaves this record no longer conforming to its type's current
 * version", and until now nothing ever set it — the column, its partial index
 * and the "Needs migration" flag on the type page were all waiting for a writer.
 *
 * The literal reading is per-record: validate every stored document against the
 * new schema. That is harder than it looks and wronger than it sounds. A stored
 * `data` column is the POST-SPLIT document — every `x-helm-secret` value has
 * been removed and encrypted into flexible_asset_secret — so running it through
 * validateRecord() fails `required` on every secret field, for every record,
 * always. Getting it right would mean reinstating a placeholder per secret the
 * record actually holds, which is a second query per record and a second place
 * that has to agree with the splitter about what a secret is.
 *
 * So the question is asked of the SCHEMAS instead: is the new one capable of
 * rejecting a document the old one accepted? If it is not, no record can have
 * become invalid and nothing needs flagging. If it is, every record written
 * against an older version is flagged — which over-reports in the case where a
 * particular record happens to survive an incompatible change, and that is the
 * direction a "somebody should look at this" flag should err in.
 *
 * SOUNDNESS OVER PRECISION, deliberately. Every rule below answers "can this
 * difference reject something that used to pass?", and anything unrecognised
 * answers yes. A schema that arrived through the API can carry keywords the
 * builder never emits, and treating an unknown keyword as harmless is how a
 * narrowing constraint slips past. The failure mode of being too cautious is a
 * flag somebody clears; the failure mode of being too clever is a record that
 * silently stops matching its own type.
 */

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/**
 * Keywords this analysis understands.
 *
 * `title` and `description` are presentation and cannot reject anything.
 * The rest are compared explicitly below. A property carrying anything else is
 * treated as possibly-narrowing, because it might be.
 */
const UNDERSTOOD_PROPERTY_KEYWORDS = new Set([
  'type', 'title', 'description', 'format', 'enum',
  'maxLength', 'minimum', 'maximum', 'x-helm-secret',
]);

const UNDERSTOOD_ROOT_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'title', 'description',
]);

export interface Compatibility {
  /** True when no document the old schema accepted can be rejected by the new. */
  compatible: boolean;
  /** Human-readable, in the order found. Empty when compatible. */
  reasons: string[];
}

function unknownKeywords(object: JsonObject, understood: Set<string>): string[] {
  return Object.keys(object).filter((k) => !understood.has(k));
}

/**
 * Compare one property's constraints.
 *
 * Returns the reasons the new one can reject what the old one accepted.
 */
function narrowings(key: string, before: JsonObject, after: JsonObject): string[] {
  const reasons: string[] = [];
  const unknown = [
    ...unknownKeywords(before, UNDERSTOOD_PROPERTY_KEYWORDS),
    ...unknownKeywords(after, UNDERSTOOD_PROPERTY_KEYWORDS),
  ];
  if (unknown.length > 0) {
    reasons.push(`"${key}" uses ${[...new Set(unknown)].join(', ')}, which this check does not model`);
  }

  // type. integer -> number accepts strictly more; the reverse rejects 1.5.
  if (before.type !== after.type) {
    const widened = before.type === 'integer' && after.type === 'number';
    if (!widened) reasons.push(`"${key}" changed type from ${String(before.type)} to ${String(after.type)}`);
  }

  // A secret lives somewhere else entirely, so flipping the marker moves the
  // value rather than constraining it — every existing record is then wrong.
  if ((before['x-helm-secret'] === true) !== (after['x-helm-secret'] === true)) {
    reasons.push(`"${key}" was turned ${after['x-helm-secret'] === true ? 'into' : 'from'} a secret field`);
  }

  // format. Gaining one is a new constraint; losing one is not.
  if (before.format !== after.format && after.format !== undefined) {
    reasons.push(`"${key}" now requires the ${String(after.format)} format`);
  }

  // enum. Gaining one constrains; an existing one may only grow.
  const beforeEnum = Array.isArray(before.enum) ? before.enum.map((v) => String(v)) : null;
  const afterEnum = Array.isArray(after.enum) ? after.enum.map((v) => String(v)) : null;
  if (afterEnum) {
    if (!beforeEnum) {
      reasons.push(`"${key}" now accepts only a fixed list of values`);
    } else {
      const removed = beforeEnum.filter((v) => !afterEnum.includes(v));
      if (removed.length > 0) {
        reasons.push(`"${key}" no longer accepts ${removed.map((v) => JSON.stringify(v)).join(', ')}`);
      }
    }
  }

  // Bounds. A new bound constrains; an existing one may only loosen.
  const bounds: [keyof JsonObject & string, 'tighter-when-smaller' | 'tighter-when-larger'][] = [
    ['maxLength', 'tighter-when-smaller'],
    ['maximum', 'tighter-when-smaller'],
    ['minimum', 'tighter-when-larger'],
  ];
  for (const [name, direction] of bounds) {
    const had = typeof before[name] === 'number' ? (before[name] as number) : null;
    const has = typeof after[name] === 'number' ? (after[name] as number) : null;
    if (has === null) continue;
    if (had === null) {
      reasons.push(`"${key}" now has a ${name}`);
    } else if (direction === 'tighter-when-smaller' ? has < had : has > had) {
      reasons.push(`"${key}" tightened ${name} from ${had} to ${has}`);
    }
  }

  return reasons;
}

/**
 * Whether every document valid under `before` is still valid under `after`.
 *
 * `before` being absent — a type whose current version somehow has no schema —
 * answers "not compatible", because nothing is known about what was accepted.
 */
export function schemaCompatibility(before: unknown, after: unknown): Compatibility {
  const old = asObject(before);
  const next = asObject(after);
  if (!old || !next) {
    return { compatible: false, reasons: ['one of the schemas is not an object'] };
  }

  const reasons: string[] = [];

  const unknownRoot = [
    ...unknownKeywords(old, UNDERSTOOD_ROOT_KEYWORDS),
    ...unknownKeywords(next, UNDERSTOOD_ROOT_KEYWORDS),
  ];
  if (unknownRoot.length > 0) {
    reasons.push(`the schema uses ${[...new Set(unknownRoot)].join(', ')}, which this check does not model`);
  }

  const oldProperties = asObject(old.properties) ?? {};
  const newProperties = asObject(next.properties) ?? {};

  // A removed property is a rejection, because additionalProperties is false:
  // an old record still carrying the key now fails. (If it were true, removing
  // a property would merely stop validating it — but the guard requires false,
  // and a schema with true is caught by the root-keyword check above only if it
  // differs, so compare it explicitly.)
  if (next.additionalProperties !== false) {
    reasons.push('the new schema does not set additionalProperties: false');
  }
  for (const key of Object.keys(oldProperties)) {
    if (!(key in newProperties)) {
      reasons.push(`"${key}" was removed, and records still carrying it would be rejected`);
      continue;
    }
    const before_ = asObject(oldProperties[key]);
    const after_ = asObject(newProperties[key]);
    if (!before_ || !after_) {
      reasons.push(`"${key}" is not described by an object in one of the schemas`);
      continue;
    }
    reasons.push(...narrowings(key, before_, after_));
  }

  // A newly required field rejects every record written without it. A property
  // that is merely NEW and optional rejects nothing, which is the common case
  // and the one worth not flagging.
  const wasRequired = new Set(
    Array.isArray(old.required) ? old.required.filter((k): k is string => typeof k === 'string') : [],
  );
  const nowRequired = Array.isArray(next.required)
    ? next.required.filter((k): k is string => typeof k === 'string')
    : [];
  for (const key of nowRequired) {
    if (!wasRequired.has(key)) reasons.push(`"${key}" is now required`);
  }

  return { compatible: reasons.length === 0, reasons };
}
