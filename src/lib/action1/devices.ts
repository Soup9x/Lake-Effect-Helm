/**
 * An Action1 endpoint, as Helm records it.
 *
 * Pure, so every rule is a unit test rather than a sync run: which type an
 * endpoint becomes, how "32Gb DDR4" becomes 32, how Action1's
 * 2022-08-29_12-22-11 timestamps are read.
 */
import { createHash } from 'node:crypto';
import type { DEVICE_TYPES } from '@/lib/assets/detail-fields';
import { PLACEHOLDER_SERIAL, primaryIpFor, primaryMacFor } from '@/lib/ninja/devices';
import type { Action1Endpoint } from './client';

export type DeviceType = (typeof DEVICE_TYPES)[number];

export interface MappedEndpoint {
  externalId: string;
  action1OrgId: string | null;
  /** Used once, when the configuration is created. Never updated after. */
  name: string;
  /** Likewise: a person may reclassify a machine, and a sync must not undo it. */
  deviceType: DeviceType;
  /** Device columns Action1 reported. Absent means "not reported", never "clear it". */
  values: Record<string, string | number>;
  /** Of `values` without the check-in time, so an unchanged machine costs no writes. */
  sha256: Buffer;
}

function text(value: unknown, max = 500): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

function count(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Action1 writes times as YYYY-MM-DD_HH-mm-ss, in UTC. An ISO string is read
 * too, in case an answer uses one.
 */
export function action1Time(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (m) {
    const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    return Number.isNaN(ms) || ms <= 0 ? null : new Date(ms).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value.trim()) && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

/** "32Gb DDR4", "16 GB", "8192 MB" → gigabytes, to two decimal places. */
export function memoryGbFrom(value: unknown): number | null {
  const raw = text(value, 100);
  if (!raw) return null;
  // A number with a unit wherever it is ("DDR4 32 GB"), else a bare number.
  const m = /(\d+(?:[.,]\d+)?)\s*(tb|gb|g|mb|m)\b/i.exec(raw) ?? /^(\d+(?:[.,]\d+)?)$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]!.replace(',', '.'));
  const unit = (m[2] ?? 'gb').toLowerCase();
  const gb = unit.startsWith('t') ? n * 1024 : unit.startsWith('m') ? n / 1024 : n;
  const rounded = Math.round(gb * 100) / 100;
  return rounded > 0 && rounded < 1_000_000 ? rounded : null;
}

/** "Windows 11 (24H2)" → the system and its release. */
export function splitOs(value: unknown): { name: string | null; version: string | null } {
  const raw = text(value, 200);
  if (!raw) return { name: null, version: null };
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(raw);
  return m?.[1] ? { name: m[1], version: m[2]!.trim() } : { name: raw, version: null };
}

/** Makers whose name says the machine is a guest, whatever runs in it. */
const VIRTUAL_MAKER = /vmware|qemu|xen|innotek|virtualbox|parallels|proxmox|nutanix|red hat|bochs|amazon ec2|google/i;

/**
 * Action1 has no device class, so the type is read from what it does say. A
 * server OS is a server; a virtual maker is a VM; Linux is most often a server
 * where an MSP patches it; everything else is a workstation. It is only the
 * starting point: a person retypes a machine and the sync never undoes it.
 */
export function deviceTypeFor(endpoint: Pick<Action1Endpoint, 'OS' | 'platform' | 'manufacturer'>): DeviceType {
  if (VIRTUAL_MAKER.test(endpoint.manufacturer ?? '')) return 'virtual_machine';
  if (/server/i.test(endpoint.OS ?? '')) return 'server';
  if (/linux/i.test(endpoint.platform ?? '')) return 'server';
  return 'workstation';
}

export function serialFor(endpoint: Pick<Action1Endpoint, 'serial'>): string | null {
  const value = text(endpoint.serial, 200);
  return value && !PLACEHOLDER_SERIAL.test(value) ? value : null;
}

/** Action1 gives one address field; it may hold several, separated. */
const list = (value: unknown) => (typeof value === 'string' ? value.split(/[\s,;]+/).filter(Boolean) : []);

