/**
 * A NinjaOne device, as Helm records it.
 *
 * Pure, so every rule here is a unit test rather than a sync run: which type a
 * node class becomes, which address is the primary one, which serial numbers
 * are placeholders a manufacturer never filled in.
 */
import { createHash } from 'node:crypto';
import type { DEVICE_TYPES } from '@/lib/assets/detail-fields';
import type { NinjaDevice } from './client';

export type DeviceType = (typeof DEVICE_TYPES)[number];

export interface MappedDevice {
  externalId: string;
  ninjaOrgId: string | null;
  /** Used once, when the configuration is created. Never updated after. */
  name: string;
  /** Likewise: a person may reclassify a machine, and a sync must not undo it. */
  deviceType: DeviceType;
  /** Device columns NinjaOne reported. Absent means "not reported", never "clear it". */
  values: Record<string, string | number>;
  /** Of `values` without the check-in time, so an unchanged machine costs no writes. */
  sha256: Buffer;
}

/**
 * NinjaOne's node classes, as Helm device types.
 *
 * Anything not listed is "other" rather than a guess. A workstation reporting a
 * laptop chassis is a laptop; a guest VM is a virtual machine whatever its OS.
 */
const NODE_CLASS: Record<string, DeviceType> = {
  WINDOWS_SERVER: 'server',
  LINUX_SERVER: 'server',
  MAC_SERVER: 'server',
  WINDOWS_WORKSTATION: 'workstation',
  LINUX_WORKSTATION: 'workstation',
  MAC: 'workstation',
  VMWARE_VM_HOST: 'hypervisor',
  HYPERV_VMM_HOST: 'hypervisor',
  PROXMOX_HOST: 'hypervisor',
  VMWARE_VM_GUEST: 'virtual_machine',
  HYPERV_VMM_GUEST: 'virtual_machine',
  PROXMOX_GUEST: 'virtual_machine',
  NMS_SWITCH: 'switch',
  NMS_ROUTER: 'router',
  NMS_FIREWALL: 'firewall',
  NMS_WAP: 'access_point',
  NMS_PRINTER: 'printer',
  NMS_NAS: 'nas',
  NMS_SAN: 'san',
  NMS_UPS: 'ups',
  NMS_CAMERA: 'camera',
  NMS_PHONE: 'phone_system',
  NMS_IOT: 'iot',
};

export function deviceTypeFor(device: Pick<NinjaDevice, 'nodeClass' | 'system'>): DeviceType {
  const mapped = NODE_CLASS[(device.nodeClass ?? '').toUpperCase()] ?? 'other';
  if (mapped === 'workstation' && /laptop|notebook|portable/i.test(device.system?.chassisType ?? '')) {
    return 'laptop';
  }
  return mapped;
}

/** Serial numbers that mean "the manufacturer did not set one". */
const PLACEHOLDER_SERIAL = /^(0+|none|n\/?a|default string|to be filled by o\.?e\.?m\.?|system serial number|chassis serial number|123456789|not specified|invalid)$/i;

export function serialFor(device: Pick<NinjaDevice, 'system'>): string | null {
  for (const raw of [device.system?.serialNumber, device.system?.biosSerialNumber]) {
    const value = text(raw);
    if (value && !PLACEHOLDER_SERIAL.test(value)) return value;
  }
  return null;
}

/**
 * The address worth calling primary: the first IPv4 that is not loopback or
 * link-local, else the first usable IPv6, else nothing.
 */
export function primaryIpFor(addresses: unknown): string | null {
  if (!Array.isArray(addresses)) return null;
  const candidates = addresses.filter((a): a is string => typeof a === 'string').map((a) => a.trim());
  const v4 = candidates.find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)
    && a.split('.').every((o) => Number(o) <= 255)
    && !a.startsWith('127.') && !a.startsWith('169.254.') && a !== '0.0.0.0');
  if (v4) return v4;
  const v6 = candidates.find((a) => a.includes(':') && /^[0-9a-f:.]+$/i.test(a)
    && !/^fe80:/i.test(a) && a !== '::1' && a !== '::');
  return v6 ?? null;
}

/** aa:bb:cc:dd:ee:ff, from any of the spellings NinjaOne and agents use. */
export function primaryMacFor(addresses: unknown): string | null {
  if (!Array.isArray(addresses)) return null;
  for (const raw of addresses) {
    if (typeof raw !== 'string') continue;
    const hex = raw.replace(/[^0-9a-f]/gi, '').toLowerCase();
    if (hex.length !== 12 || /^0+$/.test(hex) || /^f+$/.test(hex)) continue;
    return hex.match(/../g)!.join(':');
  }
  return null;
}

function text(value: unknown, max = 500): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

export function mapDevice(device: NinjaDevice): MappedDevice {
  const values: Record<string, string | number> = {};
  const put = (key: string, value: string | number | null) => {
    if (value !== null) values[key] = value;
  };

  put('hostname', text(device.systemName, 253));
  put('fqdn', text(device.dnsName, 253));
  put('operating_system', text(device.os?.name, 200));
  const build = text(device.os?.buildNumber, 60);
  const release = text(device.os?.releaseId, 60);
  put('os_version', release && build ? `${release} (${build})` : release ?? build);
  put('manufacturer', text(device.system?.manufacturer, 200));
  put('model', text(device.system?.model, 200));
  put('serial_number', serialFor(device));
  put('cpu', text(device.processors?.[0]?.name, 200));
  const bytes = device.memory?.capacity;
  if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0) {
    // Two decimal places, which is what the column holds.
    put('memory_gb', Math.round((bytes / 1024 ** 3) * 100) / 100 || null);
  }
  put('primary_ip', primaryIpFor(device.ipAddresses));
  put('primary_mac', primaryMacFor(device.macAddresses));
  put('rmm_device_id', String(device.id));

  // The hash leaves the check-in time out, so it is computed before adding it.
  const sha256 = createHash('sha256')
    .update(JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k]])))
    .digest();

  if (typeof device.lastContact === 'number' && Number.isFinite(device.lastContact) && device.lastContact > 0) {
    // Seconds since the epoch, sometimes with a fraction.
    put('last_seen_at', new Date(Math.round(device.lastContact * 1000)).toISOString());
  }

  const name = text(device.displayName, 200) ?? text(device.systemName, 200) ?? text(device.dnsName, 200)
    ?? `NinjaOne device ${device.id}`;

  return {
    externalId: String(device.id),
    ninjaOrgId: device.organizationId === undefined || device.organizationId === null ? null : String(device.organizationId),
    name,
    deviceType: deviceTypeFor(device),
    values,
    sha256,
  };
}
