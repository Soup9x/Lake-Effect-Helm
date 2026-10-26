/**
 * Proxmox hosts and guests, as Helm records them (1110).
 *
 * Pure, so each rule is a unit test: how Proxmox's "key=value,key=value"
 * config strings read, which disk is a disk and which is a CD drive, what
 * "l26" and "win11" mean, which address is the primary one.
 */
import { createHash } from 'node:crypto';
import { primaryIpFor, primaryMacFor } from '../ninja/devices';
import type {
  AgentInterface, AgentOsInfo, LxcInterface, ProxmoxClusterEntry, ProxmoxConfig, ProxmoxNode,
  ProxmoxNodeStatus, ProxmoxResource, ProxmoxSnapshot,
} from './client';

export interface MappedMachine {
  kind: 'node' | 'guest';
  /** The node's name, or the guest's VMID. */
  externalId: string;
  /** Used once, when the configuration is created. */
  name: string;
  deviceType: 'hypervisor' | 'virtual_machine';
  /** Device columns Proxmox reported. Absent means not reported, never "clear it". */
  values: Record<string, string | number>;
  /** A guest's host, by node name. */
  hostExternalId: string | null;
  profile: ProxmoxProfile;
  /** Of values and host, so an unchanged machine costs no column writes. */
  sha256: Buffer;
}

export interface ProxmoxDisk { name: string; storage?: string; sizeGb?: number }
export interface ProxmoxNic { name: string; mac?: string; bridge?: string; vlan?: string; model?: string; addresses?: string[] }
export interface ProxmoxStorageRow { name: string; type?: string; totalGb: number; usedGb: number; shared: boolean }

export interface ProxmoxGuestProfile {
  kind: 'qemu' | 'lxc';
  vmid: number;
  node: string;
  status?: string;
  uptimeSeconds?: number;
  pool?: string;
  tags?: string[];
  haState?: string;
  onBoot?: boolean;
  /** QEMU only: whether the agent is enabled in the config, and whether it answered. */
  agent?: 'answered' | 'not_answering' | 'off';
  cpuType?: string;
  disks: ProxmoxDisk[];
  nics: ProxmoxNic[];
  /** Absent when Proxmox would not list them. */
  snapshots?: { count: number; latestName?: string; latestAt?: string };
  lastBackupAt?: string;
  notes?: string;
}

export interface ProxmoxNodeProfile {
  kind: 'node';
  node: string;
  cluster?: string;
  status?: string;
  uptimeSeconds?: number;
  pveVersion?: string;
  kernel?: string;
  bootMode?: string;
  cpu?: { sockets?: number; cores?: number; threads?: number };
  storage: ProxmoxStorageRow[];
  guests: { running: number; total: number };
}

export type ProxmoxProfile = ProxmoxGuestProfile | ProxmoxNodeProfile;

function text(value: unknown, max = 500): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

const num = (value: unknown): number | null => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 100) / 100;

/**
 * "virtio=BC:24:11:00:00:01,bridge=vmbr0,tag=20" as { virtio: ..., bridge:
 * ..., tag: ... }. A part with no "=" — the volume in "local-lvm:vm-100-disk-0,
 * size=32G" — is kept under ''.
 */
export function parsePveList(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== 'string') return out;
  for (const part of value.split(',')) {
    const at = part.indexOf('=');
    if (at < 0) {
      if (part.trim() && !('' in out)) out[''] = part.trim();
    } else {
      out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
    }
  }
  return out;
}

/** "32G", "512M", "1T" as GB. A bare number is bytes. */
export function sizeToGb(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2]!.toUpperCase();
  const factor = unit === 'T' ? 1024 : unit === 'G' ? 1 : unit === 'M' ? 1 / 1024 : unit === 'K' ? 1 / 1024 ** 2 : 1 / 1024 ** 3;
  return Math.round(n * factor * 100) / 100;
}

const NIC_MODELS = ['virtio', 'e1000', 'e1000e', 'rtl8139', 'vmxnet3', 'ne2k_pci', 'ne2k_isa', 'i82551', 'i82557b', 'i82559er', 'pcnet'];

/** A QEMU or LXC guest's NICs, from net0, net1, … in order. */
export function nicsFor(kind: 'qemu' | 'lxc', config: ProxmoxConfig): ProxmoxNic[] {
  return Object.keys(config)
    .filter((k) => /^net\d+$/.test(k))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
    .map((key) => {
      const parts = parsePveList(config[key]);
      const nic: ProxmoxNic = { name: key };
      if (kind === 'qemu') {
        const model = NIC_MODELS.find((m) => m in parts);
        if (model) {
          nic.model = model;
          const mac = primaryMacFor([parts[model]]);
          if (mac) nic.mac = mac;
        }
      } else {
        if (parts.name) nic.name = parts.name;
        const mac = primaryMacFor([parts.hwaddr]);
        if (mac) nic.mac = mac;
        const ip = parts.ip && parts.ip !== 'dhcp' && parts.ip !== 'manual' ? parts.ip.split('/')[0] : null;
        if (ip) nic.addresses = [ip];
      }
      if (parts.bridge) nic.bridge = parts.bridge;
      if (parts.tag) nic.vlan = parts.tag;
      return nic;
    });
}