export function mapEndpoint(endpoint: Action1Endpoint): MappedEndpoint {
  const values: Record<string, string | number> = {};
  const put = (key: string, value: string | number | null) => {
    if (value !== null) values[key] = value;
  };

  put('hostname', text(endpoint.device_name, 253) ?? text(endpoint.name, 253));
  const os = splitOs(endpoint.OS);
  put('operating_system', os.name);
  put('os_version', os.version);
  put('manufacturer', text(endpoint.manufacturer, 200));
  put('serial_number', serialFor(endpoint));
  put('cpu', text(endpoint.CPU_name, 200));
  put('memory_gb', memoryGbFrom(endpoint.RAM));
  put('primary_ip', primaryIpFor(list(endpoint.address)));
  put('primary_mac', primaryMacFor(list(endpoint.MAC)));

  // The hash leaves the check-in time out, so it is computed before adding it.
  const sha256 = createHash('sha256')
    .update(JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k]])))
    .digest();

  put('last_seen_at', action1Time(endpoint.last_seen));

  return {
    externalId: String(endpoint.id),
    action1OrgId: text(endpoint.organization_id, 100),
    name: text(endpoint.name, 200) ?? text(endpoint.device_name, 200) ?? `Action1 endpoint ${endpoint.id}`,
    deviceType: deviceTypeFor(endpoint),
    values,
    sha256,
  };
}

/**
 * What Action1 says about a machine beyond the device's own columns, shown on
 * it as a read-only "From Action1" card and rewritten every run.
 *
 * Every field is optional. `missingUpdates` is absent, rather than zero, when
 * Action1 gave no counts, so the card can tell "none" from "not known".
 */
export interface Action1Profile {
  /** For the link back to Action1, which is per organization. */
  orgId?: string;
  /** Connected, Disconnected or Pending Uninstall. */
  agentStatus?: string;
  /** SUCCESS within 7 days, WARNING 8 to 30, ERROR longer ago. */
  onlineStatus?: string;
  lastLoggedInUser?: string;
  lastBootAt?: string;
  needsReboot?: boolean;
  publicIp?: string;
  platform?: string;
  architecture?: string;
  processor?: string;
  disk?: string;
  adOrganizationUnit?: string;
  agentVersion?: string;
  missingUpdates?: { critical: number; other: number };
  /** SUCCESS, WARNING or ERROR, as Action1 colours them. */
  vulnerabilityStatus?: string;
}

const STATUS = /^(SUCCESS|WARNING|ERROR)$/;

export function mapProfile(endpoint: Action1Endpoint): Action1Profile {
  const profile: Action1Profile = {};
  const set = <K extends keyof Action1Profile>(key: K, value: Action1Profile[K] | null | undefined) => {
    if (value !== null && value !== undefined) profile[key] = value;
  };

  set('orgId', text(endpoint.organization_id, 100));
  set('agentStatus', text(endpoint.status, 40));
  const online = text(endpoint.online_status, 20)?.toUpperCase();
  if (online && STATUS.test(online)) profile.onlineStatus = online;
  set('lastLoggedInUser', text(endpoint.user, 200));
  set('lastBootAt', action1Time(endpoint.last_boot_time));
  const reboot = text(endpoint.reboot_required, 10)?.toLowerCase();
  if (reboot === 'yes' || reboot === 'no') profile.needsReboot = reboot === 'yes';
  set('publicIp', primaryIpFor(list(endpoint.external_address)));
  set('platform', text(endpoint.platform, 40));
  set('architecture', text(endpoint.architecture, 40));
  set('processor', text(endpoint.CPU_size, 200));
  set('disk', text(endpoint.disk, 300));
  set('adOrganizationUnit', text(endpoint.AD_organization_unit, 300));
  set('agentVersion', text(endpoint.agent_version, 40));

  const critical = count(endpoint.missing_updates?.critical ?? endpoint.missing_critical_updates);
  const other = count(endpoint.missing_updates?.other ?? endpoint.missing_other_updates);
  if (critical !== null || other !== null) profile.missingUpdates = { critical: critical ?? 0, other: other ?? 0 };

  const vuln = text(endpoint.vulnerability_status, 20)?.toUpperCase();
  if (vuln && STATUS.test(vuln)) profile.vulnerabilityStatus = vuln;

  return profile;
}
