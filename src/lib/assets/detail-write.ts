/**
 * Writing a subtype row from the detail catalogue: the one place a request's
 * JSON becomes an UPDATE on a device, a network, a contract.
 *
 * Shared by PATCH /api/assets/:id/detail and the configuration routes, so a
 * device written from its sectioned form and a device written from the
 * generic Edit details go through the same casts and the same refusals.
 */
import { ApiError } from '../api/errors';
import type { HelmTx } from '../db/client';
import type { DetailField } from './detail-fields';

/**
 * The request's JSON to what the cast expects: '' and undefined clear, lists
 * arrive as arrays or as one string to split, numbers may be sent as strings
 * from a form. Anything else goes to the database as text for IT to judge.
 */
export function coerceDetail(field: DetailField, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (field.kind) {
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 'false') return raw === 'true';
      throw ApiError.invalid(`${field.label} must be true or false`, { fields: [field.key] });
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) throw ApiError.invalid(`${field.label} must be a number`, { fields: [field.key] });
      if (field.pg === 'integer' && !Number.isInteger(n)) {
        throw ApiError.invalid(`${field.label} must be a whole number`, { fields: [field.key] });
      }
      if (field.min !== undefined && n < field.min) throw ApiError.invalid(`${field.label} must be at least ${field.min}`, { fields: [field.key] });
      if (field.max !== undefined && n > field.max) throw ApiError.invalid(`${field.label} must be at most ${field.max}`, { fields: [field.key] });
      return n;
    }
    case 'text_list':
    case 'inet_list': {
      const list = Array.isArray(raw)
        ? raw.map((v) => String(v).trim()).filter((v) => v !== '')
        : String(raw).split(/[\n,]/).map((v) => v.trim()).filter((v) => v !== '');
      // A NOT NULL list column (subject_alt_names) takes '{}' when cleared.
      return list.length === 0 ? (field.required ? [] : null) : list;
    }
    case 'select': {
      const s = String(raw);
      if (!field.options?.includes(s)) {
        throw ApiError.invalid(`${field.label} must be one of ${field.options?.join(', ')}`, { fields: [field.key] });
      }
      return s;
    }
    default: {
      if (typeof raw !== 'string' && typeof raw !== 'number') {
        throw ApiError.invalid(`${field.label} must be text`, { fields: [field.key] });
      }
      const s = String(raw).trim();
      if (s.length > 4000) throw ApiError.invalid(`${field.label} is too long`, { fields: [field.key] });
      return s === '' ? null : s;
    }
  }
}

/**
 * UPDATE one row of `table` with the catalogue fields present in `body`.
 * Keys outside the catalogue are refused; a required field cannot be cleared.
 * Returns the keys written, or [] when the body named none.
 */
export async function writeDetail(
  tx: HelmTx,
  table: string,
  fields: readonly DetailField[],
  id: string,
  body: Record<string, unknown>,
  options: { kindName: string },
): Promise<string[]> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const unknown = Object.keys(body).filter((k) => !byKey.has(k));
  if (unknown.length > 0) {
    throw ApiError.invalid(`not a field of a ${options.kindName}: ${unknown.join(', ')}`, { fields: unknown });
  }

  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [key, raw] of Object.entries(body)) {
    const field = byKey.get(key)!;
    const value = coerceDetail(field, raw);
    if (value === null && field.required) {
      throw ApiError.invalid(`${field.label} cannot be empty`, { fields: [key] });
    }
    values.push(value);
    assignments.push(`"${key}" = $${values.length}::${field.pg}`);
  }
  if (assignments.length === 0) return [];
  values.push(id);

  const rows = await tx.unsafe<{ id: string }[]>(
    `UPDATE "${table}" SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid RETURNING id`,
    values as never[],
  );
  if (rows.length === 0) throw ApiError.notFound('no such asset');
  return Object.keys(body);
}
