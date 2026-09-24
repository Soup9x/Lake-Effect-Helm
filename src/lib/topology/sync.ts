/**
 * Seeding a site's topology from what the UniFi poll already found.
 *
 * This runs INSIDE the existing poll rather than as a job of its own, and that
 * is a deliberate choice twice over. A diagram that refreshed on a different
 * schedule from the inventory it draws would show devices the inventory has
 * already forgotten; and a second job means a second advisory lock key, which
 * is a mistake this codebase has already made once (see src/workers/jobs.ts).
 *
 * WHAT IT WILL NOT DO, which is the whole contract:
 *
 *   It never moves a box. It never overwrites a label, device type, IP or
 *   subnet a person has edited. Those guarantees are not implemented here —
 *   they are in helm.upsert_topology_node's update list, asserted by 0570, so
 *   that they hold for any caller rather than for this one. This module's job
 *   is to decide WHAT to tell the database, not whether the database should
 *   believe it.
 *
 * ONLY DEVICES THE CONTROLLER STILL REPORTS are seeded, which is what makes
 * deleting a synced box meaningful. `finish_unifi_poll` flips anything it did
 * not see to is_online = false; this reads only the online ones, so a device
 * that is genuinely gone stays gone from the diagram, while one that is merely
 * unplugged for an afternoon comes back. That asymmetry is intentional and the
 * interface says so.
 */
import type { HelmTx } from '../db/client';
import { dataKeyById } from '../secrets/keys';
import { getKekProvider } from '../services';
import { openAssetField } from '../unifi/fields';
import { wipe } from '../crypto/envelope';

/** The icons 0570's enum offers. */
export type TopologyDeviceType =
  | 'switch' | 'router' | 'firewall' | 'server' | 'access_point' | 'generic';

interface DeviceRow {
  id: string;
  mac_blind_index: Buffer;
  uplink_mac_blind_index: Buffer | null;
  switch_port: number | null;
  model: string | null;
  asset_type: string;
  data_key_id: string;
  hostname_enc: Buffer | null;
  ip_address_enc: Buffer | null;
}

export interface TopologySeedResult {
  /** Null when the mapping is not bound to a site, which is the default. */
  readonly siteId: string | null;
  readonly nodes: number;
  readonly links: number;
}

/**
 * UniFi model prefix to icon.
 *
 * Best effort and openly so: this decides which glyph to draw, not what the
 * device is. The asset record holds the truth, a person can override the
 * choice, and 'generic' is a perfectly good answer for hardware nobody
 * recognised. Being wrong here costs an icon.
 */
export function deviceTypeFor(model: string | null, assetType: string): TopologyDeviceType {
  if (assetType !== 'unifi_device') return 'generic';

  const m = (model ?? '').toUpperCase();
  // UDM / UXG / UGW are gateways: they route and they firewall. Firewall is the
  // more useful thing to see on a diagram, since the router role is implied by
  // everything hanging off it.
  if (/^(UDM|UXG|UGW|USG)/.test(m)) return 'firewall';
  if (/^(USW|US\d|USL|USF)/.test(m)) return 'switch';
  if (/^(UAP|U6|U7|UWB|UHD|ULR)/.test(m)) return 'access_point';
  if (/^(UNVR|UCK|UNAS)/.test(m)) return 'server';
  return 'generic';
}

/**
 * Seed and refresh one mapping's topology.
 *
 * Returns `siteId: null` and does nothing when the mapping is not bound to a
 * site — which is the default, and is exactly the "site with no UniFi mapping
 * starts empty" case seen from the other end.
 */
export async function seedTopologyFromPoll(
  tx: HelmTx,
  tenantId: string,
  mappingId: string,
): Promise<TopologySeedResult> {
  const [mapping] = await tx<{ site_id: string | null }[]>`
    SELECT site_id FROM unifi_site_mapping WHERE id = ${mappingId}::uuid
  `;
  const siteId = mapping?.site_id ?? null;
  if (!siteId) return { siteId: null, nodes: 0, links: 0 };

  const devices = await tx<DeviceRow[]>`
    SELECT id, mac_blind_index, uplink_mac_blind_index, switch_port,
           model, asset_type::text AS asset_type, data_key_id,
           hostname_enc, ip_address_enc
    FROM network_assets
    WHERE mapping_id = ${mappingId}::uuid AND is_online
  `;
  if (devices.length === 0) return { siteId, nodes: 0, links: 0 };

  /*
   * One unwrap per data key, not per device.
   *
   * Rows can name different keys after a rotation — dataKeyById exists so a
   * retiring key still opens what it sealed — but a poll of two hundred access
   * points should not be two hundred KEK calls.
   */
  const deks = new Map<string, Buffer>();
  const dekFor = async (dataKeyId: string): Promise<Buffer | null> => {
    const cached = deks.get(dataKeyId);
    if (cached) return cached;
    const key = await dataKeyById(tx, dataKeyId);
    if (!key) return null;
    const dek = await getKekProvider().unwrapDek(key.wrappedDek, key.kekId, key.wrapContext);
    deks.set(dataKeyId, dek);
    return dek;
  };

  try {
    /** mac_blind_index (hex) -> topology_node.id, so uplinks can be resolved. */
    const nodeByMac = new Map<string, string>();
    let nodes = 0;

    for (const device of devices) {
      const dek = await dekFor(device.data_key_id);

      // A row whose key is gone is not a reason to abandon the diagram. It
      // draws under its model name until the key situation is sorted out.
      const hostname = dek
        ? openAssetField(dek, tenantId, device.id, 'hostname', device.hostname_enc)
        : null;
      const ip = dek
        ? openAssetField(dek, tenantId, device.id, 'ip_address', device.ip_address_enc)
        : null;

      const label = hostname ?? device.model ?? 'Unknown device';

      const [row] = await tx<{ node_id: string }[]>`
        SELECT node_id FROM helm.upsert_topology_node(
          ${siteId}::uuid,
          ${device.mac_blind_index},
          ${label},
          ${ip},
          ${null},
          ${deviceTypeFor(device.model, device.asset_type)}::topology_device_type,
          ${null}::uuid)
      `;
      if (!row) continue;

      nodeByMac.set(device.mac_blind_index.toString('hex'), row.node_id);
      nodes += 1;
    }

    /*
     * Links, once every node exists.
     *
     * Two passes rather than one: a device's uplink is frequently polled in the
     * same batch as the device, and resolving it mid-loop would depend on which
     * order the controller happened to list them in.
     *
     * An uplink pointing at a device this site has never seen is skipped, not
     * invented. A line to a box that is not on the drawing is not a line.
     */
    let links = 0;
    for (const device of devices) {
      if (!device.uplink_mac_blind_index) continue;

      const from = nodeByMac.get(device.mac_blind_index.toString('hex'));
      const to = nodeByMac.get(device.uplink_mac_blind_index.toString('hex'));
      if (!from || !to || from === to) continue;

      const label = device.switch_port === null ? null : `Port ${device.switch_port}`;
      const [row] = await tx<{ upsert_topology_link: string | null }[]>`
        SELECT helm.upsert_topology_link(
          ${siteId}::uuid, ${from}::uuid, ${to}::uuid, ${label})
      `;
      if (row?.upsert_topology_link) links += 1;
    }

    return { siteId, nodes, links };
  } finally {
    wipe(...deks.values());
  }
}
