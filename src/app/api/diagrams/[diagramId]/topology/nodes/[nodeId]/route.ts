import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';

/**
 * PATCH and DELETE one box.
 *
 * A drag sends posX/posY; an edit sends whichever fields changed. Both are the
 * same kind of write, because a person is the only thing that writes here.
 *
 * An explicit null clears a field, and an absent field is left alone. The two
 * are different on purpose: "no IP on this box" is a decision somebody made,
 * and a PATCH that only moves a node must not erase it.
 */
const patchSchema = z
  .object({
    posX: z.number().finite().nullable().optional(),
    posY: z.number().finite().nullable().optional(),
    label: z.string().trim().min(1).max(120).optional(),
    ipAddress: z.string().trim().max(64).nullable().optional(),
    subnet: z.string().trim().max(64).nullable().optional(),
    deviceType: z
      .enum(['switch', 'router', 'firewall', 'server', 'access_point', 'generic'])
      .optional(),
    assetNodeId: z.guid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' })
  .refine((v) => (v.posX === undefined) === (v.posY === undefined), {
    message: 'a position needs both posX and posY',
  });

function ids(params: Record<string, string>): { diagramId: string; nodeId: string } {
  const diagramId = params.diagramId;
  const nodeId = params.nodeId;
  if (!diagramId || !z.guid().safeParse(diagramId).success) {
    throw ApiError.invalid('diagramId must be a UUID');
  }
  if (!nodeId || !z.guid().safeParse(nodeId).success) {
    throw ApiError.invalid('nodeId must be a UUID');
  }
  return { diagramId, nodeId };
}

export const PATCH = tenantRoute(
  async ({ tx, request, params }) => {
    const { diagramId, nodeId } = ids(params);

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid topology node change', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });

    /*
     * COALESCE over the parameter, so an absent field is left alone and an
     * explicit null clears it — the same shape PATCH /api/sites uses.
     */
    let row: { id: string } | undefined;
    try {
      [row] = await tx<{ id: string }[]>`
        UPDATE topology_node SET
          pos_x       = CASE WHEN ${body.posX !== undefined} THEN ${body.posX ?? null}::double precision ELSE pos_x END,
          pos_y       = CASE WHEN ${body.posY !== undefined} THEN ${body.posY ?? null}::double precision ELSE pos_y END,
          label       = COALESCE(${body.label ?? null}, label),
          ip_address  = CASE WHEN ${body.ipAddress !== undefined} THEN ${body.ipAddress ?? null} ELSE ip_address END,
          subnet      = CASE WHEN ${body.subnet !== undefined} THEN ${body.subnet ?? null} ELSE subnet END,
          device_type = COALESCE(${body.deviceType ?? null}::topology_device_type, device_type),
          asset_node_id = CASE WHEN ${body.assetNodeId !== undefined}
                               THEN ${body.assetNodeId ?? null}::uuid ELSE asset_node_id END
        WHERE id = ${nodeId}::uuid AND diagram_id = ${diagramId}::uuid
        RETURNING id
      `;
    } catch (error) {
      if ((error as { code?: string }).code === '23514') {
        throw ApiError.invalid('a box can only stand for one of this client’s entries');
      }
      throw error;
    }

    // RLS refuses a node outside the actor's reach by matching no row, so this
    // is the same answer for "not there" and "not yours".
    if (!row) throw ApiError.notFound('no such topology node');
    return { nodeId: row.id };
  },
  { permissions: ['asset:write'] },
);

/**
 * DELETE one box, and the lines that touched it.
 *
 * The cascade is in the FK, not here: a link to a node that no longer exists
 * cannot be drawn, and leaving one behind would be a row the interface has to
 * learn to ignore.
 */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const { diagramId, nodeId } = ids(params);

    const [row] = await tx<{ id: string }[]>`
      DELETE FROM topology_node
      WHERE id = ${nodeId}::uuid AND diagram_id = ${diagramId}::uuid
      RETURNING id
    `;
    if (!row) throw ApiError.notFound('no such topology node');

    return { deleted: row.id };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
