/**
 * Proxmox VE sync (1110).
 *
 * Which connections are due is helm.sync_due()'s answer, and each run is
 * opened with begin_sync_run and closed with finish_sync_run, like NinjaOne's.
 *
 * WHAT THIS MUST NEVER DO, and where that is enforced:
 *
 *   OVERWRITE A PERSON'S EDIT. helm.upsert_proxmox_machine() names only the
 *   observed columns, and skips any a person has changed since the sync last
 *   wrote it — including which host a VM is on.
 *
 *   IMPORT INTO THE WRONG CLIENT. The client is the connection's, read inside
 *   the database function; nothing here names one. A client somebody archived
 *   imports nothing.
 *
 *   DELETE DOCUMENTATION. A VM gone from Proxmox stays in Helm.
 *
 *   FAIL OVER SOMETHING OPTIONAL. A host that is down, a guest agent that does
 *   not answer, a token not allowed to read backups: each costs its own
 *   details, not the sync. What was missing is said in the run.
 *
 *   SEND THE TOKEN ANYWHERE NEW. The address and certificate pin can only
 *   change together with the secret (the trigger in 1110), and the secret is
 *   revealed through the audited path with purpose 'integration'.
 */
import { withTenant, db } from '../lib/db/client';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';
import { getSecretService } from '../lib/services';
import {
  ProxmoxError, listBackups, listGuests, listLxcInterfaces, listNodes, listSnapshots, listStorage,
  readAgentHostName, readAgentInterfaces, readAgentOsInfo, readClusterStatus, readGuestConfig,
  readNodeStatus, readVersion,
  type AgentInterface, type AgentOsInfo, type ProxmoxBackup, type ProxmoxClusterEntry, type ProxmoxNodeStatus, type ProxmoxTarget,
} from '../lib/proxmox/client';
import { latestBackups, mapGuest, mapNode, type MappedMachine } from '../lib/proxmox/machines';

interface DueRow {
  tenant_id: string;
  worker_actor_id: string;
  connection_id: string;
  provider: string;
  display_name: string;
}

interface ConnectionRow {
  base_url: string;
  token_id: string | null;
  token_secret_id: string | null;
  tls_sha256: string | null;
  client_active: boolean;
}

type Actor = { tenantId: string; actorId: string; actorType: 'service_account' };

export function proxmoxSyncJob(): Job {
  return {
    name: 'proxmox.sync',
    everyMs: 60 * 1000,
    lockKey: 0x48_45_4c_4d_12,
    run: syncProxmox,
  };
}

async function syncProxmox(ctx: JobContext): Promise<JobResult> {
  const due = (await db('worker')<DueRow[]>`SELECT * FROM helm.sync_due(25)`)
    .filter((row) => row.provider === 'proxmox');
  if (due.length === 0) return { idle: true };

  const totals = { connections: 0, failed: 0, created: 0, updated: 0, unchanged: 0, skipped: 0 };

  for (const row of due) {
    if (ctx.stopping()) break;
    const actor: Actor = { tenantId: row.tenant_id, actorId: row.worker_actor_id, actorType: 'service_account' };
    const log = ctx.log.child({ tenant: row.tenant_id, connection: row.display_name });

    const runId = await withTenant(
      actor,
      async (tx) => {
        const [opened] = await tx<{ begin_sync_run: string | null }[]>`
          SELECT helm.begin_sync_run(${row.connection_id}::uuid, 'schedule')
        `;
        return opened?.begin_sync_run ?? null;
      },
      { role: 'worker' },
    );
    if (!runId) continue;

    try {
      const counts = await syncOne(row.connection_id, actor, log);
      totals.connections += 1;
      totals.created += counts.created;
      totals.updated += counts.updated;
      totals.unchanged += counts.unchanged;
      totals.skipped += counts.skipped;
      const missing = counts.missing.length > 0
        ? `Proxmox would not give Helm ${counts.missing.join(', ')}; everything else synced.`
        : null;

      await withTenant(
        actor,
        async (tx) => tx`
          SELECT helm.finish_sync_run(
            ${runId}::uuid,
            ${counts.failed > 0 || missing ? 'partial' : 'success'}::sync_run_status,
            ${counts.seen}, ${counts.created}, ${counts.updated}, ${counts.skipped}, ${counts.failed},
            NULL,
            ${[counts.failed > 0 ? `${counts.failed} machine(s) could not be saved: ${counts.firstError}` : null, missing]
              .filter(Boolean).join(' ') || null},
            ${tx.json({
              unchanged: counts.unchanged, hosts: counts.hosts, guests: counts.guests,
              templates: counts.templates, missing: counts.missing,
            })})
        `,
        { role: 'worker' },
      );
      log.info('synced', { ...counts });
    } catch (error) {
      totals.failed += 1;
      const message = error instanceof ProxmoxError
        ? `${error.message}${error.remedy ? ` — ${error.remedy}` : ''}`
        : String(describeError(error).error ?? 'sync failed');
      log.warn('sync failed', { kind: error instanceof ProxmoxError ? error.kind : 'unknown', ...describeError(error) });

      await withTenant(
        actor,
        async (tx) => tx`
          SELECT helm.finish_sync_run(${runId}::uuid, 'failed'::sync_run_status,
                                      0, 0, 0, 0, 0, NULL, ${message})
        `,
        { role: 'worker' },
      ).catch((recordError) => {
        log.error('could not record the failure', describeError(recordError));
      });
    }
  }

  return { counts: totals, idle: totals.connections === 0 && totals.failed === 0 };
}