/** Disks: not CD drives, not the EFI or TPM state volumes, not "none". */
export function disksFor(kind: 'qemu' | 'lxc', config: ProxmoxConfig): ProxmoxDisk[] {
  const pattern = kind === 'qemu' ? /^(scsi|sata|ide|virtio)\d+$/ : /^(rootfs|mp\d+)$/;
  // rootfs first, then by bus and number: scsi0, scsi1, scsi10.
  const bus = (k: string) => (k === 'rootfs' ? '' : k.replace(/\d+$/, ''));
  const index = (k: string) => Number(k.replace(/\D/g, '') || -1);
  return Object.keys(config)
    .filter((k) => pattern.test(k))
    .sort((a, b) => bus(a).localeCompare(bus(b)) || index(a) - index(b))
    .flatMap((key) => {
      const parts = parsePveList(config[key]);
      const volume = parts[''] ?? parts.volume ?? '';
      if (parts.media === 'cdrom' || volume === 'none' || volume === 'cdrom') return [];
      const disk: ProxmoxDisk = { name: kind === 'lxc' && parts.mp ? `${key} (${parts.mp})` : key };
      const storage = volume.includes(':') ? volume.split(':')[0] : null;
      if (storage) disk.storage = storage;
      const size = sizeToGb(parts.size);
      if (size !== null) disk.sizeGb = size;
      return [disk];
    });
}

/** Proxmox's ostype codes, as the operating system they mean. */
const OSTYPE: Record<string, string> = {
  l26: 'Linux', l24: 'Linux 2.4',
  win11: 'Windows 11 / Server 2022 or later', win10: 'Windows 10 / Server 2016–2019',
  win8: 'Windows 8 / Server 2012', win7: 'Windows 7 / Server 2008 R2', w2k8: 'Windows Vista / Server 2008',
  wvista: 'Windows Vista', w2k3: 'Windows Server 2003', wxp: 'Windows XP', w2k: 'Windows 2000',
  solaris: 'Solaris', other: 'Other',
  debian: 'Debian', ubuntu: 'Ubuntu', centos: 'CentOS', fedora: 'Fedora', alpine: 'Alpine Linux',
  archlinux: 'Arch Linux', opensuse: 'openSUSE', nixos: 'NixOS', devuan: 'Devuan', gentoo: 'Gentoo',
  unmanaged: 'Linux',
};

export function osFor(ostype: unknown): string | null {
  const code = text(ostype, 40);
  return code ? OSTYPE[code.toLowerCase()] ?? code : null;
}

/** "pve-manager/8.2.4/faa83925c9641325" → "8.2.4". */
export function pveVersionOf(raw: unknown): string | null {
  const value = text(raw, 200);
  if (!value) return null;
  return /pve-manager\/([\d.]+)/.exec(value)?.[1] ?? value;
}

const epochIso = (seconds: unknown): string | undefined => {
  const n = num(seconds);
  return n && n > 0 ? new Date(Math.round(n * 1000)).toISOString() : undefined;
};

function digest(values: Record<string, string | number>, host: string | null): Buffer {
  return createHash('sha256')
    .update(JSON.stringify([Object.keys(values).sort().map((k) => [k, values[k]]), host]))
    .digest();
}

export interface NodeInput {
  node: ProxmoxNode;
  status: ProxmoxNodeStatus | null;
  cluster: ProxmoxClusterEntry[];
  storage: ProxmoxResource[];
  guests: ProxmoxResource[];
}

