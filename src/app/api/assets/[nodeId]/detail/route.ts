import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { DETAIL_TABLE, detailFieldsFor } from '@/lib/assets/detail-fields';
import { writeDetail } from '@/lib/assets/detail-write';

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
 * come from the catalogue, never from the request. See lib/assets/detail-write.
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

    const body = await readJson(request, (raw) => {
      const result = bodySchema.safeParse(raw);
      if (!result.success || Object.keys(result.data).length === 0) {
        throw ApiError.invalid('an object of fields to change');
      }
      return result.data;
    });

    const updated = await writeDetail(tx, table, fields, nodeId.data, body, { kindName: node.node_type });
    await tx`
      UPDATE asset_node SET updated_at = now(), updated_by = ${identity.actorId}::uuid
      WHERE id = ${nodeId.data}::uuid
    `;
    return { updated };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
