import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/**
 * POST /api/sites/{siteId}/topology/nodes — add a box by hand.
 *
 * Manual nodes exist for everything the controller cannot tell us about: an ISP
 * handoff, a patch panel, a printer nobody manages, or simply a device the
 * person drawing wants represented more plainly than its asset record reads.
 *
 * `source` is fixed to 'manual' here and is not a field the caller may set.
 * A row claiming to be 'unifi_sync' without a device identity would be a node
 * the sync could never match and would therefore duplicate on every poll —
 * 0570 makes that unrepresentable with a CHECK, and this makes it unreachable.
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
    const siteId = params.siteId;
    if (!siteId || !z.guid().safeParse(siteId).success) {
      throw ApiError.invalid('siteId must be a UUID');
    }

    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid topology node', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
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
          tenant_id, site_id, asset_node_id, label, ip_address, subnet,
          device_type, pos_x, pos_y, source)
        VALUES (
          helm.require_tenant_id(), ${siteId}::uuid, ${body.assetNodeId ?? null}::uuid,
          ${body.label}, ${body.ipAddress ?? null}, ${body.subnet ?? null},
          ${body.deviceType}::topology_device_type,
          ${body.posX ?? null}, ${body.posY ?? null}, 'manual')
        RETURNING id
      `;
      if (!node) throw ApiError.conflict('the node could not be created');
      return { nodeId: node.id };
    } catch (error) {
      // The site FK and the asset FK are both composite on tenant_id, so an id
      // from another tenant — or one that simply is not there — lands here.
      if ((error as { code?: string }).code === '23503') {
        throw ApiError.invalid('no such site or asset');
      }
      throw error;
    }
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
