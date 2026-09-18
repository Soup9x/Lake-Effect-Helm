/**
 * What actually changed in an edit form.
 *
 * Every PATCH endpoint in this product takes a partial body and leaves out what
 * it is not given — `COALESCE(${body.name ?? null}, name)` and friends. Sending
 * the whole form back on every save would work, but it makes the audit trail
 * useless: every edit would read as though the person had rewritten every
 * field, and "who changed the criticality" becomes unanswerable.
 *
 * So an edit sends only the fields whose value differs from the one it opened
 * with. Extracted here rather than written inline in each form because there
 * are four of them and this is the part that is easy to get subtly wrong.
 */

/** Values a form field can hold once it has been normalised for sending. */
export type FieldValue = string | number | boolean | null | string[];

/**
 * Trimmed, with empty strings collapsed to null.
 *
 * An emptied text box means "clear this field", which the PATCH schemas accept
 * as an explicit null — NOT as an absent key, which would mean "leave it". The
 * difference is the whole reason this function exists.
 */
export function normalise(value: FieldValue | undefined): FieldValue {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value;
}

function same(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    // Order is not meaningful for a tag list, and a reorder is not an edit.
    if (a.length !== b.length) return false;
    const left = [...a].sort();
    const right = [...b].sort();
    return left.every((value, index) => value === right[index]);
  }
  return a === b;
}

/**
 * The subset of `current` that differs from `initial`.
 *
 * Both are read after `normalise`, so "  " and "" and null are one value and a
 * save that only added whitespace sends nothing at all.
 */
export function changedFields<T extends Record<string, FieldValue>>(
  initial: T,
  current: T,
): Partial<T> {
  const changes: Partial<T> = {};
  for (const key of Object.keys(current) as (keyof T)[]) {
    const before = normalise(initial[key]);
    const after = normalise(current[key]);
    if (!same(before, after)) changes[key] = after as T[keyof T];
  }
  return changes;
}

/** Whether a save would do anything, for disabling the button. */
export function hasChanges<T extends Record<string, FieldValue>>(initial: T, current: T): boolean {
  return Object.keys(changedFields(initial, current)).length > 0;
}
