import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { DETAIL_TABLE, detailFieldsFor, type DetailField } from '@/lib/assets/detail-fields';

/**
 * PATCH /api/assets/[nodeId]/detail — the asset's own kind of facts.
 *
 * /api/assets/[nodeId] writes asset_node: the name, status, site and tags
 * every asset has. This writes the subtype row — a network's CIDR and
 * gateway, a device's serial and warranty — from the catalogue in
 * src/lib/assets/detail-fields.ts, which is also what the page renders. A key
 * outside the catalogue for this asset's type is refused, so no request can
 * name a column the form does not show.
 *
 * VALUES ARE CAST, NOT PARSED. Each field names its SQL type and the UPDATE
 * casts the text to it; the database refuses a malformed address, a gateway
 * outside its subnet or a certificate that expires before it starts, and
 * pg-errors turns the refusal into a 400 that says why. Column and table names
 * come from the catalogue, never from the request.
 */
const bodySchema = z.record(z.string().min(1).max(64), z.unknown());

export const PATCH = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const nodeId = z.guid().safeParse(params.nodeId);
    if (!nodeId.success) throw ApiError.invalid('not an asset id');

    const [node] = await tx<{ node_type: string }[]>`
      SELECT node_type::text AS node_type FROM asset_node
      WHERE id = ${nodeId.data}::uuid AND archived_at IS NULL
    `;
    if (!node) throw ApiError.notFound('no such asset');

    const fields = detailFieldsFor(node.node_type);
    const table = DETAIL_TABLE[node.node_type];
    if (fields.length === 0 || !table) {
      throw ApiError.invalid(`a ${node.node_type} has no editable details`);
    }
    const byKey = new Map(fields.map((f) => [f.key, f]));

    const body = await readJson(request, (raw) => {
      const result = bodySchema.safeParse(raw);
      if (!result.success || Object.keys(result.data).length === 0) {
        throw ApiError.invalid('an object of fields to change');
      }
      return result.data;
    });

    const unknown = Object.keys(body).filter((k) => !byKey.has(k));
    if (unknown.length > 0) {
      throw ApiError.invalid(`not a field of a ${node.node_type}: ${unknown.join(', ')}`, { fields: unknown });
    }

    // One SET clause per field, each a parameter with the catalogue's cast.
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, raw] of Object.entries(body)) {
      const field = byKey.get(key)!;
      const value = coerce(field, raw);
      if (value === null && field.required) {
        throw ApiError.invalid(`${field.label} cannot be empty`, { fields: [key] });
      }
      values.push(value);
      assignments.push(`"${key}" = $${values.length}::${field.pg}`);
    }
    values.push(nodeId.data);

    const rows = await tx.unsafe<{ id: string }[]>(
      `UPDATE "${table}" SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid RETURNING id`,
      values as never[],
    );
    if (rows.length === 0) throw ApiError.notFound('no such asset');

    await tx`
      UPDATE asset_node SET updated_at = now(), updated_by = ${identity.actorId}::uuid
      WHERE id = ${nodeId.data}::uuid
    `;

    return { updated: Object.keys(body) };
  },
  { permissions: ['asset:write'] },
);

/**
 * The request's JSON to what the cast expects: '' and undefined clear, lists
 * arrive as arrays or as one string to split, numbers may be sent as strings
 * from a form. Anything else goes to the database as text for IT to judge.
 */
function coerce(field: DetailField, raw: unknown): unknown {
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

export const dynamic = 'force-dynamic';
