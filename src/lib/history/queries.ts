/**
 * An entry's change history (0970), as the History card reads it.
 *
 * Read under RLS: the rows carry the entry's client and internal-only flag, so
 * whoever can read the entry can read its history and nobody else can. Ids in
 * the recorded values — a location, a contact, a linked entry — are turned into
 * names here, at read time, so a renamed location reads as its current name.
 */
import type { HelmTx } from '../db/client';
import { humanise } from '../ui/format';

export type HistoryEntity = 'asset' | 'contact' | 'site';

export interface FieldChange {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
}

export interface HistoryEntry {
  id: string;
  kind: 'created' | 'updated' | 'archived' | 'restored';
  changedAt: string;
  actor: string;
  changes: FieldChange[];
}

/** Columns whose name says less than the label people know them by. */
const LABELS: Record<string, string> = {
  site_id: 'Location',
  contact_id: 'Contact',
  primary_network_id: 'Network',
  parent_device_id: 'Parent device',
  primary_ip: 'Primary IP',
  primary_mac: 'MAC address',
  os_version: 'OS version',
  operating_system: 'Operating system',
  is_internal_only: 'Internal only',
  fqdn: 'FQDN',
  cidr: 'CIDR',
  vlan_id: 'VLAN',
  ssid: 'SSID',
  url: 'URL',
  admin_url: 'Admin URL',
  management_url: 'Management URL',
  first_name: 'First name',
  last_name: 'Last name',
  address_line1: 'Street',
  address_line2: 'Suite, floor, building',
  public_ips: 'Public IPs',
  rmm_device_id: 'RMM device',
  is_primary: 'Primary',
  is_technical: 'Technical contact',
  is_billing: 'Billing contact',
  is_emergency: 'Emergency contact',
  is_authorised: 'May authorise changes',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function labelFor(field: string): string {
  if (field.startsWith('data.')) return humanise(field.slice(5));
  return LABELS[field] ?? humanise(field.replace(/_id$/, ''));
}

function display(value: unknown, names: Map<string, string>): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length === 0 ? null : value.map((v) => display(v, names)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  if (UUID.test(text)) return names.get(text.toLowerCase()) ?? 'an entry you cannot see';
  return text;
}

interface Row {
  id: string;
  kind: HistoryEntry['kind'];
  changed_at: Date;
  actor: string | null;
  actor_type: string | null;
  changes: Record<string, [unknown, unknown]>;
}

export async function listHistory(
  tx: HelmTx, entity: HistoryEntity, entityId: string, limit = 100,
): Promise<HistoryEntry[]> {
  const rows = await tx<Row[]>`
    SELECT c.id::text, c.kind, c.changed_at, c.changes, c.actor_type,
           coalesce(u.name, u.email::text) AS actor
    FROM entity_change c
    LEFT JOIN app_user u ON u.id = c.actor_id
    WHERE c.entity_type = ${entity} AND c.entity_id = ${entityId}::uuid
    ORDER BY c.changed_at DESC, c.id DESC
    LIMIT ${limit}
  `;

  // Every id mentioned anywhere, named in one query, under RLS.
  const ids = new Set<string>();
  for (const row of rows) {
    for (const pair of Object.values(row.changes)) {
      for (const v of pair) if (typeof v === 'string' && UUID.test(v)) ids.add(v.toLowerCase());
    }
  }
  const names = new Map<string, string>();
  if (ids.size > 0) {
    const list = [...ids];
    const named = await tx<{ id: string; name: string }[]>`
      SELECT id::text, name FROM asset_node WHERE id = ANY (${list}::uuid[])
      UNION ALL SELECT id::text, name FROM site WHERE id = ANY (${list}::uuid[])
      UNION ALL SELECT id::text, first_name || ' ' || last_name FROM contact WHERE id = ANY (${list}::uuid[])
    `;
    for (const n of named) names.set(n.id, n.name);
  }

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    changedAt: row.changed_at.toISOString(),
    actor: row.actor ?? (row.actor_type && row.actor_type !== 'user' ? 'An automatic sync' : 'Helm'),
    changes: Object.entries(row.changes)
      .map(([field, [before, after]]) => ({
        field, label: labelFor(field), before: display(before, names), after: display(after, names),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  }));
}
