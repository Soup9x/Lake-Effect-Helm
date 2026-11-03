/**
 * The reads behind Field view (1250). Every one runs under RLS in the caller's
 * session context, so a phone sees exactly what the full site would show the
 * same person — Field view narrows what is ASKED, never what is allowed.
 *
 * No secret material is read here. Passwords reach the screen only through
 * the audited reveal routes, from RevealButton, as on the full site.
 */
import type { HelmTx } from '../db/client';

export interface FieldClient {
  id: string;
  name: string;
}

export async function listFieldClients(tx: HelmTx): Promise<FieldClient[]> {
  return tx<FieldClient[]>`
    SELECT id, name FROM organization
    WHERE archived_at IS NULL AND deleted_at IS NULL
    ORDER BY lower(name)
  `;
}

export interface FieldClientHeader {
  id: string;
  name: string;
  address: string | null;
  mainPhone: string | null;
  contactName: string | null;
  contactPhone: string | null;
}

export async function readFieldClient(tx: HelmTx, organizationId: string): Promise<FieldClientHeader | null> {
  const [org] = await tx<{ id: string; name: string }[]>`
    SELECT id, name FROM organization
    WHERE id = ${organizationId}::uuid AND archived_at IS NULL AND deleted_at IS NULL
  `;
  if (!org) return null;
  const [site] = await tx<{ address: string | null; main_phone: string | null }[]>`
    SELECT nullif(concat_ws(', ', nullif(address_line1, ''), nullif(city, ''), nullif(region, '')), '') AS address,
           main_phone
    FROM site
    WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL AND archived_at IS NULL
    ORDER BY is_primary DESC, name
    LIMIT 1
  `;
  const [contact] = await tx<{ name: string; phone: string | null }[]>`
    SELECT concat_ws(' ', first_name, last_name) AS name, coalesce(mobile, phone) AS phone
    FROM contact
    WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL AND archived_at IS NULL
    ORDER BY is_primary DESC, is_technical DESC, is_emergency DESC, last_name, first_name
    LIMIT 1
  `;
  return {
    id: org.id,
    name: org.name,
    address: site?.address ?? null,
    mainPhone: site?.main_phone ?? null,
    contactName: contact?.name ?? null,
    contactPhone: contact?.phone ?? null,
  };
}

export interface FieldLogin {
  id: string;
  name: string;
  username: string | null;
  url: string | null;
  sensitivity: string | null;
  siteName: string | null;
}

export async function listFieldLogins(tx: HelmTx, organizationId: string): Promise<FieldLogin[]> {
  return tx<FieldLogin[]>`
    SELECT n.id, n.name, c.username, c.url, m.sensitivity::text AS sensitivity, s.name AS "siteName"
    FROM asset_node n
    JOIN credential c ON c.id = n.id
    LEFT JOIN v_secret_metadata m ON m.id = c.secret_id
    LEFT JOIN site s ON s.id = n.site_id
    WHERE n.organization_id = ${organizationId}::uuid
      AND n.node_type = 'credential' AND n.archived_at IS NULL
    ORDER BY lower(n.name)
  `;
}

export interface FieldDevice {
  id: string;
  name: string;
  deviceType: string | null;
  hostname: string | null;
  primaryIp: string | null;
  siteName: string | null;
}

export async function listFieldDevices(tx: HelmTx, organizationId: string): Promise<FieldDevice[]> {
  return tx<FieldDevice[]>`
    SELECT n.id, n.name, d.device_type::text AS "deviceType", d.hostname,
           host(d.primary_ip) AS "primaryIp", s.name AS "siteName"
    FROM asset_node n
    JOIN device d ON d.id = n.id
    LEFT JOIN site s ON s.id = n.site_id
    WHERE n.organization_id = ${organizationId}::uuid
      AND n.node_type = 'device' AND n.archived_at IS NULL
    ORDER BY lower(n.name)
  `;
}

export interface FieldContact {
  id: string;
  name: string;
  title: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
}

export async function listFieldContacts(tx: HelmTx, organizationId: string): Promise<FieldContact[]> {
  return tx<FieldContact[]>`
    SELECT id, concat_ws(' ', first_name, last_name) AS name, title, phone, mobile, email::text AS email
    FROM contact
    WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL AND archived_at IS NULL
    ORDER BY is_primary DESC, lower(last_name), lower(first_name)
  `;
}

export interface FieldLocation {
  id: string;
  name: string;
  address: string | null;
  mainPhone: string | null;
  afterHoursPhone: string | null;
  accessNotes: string | null;
}

export async function listFieldLocations(tx: HelmTx, organizationId: string): Promise<FieldLocation[]> {
  return tx<FieldLocation[]>`
    SELECT id, name,
           nullif(concat_ws(', ', nullif(address_line1, ''), nullif(address_line2, ''), nullif(city, ''),
                            nullif(region, ''), nullif(postal_code, '')), '') AS address,
           main_phone AS "mainPhone", after_hours_phone AS "afterHoursPhone", access_notes AS "accessNotes"
    FROM site
    WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL AND archived_at IS NULL
    ORDER BY is_primary DESC, lower(name)
  `;
}

export interface FieldCredential {
  id: string;
  name: string;
  notes: string | null;
  organizationId: string;
  organizationName: string;
  siteName: string | null;
  username: string | null;
  url: string | null;
  hasTotp: boolean;
  secret: {
    id: string;
    sensitivity: string;
    requiresReason: boolean;
    requiresStepUp: boolean;
  } | null;
  canReveal: boolean;
}

