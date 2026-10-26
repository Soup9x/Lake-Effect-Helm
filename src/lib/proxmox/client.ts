/**
 * A client for the Proxmox VE API (/api2/json), read-only.
 *
 * AUTHENTICATION is an API token, sent as
 *   Authorization: PVEAPIToken=helm@pve!helm=<secret>
 * on every request. Made in Proxmox under Datacenter → Permissions → API
 * Tokens, for a user holding the PVEAuditor role on /. A token never expires
 * unless it was given an expiry, and nothing here can change anything in
 * Proxmox: every call is a GET.
 *
 * WHAT IS READ
 *
 *   /version                              that the token works, and the version
 *   /cluster/status                       the cluster's name, each node's address
 *   /nodes                                the hosts
 *   /nodes/{node}/status                  a host's CPU, memory, kernel, version
 *   /cluster/resources?type=vm            every VM and container in one call
 *   /cluster/resources?type=storage       each host's storage, and where backups are kept
 *   /nodes/{node}/{qemu|lxc}/{id}/config  a guest's CPUs, memory, disks and NICs
 *   /nodes/{node}/{qemu|lxc}/{id}/snapshot
 *   /nodes/{node}/qemu/{id}/agent/...     what the guest agent says: addresses,
 *                                         hostname and operating system. Needs
 *                                         VM.Monitor (PVE 8) or
 *                                         VM.GuestAgent.Audit (PVE 9), which
 *                                         PVEAuditor does not hold; optional.
 *   /nodes/{node}/lxc/{id}/interfaces     a running container's addresses
 *   /nodes/{node}/storage/{s}/content?content=backup   the backups, for "last backup"
 *
 * THE CERTIFICATE. Proxmox ships a self-signed one. A connection either trusts
 * the system's CAs (a real certificate, or the Proxmox CA added to this
 * server's trust store) or pins one certificate by its sha256; see
 * src/lib/net/pinned-https.ts.
 */
import { PinnedHttpsError, inspectCertificate, pinnedGet, type CertificateInfo } from '../net/pinned-https';

export class ProxmoxError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'tls_untrusted' | 'tls_pin_mismatch' | 'unauthorized' | 'forbidden'
      | 'not_found' | 'agent' | 'malformed' | 'http_error',
    /** What a person should change. Shown next to the failure. */
    readonly remedy?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProxmoxError';
  }
}

export interface ProxmoxTarget {
  /** Origin only: https://host:8006. */
  readonly baseUrl: string;
  /** user@realm!tokenid */
  readonly tokenId: string;
  readonly tokenSecret: string;
  /** sha256 of the one certificate accepted, or null for ordinary verification. */
  readonly pinnedSha256: string | null;
  readonly timeoutMs?: number;
}

