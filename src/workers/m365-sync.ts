/**
 * Microsoft 365 sync (0990): each connected client's users, subscriptions and
 * domains, as its contacts, licences and domain entries.
 *
 * Due connections come from helm.sync_due() and every run is opened and closed
 * with begin_sync_run / finish_sync_run, like NinjaOne. The three parts run
 * independently: an app missing User.Read.All still imports licences and
 * domains, and the run says "partial" with the permission it lacked.
 *
 * Each person's department, office, address, aliases and groups (1060) ride
 * along with the users part. Groups need GroupMember.Read.All; without it the
 * people still import, the groups recorded last time stay, and the run says
 * "partial" with the permission it lacked.
 *
 * NOTHING HERE OVERWRITES A PERSON'S EDIT, deletes, or archives: the upsert
 * functions name only what they may change and compare with what they last
 * wrote. A user who leaves stays a contact until somebody archives them.
 */
import { withTenant, db } from '../lib/db/client';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';
import { getSecretService } from '../lib/services';
import {
  GraphError, fetchToken, listDomains, listGroupMembers, listGroups, listSubscribedSkus, listUsers,
  type GraphTarget,
} from '../lib/m365/client';
import {
  domainsToImport, groupKind, isPerson, mapProfile, mapSku, mapUser, type ProfileGroup,
} from '../lib/m365/mapping';

interface DueRow {
  tenant_id: string;
  worker_actor_id: string;
  connection_id: string;
  provider: string;
  display_name: string;
}

interface ConnectionRow {
  tenant: string | null;
  client_id: string | null;
  client_secret_id: string | null;
  sync_users: boolean;
  sync_licences: boolean;
  sync_domains: boolean;
}

type Actor = { tenantId: string; actorId: string; actorType: 'service_account' };

export function m365SyncJob(): Job {
  return {
    name: 'm365.sync',
    everyMs: 60 * 1000,
    lockKey: 0x48_45_4c_4d_10,
    run: syncM365,
  };
}

async function syncM365(ctx: JobContext): Promise<JobResult> {
  const due = (await db('worker')<DueRow[]>`SELECT * FROM helm.sync_due(25)`)
    .filter((row) => row.provider === 'microsoft_graph');
  if (due.length === 0) return { idle: true };

  const totals = { connections: 0, failed: 0, partial: 0, created: 0, updated: 0 };

  for (const row of due) {
    if (ctx.stopping()) break;
    const actor: Actor = { tenantId: row.tenant_id, actorId: row.worker_actor_id, actorType: 'service_account' };
    const log = ctx.log.child({ tenant: row.tenant_id, connection: row.connection_id });

    const runId = await withTenant(actor, async (tx) => {
      const [opened] = await tx<{ begin_sync_run: string | null }[]>`
        SELECT helm.begin_sync_run(${row.connection_id}::uuid, 'schedule')
      `;
      return opened?.begin_sync_run ?? null;
    }, { role: 'worker' });
    if (!runId) continue;

    try {
      const result = await syncOne(row.connection_id, actor, log);
      const status = result.errors.length === 0 ? 'success' : result.partsOk > 0 ? 'partial' : 'failed';
      if (status === 'failed') totals.failed += 1;
      else totals.connections += 1;
      if (status === 'partial') totals.partial += 1;
      totals.created += result.created;
      totals.updated += result.updated;

      await withTenant(actor, async (tx) => tx`
        SELECT helm.finish_sync_run(
          ${runId}::uuid, ${status}::sync_run_status,
          ${result.seen}, ${result.created}, ${result.updated}, ${result.skipped}, ${result.failed},
          NULL, ${result.errors.length > 0 ? result.errors.join(' · ') : null},
          ${tx.json(result.details)})
      `, { role: 'worker' });
      log.info('synced', { status, ...result.details });
    } catch (error) {
      totals.failed += 1;
      const message = error instanceof GraphError
        ? `${error.message}${error.remedy ? ` — ${error.remedy}` : ''}`
        : String(describeError(error).error ?? 'sync failed');
      log.warn('sync failed', { kind: error instanceof GraphError ? error.kind : 'unknown', ...describeError(error) });
      await withTenant(actor, async (tx) => tx`
        SELECT helm.finish_sync_run(${runId}::uuid, 'failed'::sync_run_status, 0, 0, 0, 0, 0, NULL, ${message})
      `, { role: 'worker' }).catch((recordError) => {
        log.error('could not record the failure', describeError(recordError));
      });
    }
  }

  return { counts: totals, idle: totals.connections === 0 && totals.failed === 0 };
}