export async function readFieldCredential(tx: HelmTx, nodeId: string): Promise<FieldCredential | null> {
  const [row] = await tx<{
    id: string; name: string; notes: string | null; organization_id: string; organization_name: string;
    site_name: string | null; username: string | null; url: string | null; totp_secret_id: string | null;
    secret_id: string | null; sensitivity: string | null; requires_reason: boolean | null;
    requires_step_up: boolean | null;
  }[]>`
    SELECT n.id, n.name, n.notes, n.organization_id, o.name AS organization_name, s.name AS site_name,
           c.username, c.url, c.totp_secret_id,
           m.id AS secret_id, m.sensitivity::text AS sensitivity, m.requires_reason, m.requires_step_up
    FROM asset_node n
    JOIN credential c ON c.id = n.id
    JOIN organization o ON o.id = n.organization_id
    LEFT JOIN site s ON s.id = n.site_id
    LEFT JOIN v_secret_metadata m ON m.id = c.secret_id
    WHERE n.id = ${nodeId}::uuid AND n.archived_at IS NULL
  `;
  if (!row) return null;
  const [perm] = await tx<{ reveal: boolean }[]>`SELECT helm.has_permission('secret:reveal') AS reveal`;
  return {
    id: row.id,
    name: row.name,
    notes: row.notes,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    siteName: row.site_name,
    username: row.username,
    url: row.url,
    hasTotp: row.totp_secret_id !== null,
    secret: row.secret_id
      ? {
          id: row.secret_id,
          sensitivity: row.sensitivity ?? 'standard',
          requiresReason: row.requires_reason ?? false,
          requiresStepUp: row.requires_step_up ?? false,
        }
      : null,
    canReveal: perm?.reveal ?? false,
  };
}

export interface FieldDeviceDetail {
  id: string;
  name: string;
  nodeType: string;
  notes: string | null;
  organizationId: string;
  organizationName: string;
  siteName: string | null;
  fields: { label: string; value: string }[];
  logins: { id: string; name: string }[];
}

const DEVICE_FIELDS: readonly [column: string, label: string][] = [
  ['device_type', 'Type'],
  ['hostname', 'Hostname'],
  ['fqdn', 'FQDN'],
  ['primary_ip', 'IP address'],
  ['default_gateway', 'Gateway'],
  ['management_url', 'Management'],
  ['manufacturer', 'Manufacturer'],
  ['model', 'Model'],
  ['serial_number', 'Serial number'],
  ['asset_tag', 'Asset tag'],
  ['operating_system', 'Operating system'],
  ['os_version', 'OS version'],
  ['physical_position', 'Position'],
  ['warranty_expires_at', 'Warranty until'],
];

export async function readFieldDevice(tx: HelmTx, nodeId: string): Promise<FieldDeviceDetail | null> {
  const [row] = await tx<{
    id: string; name: string; node_type: string; notes: string | null; organization_id: string;
    organization_name: string; site_name: string | null; detail: Record<string, unknown> | null;
  }[]>`
    SELECT n.id, n.name, n.node_type::text, n.notes, n.organization_id, o.name AS organization_name, s.name AS site_name,
           jsonb_build_object(
             'device_type', d.device_type::text, 'hostname', d.hostname, 'fqdn', d.fqdn,
             'primary_ip', host(d.primary_ip), 'default_gateway', host(d.default_gateway),
             'management_url', d.management_url, 'manufacturer', d.manufacturer, 'model', d.model,
             'serial_number', d.serial_number, 'asset_tag', d.asset_tag,
             'operating_system', d.operating_system, 'os_version', d.os_version,
             'physical_position', d.physical_position,
             'warranty_expires_at', to_char(d.warranty_expires_at, 'YYYY-MM-DD')) AS detail
    FROM asset_node n
    LEFT JOIN device d ON d.id = n.id
    JOIN organization o ON o.id = n.organization_id
    LEFT JOIN site s ON s.id = n.site_id
    WHERE n.id = ${nodeId}::uuid AND n.archived_at IS NULL
  `;
  if (!row) return null;
  // Credentials linked to this device, either way round, for the way to its login.
  const logins = await tx<{ id: string; name: string }[]>`
    SELECT DISTINCT other.id, other.name
    FROM v_asset_edge e
    JOIN asset_node other ON other.id = e.to_node_id
    WHERE e.from_node_id = ${nodeId}::uuid AND other.node_type = 'credential' AND other.archived_at IS NULL
    ORDER BY other.name
  `;
  const detail = row.detail ?? {};
  return {
    id: row.id,
    name: row.name,
    nodeType: row.node_type,
    notes: row.notes,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    siteName: row.site_name,
    fields: DEVICE_FIELDS.flatMap(([column, label]) => {
      const value = detail[column];
      return value === null || value === undefined || value === '' ? [] : [{ label, value: String(value) }];
    }),
    logins,
  };
}

/**
 * Where a search result or a recently viewed record goes in Field view. A kind
 * Field view has no page for opens the client it belongs to, on the tab that
 * lists it.
 */
export function fieldHref(hit: {
  kind: string;
  organizationId: string | null;
  nodeId?: string | null;
  entityId?: string;
  nodeType?: string | null;
}): string {
  const org = hit.organizationId;
  switch (hit.kind) {
    case 'client':
      return `/m/c/${org ?? hit.entityId}`;
    case 'credential':
      return hit.nodeId ? `/m/s/${hit.nodeId}` : `/m/c/${org}?tab=logins`;
    case 'asset':
      if (hit.nodeType === 'credential' && hit.nodeId) return `/m/s/${hit.nodeId}`;
      return hit.nodeId ? `/m/a/${hit.nodeId}` : `/m/c/${org}`;
    case 'contact':
      return `/m/c/${org}?tab=contacts`;
    case 'site':
      return `/m/c/${org}?tab=locations`;
    default:
      return org ? `/m/c/${org}` : '/m';
  }
}