interface SyncCounts {
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  hosts: number;
  guests: number;
  templates: number;
  missing: string[];
  firstError: string | null;
}

/**
 * A read whose failure costs only what it would have added. Proxmox being
 * unreachable, or refusing the token, is still a failure of the whole run.
 */
async function optional<T>(
  what: string | null, missing: string[], log: JobContext['log'], read: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ProxmoxError && error.kind !== 'unreachable' && error.kind !== 'unauthorized'
        && error.kind !== 'tls_pin_mismatch' && error.kind !== 'tls_untrusted') {
      if (what && !missing.includes(what)) missing.push(what);
      log.debug('optional Proxmox read refused', { what, kind: error.kind, status: error.status });
      return undefined;
    }
    throw error;
  }
}

interface GuestAgent {
  interfaces: AgentInterface[] | null;
  os: AgentOsInfo | null;
  hostName: string | null;
}

const AGENT_REFUSED = 'guest agent details (the token needs VM.Monitor on Proxmox 8, or VM.GuestAgent.Audit on Proxmox 9)';

/**
 * What a running VM's guest agent says, or null when it does not answer — not
 * installed, not running, or busy. Not being allowed to ask is said once in
 * the run, since it is the same for every VM and a person can fix it.
 */
async function readAgent(target: ProxmoxTarget, node: string, vmid: number, missing: string[]): Promise<GuestAgent | null> {
  const quiet = <T>(read: () => Promise<T>): Promise<T | null> => read().catch((error: unknown) => {
    if (!(error instanceof ProxmoxError)) throw error;
    if (['unreachable', 'unauthorized', 'tls_pin_mismatch', 'tls_untrusted'].includes(error.kind)) throw error;
    if (error.kind === 'forbidden' && !missing.includes(AGENT_REFUSED)) missing.push(AGENT_REFUSED);
    return null;
  });
  const interfaces = await quiet(() => readAgentInterfaces(target, node, vmid));
  if (interfaces === null) return null;
  const os = await quiet(() => readAgentOsInfo(target, node, vmid));
  const host = await quiet(() => readAgentHostName(target, node, vmid));
  return { interfaces, os, hostName: host?.['host-name'] ?? null };
}

