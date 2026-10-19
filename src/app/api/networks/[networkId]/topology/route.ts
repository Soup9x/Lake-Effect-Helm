import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { shapeForDevice } from '@/lib/topology/shapes';

/**
 * GET /api/networks/{networkId}/topology — a network entry's whole diagram.
 *
 * One call rather than one per collection: a canvas cannot render links before
 * it has nodes, so two round trips would only add a frame where the lines are
 * missing. The client's configurations come with it, for the "use an existing
 * configuration" picker and the "add this location's configurations" button.
 *
 * A BOX LINKED TO A CONFIGURATION SHOWS THE CONFIGURATION'S CURRENT NAME AND
 * PRIMARY IP, not what was copied when it was drawn — rename the firewall and
 * the diagram follows. Read under RLS: a box standing for an entry this reader
 * may not see (an internal-only one, for a client user) says so instead of
 * showing the label it was drawn with, which is that entry's name.
 *
 * asset:read, as for the network entry itself; RLS scopes every row through it.
 */

interface NodeRow {
  id: string;
  asset_node_id: string | null;
  visible: boolean;
  label: string;
  ip_address: string | null;
  subnet: string | null;
  device_type: string;
  pos_x: number | null;
  pos_y: number | null;
}

export const GET = tenantRoute(
  async ({ tx, params }) => {
    const networkId = params.networkId;
    if (!networkId || !z.guid().safeParse(networkId).success) {
      throw ApiError.invalid('networkId must be a UUID');
    }

    const [network] = await tx<{
      id: string; name: string; organization_id: string; site_id: string | null; site_name: string | null;
    }[]>`
      SELECT n.id, n.name, n.organization_id, n.site_id, s.name AS site_name
      FROM asset_node n LEFT JOIN site s ON s.id = n.site_id AND s.deleted_at IS NULL
      WHERE n.id = ${networkId}::uuid AND n.node_type = 'network'
    `;
    if (!network) throw ApiError.notFound('no such network');

    const [nodes, links, configurations] = await Promise.all([
      tx<NodeRow[]>`
        SELECT t.id, t.asset_node_id,
               (t.asset_node_id IS NULL OR a.id IS NOT NULL) AS visible,
               CASE WHEN t.asset_node_id IS NOT NULL AND a.id IS NULL THEN 'Restricted entry'
                    ELSE coalesce(a.name, t.label) END AS label,
               CASE WHEN t.asset_node_id IS NOT NULL AND a.id IS NULL THEN NULL
                    ELSE coalesce(host(d.primary_ip), t.ip_address) END AS ip_address,
               t.subnet, t.device_type::text AS device_type, t.pos_x, t.pos_y
        FROM topology_node t
        LEFT JOIN asset_node a ON a.id = t.asset_node_id
        LEFT JOIN device d ON d.id = a.id
        WHERE t.network_id = ${networkId}::uuid
        ORDER BY t.created_at
      `,
      tx<{ id: string; from_node_id: string; to_node_id: string; label: string | null }[]>`
        SELECT id, from_node_id, to_node_id, label
        FROM topology_link
        WHERE network_id = ${networkId}::uuid
        ORDER BY created_at
      `,
      tx<{ id: string; name: string; primary_ip: string | null; device_type: string; site_id: string | null }[]>`
        SELECT n.id, n.name, host(d.primary_ip) AS primary_ip, d.device_type::text AS device_type, n.site_id
        FROM asset_node n JOIN device d ON d.id = n.id
        WHERE n.organization_id = ${network.organization_id}::uuid AND n.archived_at IS NULL
        ORDER BY lower(n.name)
        LIMIT 500
      `,
    ]);

    return {
      network: { id: network.id, name: network.name, siteId: network.site_id, siteName: network.site_name },
      nodes: nodes.map((n) => ({
        id: n.id,
        // Only for an entry the reader can open: the id of one they cannot is
        // not theirs to have.
        assetNodeId: n.visible ? n.asset_node_id : null,
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
      configurations: configurations.map((c) => ({
        id: c.id,
        name: c.name,
        primaryIp: c.primary_ip,
        shape: shapeForDevice(c.device_type),
        siteId: c.site_id,
      })),
    };
  },
  { permissions: ['asset:read'] },
);

export const dynamic = 'force-dynamic';