export function mapNode({ node, status, cluster, storage, guests }: NodeInput): MappedMachine {
  const values: Record<string, string | number> = {};
  const put = (key: string, value: string | number | null) => {
    if (value !== null) values[key] = value;
  };
  const entry = cluster.find((c) => c.type === 'node' && c.name === node.node);

  put('hostname', text(node.node, 253));
  put('operating_system', 'Proxmox VE');
  put('os_version', pveVersionOf(status?.pveversion));
  put('cpu', text(status?.cpuinfo?.model, 200));
  const memory = num(status?.memory?.total) ?? num(node.maxmem);
  if (memory && memory > 0) put('memory_gb', gb(memory));
  put('primary_ip', primaryIpFor([entry?.ip]));

  const clusterName = text(cluster.find((c) => c.type === 'cluster')?.name, 200);
  const mine = guests.filter((g) => g.node === node.node && g.template !== 1);
  const profile: ProxmoxNodeProfile = {
    kind: 'node',
    node: node.node,
    storage: storage
      .filter((s) => s.node === node.node && typeof s.maxdisk === 'number' && s.maxdisk > 0)
      .map((s) => ({
        name: text(s.storage, 100) ?? '?',
        ...(text(s.plugintype, 40) ? { type: text(s.plugintype, 40)! } : {}),
        totalGb: Math.round(gb(s.maxdisk!) * 10) / 10,
        usedGb: Math.round(gb(Math.max(0, s.disk ?? 0)) * 10) / 10,
        shared: s.shared === 1,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    guests: { running: mine.filter((g) => g.status === 'running').length, total: mine.length },
  };
  if (clusterName) profile.cluster = clusterName;
  if (text(node.status, 40)) profile.status = text(node.status, 40)!;
  const uptime = num(status?.uptime) ?? num(node.uptime);
  if (uptime !== null) profile.uptimeSeconds = uptime;
  const pve = pveVersionOf(status?.pveversion);
  if (pve) profile.pveVersion = pve;
  const kernel = text(status?.kversion, 200);
  if (kernel) profile.kernel = kernel.split(' #')[0]!;
  const boot = text(status?.['boot-info']?.mode, 20);
  if (boot) profile.bootMode = status?.['boot-info']?.secureboot ? `${boot} (Secure Boot)` : boot;
  const cpu = status?.cpuinfo;
  if (cpu && (cpu.sockets || cpu.cores || cpu.cpus)) {
    profile.cpu = {
      ...(num(cpu.sockets) ? { sockets: num(cpu.sockets)! } : {}),
      ...(num(cpu.cores) ? { cores: num(cpu.cores)! } : {}),
      ...(num(cpu.cpus) ? { threads: num(cpu.cpus)! } : {}),
    };
  }

  return {
    kind: 'node',
    externalId: node.node,
    name: node.node,
    deviceType: 'hypervisor',
    values,
    hostExternalId: null,
    profile,
    sha256: digest(values, null),
  };
}

export interface GuestInput {
  resource: ProxmoxResource;
  config: ProxmoxConfig | null;
  /** QEMU: what the guest agent answered, or null when it did not. */
  agent?: { interfaces: AgentInterface[] | null; os: AgentOsInfo | null; hostName: string | null } | null;
  /** LXC: what a running container reports. */
  lxcInterfaces?: LxcInterface[] | null;
  /** Undefined when Proxmox would not list them. */
  snapshots?: ProxmoxSnapshot[];
  lastBackupAt?: string;
}

/** Addresses the agent reports, loopback left out. */
function agentAddresses(interfaces: AgentInterface[] | null | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const iface of interfaces ?? []) {
    if (/^(lo|loopback pseudo-interface.*)$/i.test(iface.name ?? '')) continue;
    const mac = primaryMacFor([iface['hardware-address']]);
    const addresses = (iface['ip-addresses'] ?? [])
      .map((a) => text(a['ip-address'], 64))
      .filter((a): a is string => a !== null && a !== '127.0.0.1' && a !== '::1' && !/^fe80:/i.test(a));
    if (addresses.length > 0) out.set(mac ?? `name:${iface.name ?? '?'}`, addresses);
  }
  return out;
}

export function mapGuest(input: GuestInput): MappedMachine {
  const { resource, config: rawConfig } = input;
  const kind = resource.type === 'lxc' ? 'lxc' : 'qemu';
  const vmid = resource.vmid!;
  const config = rawConfig ?? {};
  const values: Record<string, string | number> = {};
  const put = (key: string, value: string | number | null) => {
    if (value !== null) values[key] = value;
  };

  const name = text(resource.name, 200) ?? text(config.name, 200) ?? text(config.hostname, 200)
    ?? `${kind === 'lxc' ? 'CT' : 'VM'} ${vmid}`;

  const nics = nicsFor(kind, config);
  if (kind === 'qemu' && input.agent) {
    const found = agentAddresses(input.agent.interfaces);
    for (const nic of nics) {
      const addresses = nic.mac ? found.get(nic.mac) : undefined;
      if (addresses) nic.addresses = addresses;
    }
  }
  if (kind === 'lxc' && input.lxcInterfaces) {
    for (const nic of nics) {
      const live = input.lxcInterfaces.find((i) => i.name === nic.name || primaryMacFor([i.hwaddr]) === nic.mac);
      const addresses = [live?.inet, live?.inet6]
        .map((a) => text(a, 64)?.split('/')[0] ?? null)
        .filter((a): a is string => !!a && !/^fe80:/i.test(a));
      if (addresses.length > 0) nic.addresses = addresses;
    }
  }

  const agentHost = text(input.agent?.hostName, 253);
  put('hostname', agentHost ?? (kind === 'lxc' ? text(config.hostname, 253) : null) ?? text(resource.name, 253));
  const os = input.agent?.os;
  const pretty = text(os?.['pretty-name'], 200) ?? text(os?.name, 200);
  put('operating_system', pretty ?? osFor(config.ostype));
  if (pretty) put('os_version', text(os?.['version-id'], 60) ?? text(os?.['kernel-release'], 60));

  const sockets = num(config.sockets) ?? 1;
  const cores = num(config.cores);
  const vcpus = cores ? sockets * cores : num(resource.maxcpu);
  // "host", "x86-64-v2-AES", or "cputype=host,flags=…".
  const cpuSpec = parsePveList(config.cpu);
  const cpuType = kind === 'qemu' ? text(cpuSpec.cputype ?? cpuSpec[''], 60) : null;
  if (vcpus) put('cpu', `${vcpus} vCPU${cpuType ? ` (${cpuType})` : ''}`);
  const memoryMb = num(config.memory);
  if (memoryMb && memoryMb > 0) put('memory_gb', Math.round((memoryMb / 1024) * 100) / 100);
  else if (num(resource.maxmem)) put('memory_gb', gb(num(resource.maxmem)!));

  const disks = disksFor(kind, config);
  const diskTotal = disks.reduce((sum, d) => sum + (d.sizeGb ?? 0), 0);
  if (diskTotal > 0) put('storage_gb', Math.round(diskTotal * 100) / 100);
  else if (num(resource.maxdisk)) put('storage_gb', gb(num(resource.maxdisk)!));

  put('primary_mac', nics.find((n) => n.mac)?.mac ?? null);
  put('primary_ip', primaryIpFor(nics.flatMap((n) => n.addresses ?? [])));

  const host = text(resource.node, 200);
  const profile: ProxmoxGuestProfile = { kind, vmid, node: host ?? '?', disks, nics };
  if (text(resource.status, 40)) profile.status = text(resource.status, 40)!;
  if (num(resource.uptime)) profile.uptimeSeconds = num(resource.uptime)!;
  if (text(resource.pool, 100)) profile.pool = text(resource.pool, 100)!;
  const tags = (text(resource.tags ?? config.tags, 500) ?? '').split(/[;,\s]+/).filter(Boolean).slice(0, 20);
  if (tags.length > 0) profile.tags = tags;
  if (text(resource.hastate, 40)) profile.haState = text(resource.hastate, 40)!;
  if (config.onboot !== undefined) profile.onBoot = String(config.onboot) === '1';
  if (kind === 'qemu') {
    const enabled = config.agent !== undefined && /^(1|enabled=1)/.test(String(config.agent));
    profile.agent = !enabled ? 'off' : input.agent ? 'answered' : 'not_answering';
    if (cpuType) profile.cpuType = cpuType;
  }
  if (input.snapshots) {
    const real = input.snapshots.filter((s) => s.name !== 'current');
    const latest = real.reduce<ProxmoxSnapshot | null>((a, s) => ((s.snaptime ?? 0) > (a?.snaptime ?? -1) ? s : a), null);
    profile.snapshots = {
      count: real.length,
      ...(latest?.name ? { latestName: latest.name.slice(0, 100) } : {}),
      ...(epochIso(latest?.snaptime) ? { latestAt: epochIso(latest?.snaptime)! } : {}),
    };
  }
  if (input.lastBackupAt) profile.lastBackupAt = input.lastBackupAt;
  const notes = text(config.description, 2000);
  if (notes) profile.notes = notes;

  return {
    kind: 'guest',
    externalId: String(vmid),
    name,
    deviceType: 'virtual_machine',
    values,
    hostExternalId: host,
    profile,
    sha256: digest(values, host),
  };
}

/** The newest backup of each guest, by VMID, from backup listings of any number of stores. */
export function latestBackups(rows: { vmid?: number | string; ctime?: number }[]): Map<string, string> {
  const newest = new Map<string, number>();
  for (const row of rows) {
    if (row.vmid === undefined || row.vmid === null) continue;
    const at = num(row.ctime);
    if (!at) continue;
    const key = String(row.vmid);
    if (at > (newest.get(key) ?? 0)) newest.set(key, at);
  }
  return new Map([...newest].map(([k, v]) => [k, new Date(v * 1000).toISOString()]));
}