// A type rather than an interface, so it is plain JSON to tx.json().
type PartCounts = {
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
};

const zero = (): PartCounts => ({ seen: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 });

async function syncOne(connectionId: string, actor: Actor, log: JobContext['log']) {
  const connection = await withTenant(actor, async (tx) => {
    const [found] = await tx<ConnectionRow[]>`
      SELECT config ->> 'tenant_id' AS tenant, config ->> 'client_id' AS client_id,
             credential_secret_ids ->> 'client_secret' AS client_secret_id,
             coalesce((config ->> 'sync_users')::boolean, true) AS sync_users,
             coalesce((config ->> 'sync_licences')::boolean, true) AS sync_licences,
             coalesce((config ->> 'sync_domains')::boolean, true) AS sync_domains
      FROM integration_connection WHERE id = ${connectionId}::uuid
    `;
    return found;
  }, { role: 'worker' });
  if (!connection?.tenant || !connection.client_id || !connection.client_secret_id) {
    throw new GraphError('the connection has no tenant, client id or secret', 'unauthorized',
      'Set them under Administration → Integrations → Microsoft 365.');
  }

  const revealed = await getSecretService().reveal(actor, connection.client_secret_id, {
    purpose: 'integration',
    role: 'worker',
    reason: 'Microsoft 365 sync',
  });

  const parts: Record<'users' | 'licences' | 'domains', PartCounts> = {
    users: zero(), licences: zero(), domains: zero(),
  };
  const errors: string[] = [];
  let partsOk = 0;
  const conflicts: string[] = [];

  try {
    const target: GraphTarget = {
      tenant: connection.tenant,
      clientId: connection.client_id,
      clientSecret: revealed.value.expose(),
    };
    // A refused sign-in fails the whole run: nothing else can work.
    const token = await fetchToken(target);

    const part = async (name: keyof typeof parts, enabled: boolean, work: () => Promise<void>) => {
      if (!enabled) return;
      try {
        await work();
        partsOk += 1;
      } catch (error) {
        const message = error instanceof GraphError
          ? `${error.message}${error.remedy ? ` — ${error.remedy}` : ''}`
          : String(describeError(error).error ?? `${name} failed`);
        errors.push(message);
        log.warn(`${name} failed`, describeError(error));
      }
    };

    await part('users', connection.sync_users, async () => {
      const users = (await listUsers(target, token)).filter(isPerson);
      const groups = await groupsByUser(target, token, new Set(users.map((u) => u.id)), errors, log);
      for (const user of users) {
        const mapped = mapUser(user);
        const profile = mapProfile(user, groups ? groups.get(user.id) ?? [] : null);
        await upsert(parts.users, log, () => withTenant(actor, async (tx) => {
          const [r] = await tx<{ outcome: string }[]>`
            SELECT outcome FROM helm.upsert_m365_user(
              ${connectionId}::uuid, ${mapped.graphId}, ${mapped.sha256}, ${tx.json(mapped.values)})
          `;
          const outcome = r?.outcome ?? 'unchanged';
          if (outcome === 'skipped') return outcome;
          const [p] = await tx<{ set_m365_contact_profile: string }[]>`
            SELECT helm.set_m365_contact_profile(${connectionId}::uuid, ${mapped.graphId}, ${tx.json(profile)})
          `;
          return outcome === 'unchanged' && p?.set_m365_contact_profile === 'updated' ? 'updated' : outcome;
        }, { role: 'worker' }));
      }
    });

    await part('licences', connection.sync_licences, async () => {
      const skus = await listSubscribedSkus(target, token);
      for (const sku of skus) {
        const mapped = mapSku(sku);
        if (!mapped) continue;
        await upsert(parts.licences, log, () => withTenant(actor, async (tx) => {
          const [r] = await tx<{ outcome: string }[]>`
            SELECT outcome FROM helm.upsert_m365_licence(
              ${connectionId}::uuid, ${mapped.skuId}, ${mapped.name},
              ${mapped.seatsPurchased}, ${mapped.seatsUsed})
          `;
          return r?.outcome ?? 'unchanged';
        }, { role: 'worker' }));
      }
    });

    await part('domains', connection.sync_domains, async () => {
      for (const domain of domainsToImport(await listDomains(target, token))) {
        await upsert(parts.domains, log, () => withTenant(actor, async (tx) => {
          const [r] = await tx<{ outcome: string }[]>`
            SELECT outcome FROM helm.upsert_m365_domain(${connectionId}::uuid, ${domain})
          `;
          if (r?.outcome === 'conflict') conflicts.push(domain);
          return r?.outcome ?? 'unchanged';
        }, { role: 'worker' }));
      }
    });
  } finally {
    revealed.value.dispose();
  }

  if (conflicts.length > 0) {
    errors.push(`already documented for another client, so not linked: ${conflicts.join(', ')}`);
  }

  const sum = (key: keyof PartCounts) => parts.users[key] + parts.licences[key] + parts.domains[key];
  return {
    seen: sum('seen'),
    created: sum('created'),
    updated: sum('updated'),
    skipped: sum('skipped'),
    failed: sum('failed'),
    partsOk,
    errors,
    details: { users: parts.users, licences: parts.licences, domains: parts.domains },
  };
}

