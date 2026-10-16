/**
 * A configuration: the device, its node, its contact and its interfaces, read
 * and written as one thing (0800).
 *
 * The device columns themselves go through the detail catalogue and
 * lib/assets/detail-write, the same path the generic Edit details uses, so
 * the sectioned form cannot write a value the catalogue would refuse.
 * Interfaces are replaced whole, as a contact's numbers are: the form shows
 * the list and saves the list.
 */
import { z } from 'zod';
import type { HelmTx } from '../db/client';

export const interfaceSchema = z.object({
  name: z.string().trim().max(80).nullable().optional(),
  ipAddress: z.string().trim().max(64).nullable().optional(),
  macAddress: z.string().trim().max(32).nullable().optional(),
  port: z.string().trim().max(40).nullable().optional(),
  isPrimary: z.boolean().default(false),
  notes: z.string().trim().max(2000).nullable().optional(),
  connectedToNodeId: z.guid().nullable().optional(),
});
export type InterfaceInput = z.infer<typeof interfaceSchema>;

export interface InterfaceRow {
  id: string;
  name: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  port: string | null;
  isPrimary: boolean;
  notes: string | null;
  connectedToNodeId: string | null;
  connectedToName: string | null;
}

export async function listInterfaces(tx: HelmTx, deviceId: string): Promise<InterfaceRow[]> {
  const rows = await tx<{
    id: string; name: string | null; ip_address: string | null; mac_address: string | null;
    port: string | null; is_primary: boolean; notes: string | null;
    connected_to_node_id: string | null; connected_to_name: string | null;
  }[]>`
    SELECT i.id, i.name, host(i.ip_address) AS ip_address, i.mac_address::text AS mac_address,
           i.port, i.is_primary, i.notes, i.connected_to_node_id, n.name AS connected_to_name
    FROM device_interface i
    LEFT JOIN asset_node n ON n.id = i.connected_to_node_id
    WHERE i.device_id = ${deviceId}::uuid
    ORDER BY i.is_primary DESC, i.position, i.created_at
  `;
  return rows.map((r) => ({
    id: r.id, name: r.name, ipAddress: r.ip_address, macAddress: r.mac_address, port: r.port,
    isPrimary: r.is_primary, notes: r.notes, connectedToNodeId: r.connected_to_node_id,
    connectedToName: r.connected_to_name,
  }));
}

/** Replace the list. The first entry is primary when none is marked. */
export async function replaceInterfaces(
  tx: HelmTx,
  tenantId: string,
  deviceId: string,
  interfaces: InterfaceInput[],
): Promise<void> {
  const kept = interfaces.filter((i) => (i.name ?? '') !== '' || (i.ipAddress ?? '') !== '' || (i.macAddress ?? '') !== '');
  const primaryAt = kept.findIndex((i) => i.isPrimary);
  await tx`DELETE FROM device_interface WHERE device_id = ${deviceId}::uuid`;
  for (const [i, entry] of kept.entries()) {
    await tx`
      INSERT INTO device_interface (
        tenant_id, device_id, name, ip_address, mac_address, port, is_primary, notes, connected_to_node_id, position
      ) VALUES (
        ${tenantId}::uuid, ${deviceId}::uuid, ${entry.name || null},
        ${entry.ipAddress || null}::inet, ${entry.macAddress || null}::macaddr, ${entry.port || null},
        ${i === (primaryAt === -1 ? 0 : primaryAt)}, ${entry.notes || null},
        ${entry.connectedToNodeId ?? null}::uuid, ${i}
      )
    `;
  }
}

/** The contact a device names must be one of the same client's people. */
export async function contactBelongs(tx: HelmTx, contactId: string, organizationId: string): Promise<boolean> {
  const [row] = await tx<{ ok: boolean }[]>`
    SELECT true AS ok FROM contact
    WHERE id = ${contactId}::uuid AND organization_id = ${organizationId}::uuid AND deleted_at IS NULL
  `;
  return row !== undefined;
}

export interface DeviceView {
  id: string;
  organizationId: string;
  name: string;
  status: string;
  siteId: string | null;
  notes: string | null;
  contactId: string | null;
  detail: Record<string, unknown>;
  interfaces: InterfaceRow[];
}

export async function readDevice(tx: HelmTx, deviceId: string): Promise<DeviceView | null> {
  const [row] = await tx<{
    id: string; organization_id: string; name: string; status: string; site_id: string | null;
    notes: string | null; contact_id: string | null; detail: Record<string, unknown>;
  }[]>`
    SELECT n.id, n.organization_id, n.name, n.status::text, n.site_id, n.notes, d.contact_id,
           to_jsonb(d) - 'id' - 'tenant_id' - 'node_type' - 'contact_id' AS detail
    FROM asset_node n JOIN device d ON d.id = n.id
    WHERE n.id = ${deviceId}::uuid AND n.archived_at IS NULL
  `;
  if (!row) return null;
  return {
    id: row.id, organizationId: row.organization_id, name: row.name, status: row.status,
    siteId: row.site_id, notes: row.notes, contactId: row.contact_id, detail: row.detail,
    interfaces: await listInterfaces(tx, deviceId),
  };
}
