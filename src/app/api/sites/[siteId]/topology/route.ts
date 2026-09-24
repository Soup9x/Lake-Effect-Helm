import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/**
 * GET /api/sites/{siteId}/topology — the whole diagram in one call.
 *
 * One call rather than one per collection: a canvas cannot render links before
 * it has nodes, so two round trips would only add a frame where the lines are
 * missing. The graphs are small — a site, not a client — and bounded by what a
 * person is willing to look at.
 *
 * Read is gated on asset:read, matching GET /api/sites and
 * GET /api/assets/{nodeId}: a network diagram is a view of the client's
 * equipment, and anybody who may see the equipment may see how it is wired.
 * RLS is what actually holds — topology rows are scoped through `site`, so a
 * client-side actor sees their own sites' diagrams and nothing else.
 */

interface NodeRow {
  id: string;
  asset_node_id: string | null;
  label: string;
  ip_address: string | null;
  subnet: string | null;
  device_type: string;
  pos_x: number | null;
  pos_y: number | null;
}

interface LinkRow {
  id: string;
  from_node_id: string;
  to_node_id: string;
  label: string | null;
}

export const GET = tenantRoute(
  async ({ tx, params }) => {
    const siteId = params.siteId;
    if (!siteId || !z.guid().safeParse(siteId).success) {
      throw ApiError.invalid('siteId must be a UUID');
    }

    // RLS already refuses a site in another tenant or out of the actor's
    // organisation scope, so "not found" and "not yours" are one answer — the
    // same posture the client page takes.
    const [site] = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM site WHERE id = ${siteId}::uuid AND deleted_at IS NULL
    `;
    if (!site) throw ApiError.notFound('no such site');

    const [nodes, links] = await Promise.all([
      tx<NodeRow[]>`
        SELECT id, asset_node_id, label, ip_address, subnet,
               device_type::text AS device_type, pos_x, pos_y
        FROM topology_node
        WHERE site_id = ${siteId}::uuid
        ORDER BY created_at
      `,
      tx<LinkRow[]>`
        SELECT id, from_node_id, to_node_id, label
        FROM topology_link
        WHERE site_id = ${siteId}::uuid
        ORDER BY created_at
      `,
    ]);

    return {
      site: { id: site.id, name: site.name },
      nodes: nodes.map((n) => ({
        id: n.id,
        assetNodeId: n.asset_node_id,
        label: n.label,
        ipAddress: n.ip_address,
        subnet: n.subnet,
        deviceType: n.device_type,
        posX: n.pos_x,
        posY: n.pos_y,
      })),
      links: links.map((l) => ({
        id: l.id,
        fromNodeId: l.from_node_id,
        toNodeId: l.to_node_id,
        label: l.label,
      })),
    };
  },
  { permissions: ['asset:read'] },
);

export const dynamic = 'force-dynamic';