/**
 * Each person's groups, or null when they could not be read. A missing
 * GroupMember.Read.All is recorded with the run's errors rather than failing
 * the users part, so the people still import.
 */
async function groupsByUser(
  target: GraphTarget, token: string, people: Set<string>, errors: string[], log: JobContext['log'],
): Promise<Map<string, ProfileGroup[]> | null> {
  try {
    const byUser = new Map<string, ProfileGroup[]>();
    for (const group of await listGroups(target, token)) {
      const entry = { name: group.displayName?.trim() || group.mail?.trim() || group.id, kind: groupKind(group) };
      for (const member of await listGroupMembers(target, token, group.id)) {
        if (member['@odata.type'] && member['@odata.type'] !== '#microsoft.graph.user') continue;
        if (!people.has(member.id)) continue;
        const list = byUser.get(member.id) ?? [];
        list.push(entry);
        byUser.set(member.id, list);
      }
    }
    return byUser;
  } catch (error) {
    const message = error instanceof GraphError
      ? `${error.message}${error.remedy ? ` — ${error.remedy}` : ''}`
      : String(describeError(error).error ?? 'groups failed');
    errors.push(message);
    log.warn('groups failed', describeError(error));
    return null;
  }
}

/** One record, in its own transaction, counted by outcome. */
async function upsert(counts: PartCounts, log: JobContext['log'], write: () => Promise<string>): Promise<void> {
  counts.seen += 1;
  try {
    const outcome = await write();
    if (outcome === 'created') counts.created += 1;
    else if (outcome === 'updated' || outcome === 'linked') counts.updated += 1;
    else if (outcome === 'skipped' || outcome === 'conflict') counts.skipped += 1;
    else counts.unchanged += 1;
  } catch (error) {
    counts.failed += 1;
    log.warn('record not saved', describeError(error));
  }
}
