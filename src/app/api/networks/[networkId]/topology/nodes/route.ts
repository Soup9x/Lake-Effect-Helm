import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';

/**
 * POST /api/networks/{networkId}/topology/nodes — add a box: drawn by hand, or
 * standing for one of the client's configurations (assetNodeId).
 *
 * Every node is drawn by a person — a switch, an ISP handoff, a patch panel, a
 * printer nobody manages. Nothing else writes to this table (0580), so there is
 * no second writer to reconcile with and no provenance to record.
 *
 * asset:write, matching POST /api/sites and PATCH /api/assets/{nodeId}: drawing
 * a diagram of a client's network is ordinary client-data editing. Deliberately
 * NOT asset:link, which gates the dependency graph — a different feature with
 * different meaning, and 0570 keeps the two apart on purpose.
 */
const createSchema = z.object({
  label: z.string().trim().min(1).max(120),
  ipAddress: z.string().trim().max(64).optional(),
  subnet: z.string().trim().max(64).optional(),
  deviceType: z
    .enum(['switch', 'router', 'firewall', 'server', 'access_point', 'generic'])
    .default('generic'),
  /** Where the click landed. Optional: the canvas may let the layout place it. */
  posX: z.number().finite().optional(),
  posY: z.number().finite().optional(),
  /** Link the box to a real asset, so clicking it opens that asset's page. */
  assetNodeId: z.guid().optional(),
});

export const POST = tenantRoute(
  async ({ tx, request, params }) => {
    const networkId = params.networkId;
    if (!networkId || !z.guid().safeParse(networkId).success) {
      throw ApiError.invalid('networkId must be a UUID');
    }

    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid topology node', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });

    // Both coordinates or neither — 0570 has the CHECK, and refusing here says
    // which half is missing instead of surfacing a constraint name.
    if ((body.posX === undefined) !== (body.posY === undefined)) {
      throw ApiError.invalid('a position needs both posX and posY');
    }

    try {
      const [node] = await tx<{ id: string }[]>`
        INSERT INTO topology_node (
          tenant_id, network_id, asset_node_id, label, ip_address, subnet,
          device_type, pos_x, pos_y)
        VALUES (
          helm.require_tenant_id(), ${networkId}::uuid, ${body.assetNodeId ?? null}::uuid,
          ${body.label}, ${body.ipAddress ?? null}, ${body.subnet ?? null},
          ${body.deviceType}::topology_device_type,
          ${body.posX ?? null}, ${body.posY ?? null})
        RETURNING id
      `;
      if (!node) throw ApiError.conflict('the node could not be created');
      return { nodeId: node.id };
    } catch (error) {
      // The network FK and the asset FK are both composite on tenant_id, so an
      // id from another tenant — or one that simply is not there — lands here.
      if ((error as { code?: string }).code === '23503') {
        throw ApiError.invalid('no such network or entry');
      }
      // 0860's guard: the owner is not a network entry, or the box stands for
      // another client's entry.
      if ((error as { code?: string }).code === '23514') {
        throw ApiError.invalid('a box can only stand for one of this client’s entries, on a network’s diagram');
      }
      throw error;
    }
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