export const TOKEN_ID = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z][A-Za-z0-9._-]*$/;
export const BASE_URL = /^https:\/\/([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?$/;

const DEFAULT_TIMEOUT_MS = 15_000;

const REMEDY = {
  unreachable: 'Check the address and port (usually 8006), and that this server can reach Proxmox — a firewall or a missing VPN route are the usual causes.',
  tls_untrusted: 'Proxmox uses a self-signed certificate unless you replaced it. Fetch its fingerprint in the connection form and save it, or give Proxmox a certificate this server trusts.',
  tls_pin_mismatch: 'The certificate changed since it was trusted. If you renewed or replaced it, fetch the new fingerprint and save it with the token secret. If you did not, find out why before trusting it.',
  unauthorized: 'Check the token ID (user@realm!token) and secret, and that the token has not expired or been removed.',
  forbidden: 'Give the token\'s user the PVEAuditor role on / (and untick Privilege Separation, or give the token the role too).',
} as const;

function fromTransport(error: unknown): ProxmoxError {
  if (error instanceof PinnedHttpsError) {
    const kind = error.kind === 'too_large' ? 'malformed' : error.kind;
    return new ProxmoxError(`Proxmox: ${error.message}`, kind, kind === 'malformed' ? undefined : REMEDY[kind]);
  }
  return new ProxmoxError(`Proxmox did not answer (${error instanceof Error ? error.message : String(error)})`,
    'unreachable', REMEDY.unreachable);
}

export async function get<T = unknown>(target: ProxmoxTarget, path: string, timeoutMs?: number): Promise<T> {
  let response: { status: number; body: string };
  try {
    response = await pinnedGet(`${target.baseUrl}/api2/json${path}`, {
      headers: {
        authorization: `PVEAPIToken=${target.tokenId}=${target.tokenSecret}`,
        accept: 'application/json',
        'user-agent': 'lake-effect-helm/1 (+proxmox-inventory)',
      },
      pinnedSha256: target.pinnedSha256,
      timeoutMs: timeoutMs ?? target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (error) {
    throw fromTransport(error);
  }

  const { status, body } = response;
  if (status === 401) {
    throw new ProxmoxError('Proxmox refused the API token', 'unauthorized', REMEDY.unauthorized, 401);
  }
  if (status === 403) {
    throw new ProxmoxError(`Proxmox says the token may not read ${path}`, 'forbidden', REMEDY.forbidden, 403);
  }
  if (status === 404) {
    throw new ProxmoxError(`Proxmox has nothing at ${path}`, 'not_found', undefined, 404);
  }
  // The guest agent's "not running" and "not configured" are 500s whose
  // reason is in the status line or body.
  if (status === 500 && path.includes('/agent/')) {
    throw new ProxmoxError('the guest agent did not answer', 'agent', undefined, 500);
  }
  if (status < 200 || status >= 300) {
    throw new ProxmoxError(`Proxmox answered ${status} for ${path}`, 'http_error', undefined, status);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new ProxmoxError(`Proxmox's answer for ${path} was not JSON`, 'malformed',
      'Something other than Proxmox may be answering at that address, such as a reverse proxy.');
  }
  if (payload === null || typeof payload !== 'object' || !('data' in payload)) {
    throw new ProxmoxError(`Proxmox answered ${path} in a shape Helm does not read`, 'malformed');
  }
  return (payload as { data: T }).data;
}

const list = async <T>(target: ProxmoxTarget, path: string): Promise<T[]> => {
  const data = await get<unknown>(target, path);
  if (!Array.isArray(data)) throw new ProxmoxError(`Proxmox answered ${path} in a shape Helm does not read`, 'malformed');
  return data.filter((r): r is T => r !== null && typeof r === 'object');
};

const enc = encodeURIComponent;

export interface ProxmoxVersion { version?: string; release?: string }
export interface ProxmoxClusterEntry {
  type?: string; name?: string; ip?: string; online?: number; nodes?: number; quorate?: number;
}
export interface ProxmoxNode {
  node: string; status?: string; maxcpu?: number; maxmem?: number; uptime?: number;
}
export interface ProxmoxNodeStatus {
  cpuinfo?: { model?: string; cpus?: number; sockets?: number; cores?: number };
  memory?: { total?: number };
  uptime?: number;
  pveversion?: string;
  kversion?: string;
  'boot-info'?: { mode?: string; secureboot?: number };
  [key: string]: unknown;
}
export interface ProxmoxResource {
  id?: string;
  type?: string;
  vmid?: number;
  name?: string;
  node?: string;
  status?: string;
  template?: number;
  maxcpu?: number;
  maxmem?: number;
  maxdisk?: number;
  uptime?: number;
  tags?: string;
  pool?: string;
  hastate?: string;
  // Storage rows.
  storage?: string;
  plugintype?: string;
  disk?: number;
  shared?: number;
  content?: string;
}
export type ProxmoxConfig = Record<string, unknown>;
export interface ProxmoxSnapshot { name?: string; snaptime?: number; description?: string }
export interface ProxmoxBackup { volid?: string; vmid?: number | string; ctime?: number; size?: number }
export interface AgentInterface {
  name?: string;
  'hardware-address'?: string;
  'ip-addresses'?: { 'ip-address'?: string; 'ip-address-type'?: string; prefix?: number }[];
}
export interface AgentOsInfo {
  name?: string; 'pretty-name'?: string; version?: string; 'version-id'?: string;
  'kernel-release'?: string; id?: string;
}
export interface LxcInterface { name?: string; hwaddr?: string; inet?: string; inet6?: string }

export const readVersion = (t: ProxmoxTarget) => get<ProxmoxVersion>(t, '/version');
export const readClusterStatus = (t: ProxmoxTarget) => list<ProxmoxClusterEntry>(t, '/cluster/status');
export const listNodes = async (t: ProxmoxTarget) =>
  (await list<ProxmoxNode>(t, '/nodes')).filter((n) => typeof n.node === 'string' && n.node !== '');
export const readNodeStatus = (t: ProxmoxTarget, node: string) =>
  get<ProxmoxNodeStatus>(t, `/nodes/${enc(node)}/status`);
export const listGuests = async (t: ProxmoxTarget) =>
  (await list<ProxmoxResource>(t, '/cluster/resources?type=vm'))
    .filter((r) => (r.type === 'qemu' || r.type === 'lxc') && typeof r.vmid === 'number' && typeof r.node === 'string');
export const listStorage = (t: ProxmoxTarget) => list<ProxmoxResource>(t, '/cluster/resources?type=storage');
export const readGuestConfig = (t: ProxmoxTarget, node: string, kind: 'qemu' | 'lxc', vmid: number) =>
  get<ProxmoxConfig>(t, `/nodes/${enc(node)}/${kind}/${vmid}/config`);
export const listSnapshots = (t: ProxmoxTarget, node: string, kind: 'qemu' | 'lxc', vmid: number) =>
  list<ProxmoxSnapshot>(t, `/nodes/${enc(node)}/${kind}/${vmid}/snapshot`);
export const listBackups = (t: ProxmoxTarget, node: string, storage: string) =>
  list<ProxmoxBackup>(t, `/nodes/${enc(node)}/storage/${enc(storage)}/content?content=backup`);
export const listLxcInterfaces = (t: ProxmoxTarget, node: string, vmid: number) =>
  list<LxcInterface>(t, `/nodes/${enc(node)}/lxc/${vmid}/interfaces`);

/** Agent calls answer { result }, and are given less time: a hung agent should not stall the sync. */
const AGENT_TIMEOUT_MS = 8_000;
async function agent<T>(t: ProxmoxTarget, node: string, vmid: number, command: string): Promise<T | null> {
  const data = await get<{ result?: T }>(t, `/nodes/${enc(node)}/qemu/${vmid}/agent/${command}`, AGENT_TIMEOUT_MS);
  return data?.result ?? null;
}
export const readAgentInterfaces = (t: ProxmoxTarget, node: string, vmid: number) =>
  agent<AgentInterface[]>(t, node, vmid, 'network-get-interfaces');
export const readAgentOsInfo = (t: ProxmoxTarget, node: string, vmid: number) =>
  agent<AgentOsInfo>(t, node, vmid, 'get-osinfo');
export const readAgentHostName = (t: ProxmoxTarget, node: string, vmid: number) =>
  agent<{ 'host-name'?: string }>(t, node, vmid, 'get-host-name');

/** The certificate the address presents, for a person to decide whether to trust it. */
export async function readCertificate(baseUrl: string): Promise<CertificateInfo> {
  try {
    return await inspectCertificate(baseUrl);
  } catch (error) {
    throw fromTransport(error);
  }
}
