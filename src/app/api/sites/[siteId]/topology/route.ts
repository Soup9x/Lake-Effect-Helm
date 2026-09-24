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
  source: string;
  label_customised: boolean;
  device_type_customised: boolean;
  ip_address_customised: boolean;
  subnet_customised: boolean;
}

interface LinkRow {
  id: string;
  from_node_id: string;
  to_node_id: string;
  label: string | null;
  source: string;
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

    const [nodes, links, bound] = await Promise.all([
      tx<NodeRow[]>`
        SELECT id, asset_node_id, label, ip_address, subnet,
               device_type::text AS device_type, pos_x, pos_y, source::text AS source,
               label_customised, device_type_customised,
               ip_address_customised, subnet_customised
        FROM topology_node
        WHERE site_id = ${siteId}::uuid
        ORDER BY created_at
      `,
      tx<LinkRow[]>`
        SELECT id, from_node_id, to_node_id, label, source::text AS source
        FROM topology_link
        WHERE site_id = ${siteId}::uuid
        ORDER BY created_at
      `,
      /*
       * Whether anything still feeds this diagram.
       *
       * The interface needs it to tell the truth about deleting a synced box:
       * it comes back on the next poll if a controller is still reporting the
       * device, and stays gone if nothing is. Without this the warning would
       * have to be written in the conditional voice, which is how warnings get
       * ignored.
       */
      tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM unifi_site_mapping
        WHERE site_id = ${siteId}::uuid AND is_active
      `,
    ]);

    return {
      site: { id: site.id, name: site.name },
      unifiBound: Number(bound[0]?.n ?? 0) > 0,
      nodes: nodes.map((n) => ({
        id: n.id,
        assetNodeId: n.asset_node_id,
        label: n.label,
        ipAddress: n.ip_address,
        subnet: n.subnet,
        deviceType: n.device_type,
        posX: n.pos_x,
        posY: n.pos_y,
        source: n.source,
        customised: {
          label: n.label_customised,
          deviceType: n.device_type_customised,
          ipAddress: n.ip_address_customised,
          subnet: n.subnet_customised,
        },
      })),
      links: links.map((l) => ({
        id: l.id,
        fromNodeId: l.from_node_id,
        toNodeId: l.to_node_id,
        label: l.label,
        source: l.source,
      })),
    };
  },
  { permissions: ['asset:read'] },
);

export const dynamic = 'force-dynamic';