async function syncOne(connectionId: string, actor: Actor, log: JobContext['log']): Promise<SyncCounts> {
  const connection = await withTenant(
    actor,
    async (tx) => {
      const [found] = await tx<ConnectionRow[]>`
        SELECT c.base_url, c.config ->> 'token_id' AS token_id,
               c.credential_secret_ids ->> 'token_secret' AS token_secret_id,
               c.config ->> 'tls_sha256' AS tls_sha256,
               (o.archived_at IS NULL AND o.deleted_at IS NULL) AS client_active
        FROM integration_connection c JOIN organization o ON o.id = c.organization_id
        WHERE c.id = ${connectionId}::uuid
      `;
      return found;
    },
    { role: 'worker' },
  );
  if (!connection?.token_id || !connection.token_secret_id) {
    throw new ProxmoxError('the connection has no API token', 'unauthorized', 'Save one under Administration → Integrations → Proxmox.');
  }

  const counts: SyncCounts = {
    seen: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0,
    hosts: 0, guests: 0, templates: 0, missing: [], firstError: null,
  };
  // Archiving a client is how a person stops its imports; nothing is read.
  if (!connection.client_active) return counts;

  const revealed = await getSecretService().reveal(actor, connection.token_secret_id, {
    purpose: 'integration',
    role: 'worker',
    reason: 'Proxmox inventory sync',
  });

  const machines: MappedMachine[] = [];
  const missing = counts.missing;
  try {
    const target: ProxmoxTarget = {
      baseUrl: connection.base_url,
      tokenId: connection.token_id,
      // Lives for the reads below and is disposed in the finally.
      tokenSecret: revealed.value.expose(),
      pinnedSha256: connection.tls_sha256,
    };

    await readVersion(target);
    const cluster: ProxmoxClusterEntry[] = (await optional('the cluster status', missing, log, () => readClusterStatus(target))) ?? [];
    const nodes = await listNodes(target);
    const guests = await listGuests(target);
    const storage = (await optional('storage', missing, log, () => listStorage(target))) ?? [];

    for (const node of nodes) {
      // A host that is offline cannot report its status; it is still a host.
      const status: ProxmoxNodeStatus | null = node.status === 'offline' ? null
        : (await optional(null, missing, log, () => readNodeStatus(target, node.node))) ?? null;
      machines.push(mapNode({ node, status, cluster, storage, guests }));
    }

    // Backups, newest per guest. A shared store is listed once, from any host.
    const backupRows: ProxmoxBackup[] = [];
    const listed = new Set<string>();
    const online = new Set(nodes.filter((n) => n.status !== 'offline').map((n) => n.node));
    for (const store of storage) {
      if (!store.storage || !store.node || !online.has(store.node)) continue;
      if (!(store.content ?? '').split(',').includes('backup')) continue;
      const key = store.shared === 1 ? store.storage : `${store.node}/${store.storage}`;
      if (listed.has(key)) continue;
      listed.add(key);
      backupRows.push(...((await optional('backup listings', missing, log,
        () => listBackups(target, store.node!, store.storage!))) ?? []));
    }
    const backups = latestBackups(backupRows);

    for (const resource of guests) {
      if (resource.template === 1) {
        counts.templates += 1;
        continue;
      }
      const kind = resource.type === 'lxc' ? 'lxc' : 'qemu';
      const node = resource.node!;
      const vmid = resource.vmid!;
      const reachable = online.has(node);
      const config = reachable
        ? (await optional('guest configuration', missing, log, () => readGuestConfig(target, node, kind, vmid))) ?? null
        : null;
      const snapshots = reachable
        ? await optional('snapshots', missing, log, () => listSnapshots(target, node, kind, vmid))
        : undefined;

      let agent: GuestAgent | null = null;
      let lxcInterfaces = null;
      const running = reachable && resource.status === 'running';
      if (running && kind === 'qemu' && config && /^(1|enabled=1)/.test(String(config.agent ?? ''))) {
        agent = await readAgent(target, node, vmid, missing);
      }
      if (running && kind === 'lxc') {
        lxcInterfaces = (await optional(null, missing, log, () => listLxcInterfaces(target, node, vmid))) ?? null;
      }

      machines.push(mapGuest({
        resource, config, agent, lxcInterfaces,
        ...(snapshots ? { snapshots } : {}),
        ...(backups.get(String(vmid)) ? { lastBackupAt: backups.get(String(vmid))! } : {}),
      }));
    }
  } finally {
    revealed.value.dispose();
  }

  counts.seen = machines.length + counts.templates;
  counts.skipped = counts.templates;

  // Hosts first, so each guest can name its host's configuration.
  for (const machine of machines) {
    try {
      // One transaction per machine, so one bad record cannot undo the rest.
      const outcome = await withTenant(
        actor,
        async (tx) => {
          const [result] = await tx<{ outcome: 'created' | 'updated' | 'unchanged' | 'skipped' }[]>`
            SELECT outcome FROM helm.upsert_proxmox_machine(
              ${connectionId}::uuid, ${machine.kind}, ${machine.externalId}, ${machine.sha256},
              ${machine.name}, ${machine.deviceType}::device_type, ${tx.json(machine.values)},
              ${machine.hostExternalId}, ${tx.json(machine.profile as never)})
          `;
          return result?.outcome ?? 'unchanged';
        },
        { role: 'worker' },
      );
      counts[outcome] += 1;
      if (outcome !== 'skipped') counts[machine.kind === 'node' ? 'hosts' : 'guests'] += 1;
    } catch (error) {
      counts.failed += 1;
      const described = describeError(error);
      counts.firstError ??= `${machine.name}: ${String(described.error ?? 'failed')}`;
      log.warn('machine not saved', { machine: machine.externalId, kind: machine.kind, ...described });
    }
  }

  return counts;
}
