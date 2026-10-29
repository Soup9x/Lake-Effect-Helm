/**
 * Action1 endpoint sync (1160), NinjaOne's sync (0980) for Action1.
 *
 * Which connections are due is helm.sync_due()'s answer, and each run is
 * opened with begin_sync_run and closed with finish_sync_run, so health and
 * history are kept the same way for every provider.
 *
 * WHAT THIS MUST NEVER DO, and where that is enforced:
 *
 *   OVERWRITE A PERSON'S EDIT. helm.upsert_action1_device() names only the
 *   observed columns in its UPDATE, and skips any a person has changed since
 *   the sync last wrote it.
 *
 *   IMPORT INTO THE WRONG CLIENT. An endpoint is imported only when a person
 *   has mapped its Action1 organization to a client. Unmapped is skipped, and
 *   so is a client somebody archived.
 *
 *   DELETE DOCUMENTATION. An endpoint gone from Action1 stays in Helm; its
 *   check-in time stops moving, which is what says so.
 *
 *   SEND THE SECRET ANYWHERE BUT ACTION1. The connection's address is held to
 *   Action1's regional hosts by a trigger, and the secret is revealed through
 *   the audited path with purpose 'integration', one audit row per run.
 */
import { withTenant, db } from '../lib/db/client';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';
import { getSecretService } from '../lib/services';
import {
  Action1Error, fetchToken, listAllEndpoints, listOrganizationEndpoints, listOrganizations,
  type Action1Endpoint, type Action1Organization, type Action1Target,
} from '../lib/action1/client';
import { mapEndpoint, mapProfile } from '../lib/action1/devices';

interface DueRow {
  tenant_id: string;
  worker_actor_id: string;
  connection_id: string;
  provider: string;
  display_name: string;
}

interface ConnectionRow {
  base_url: string;
  client_id: string | null;
  client_secret_id: string | null;
}

type Actor = { tenantId: string; actorId: string; actorType: 'service_account' };

/** Between per-organization reads, to stay under Action1's 30 requests a minute. */
const PER_ORG_PAUSE_MS = 2_500;

export function action1SyncJob(): Job {
  return {
    name: 'action1.sync',
    // The granularity of "due", not the sync rate: each connection's own
    // interval decides that, in sync_due().
    everyMs: 60 * 1000,
    lockKey: 0x48_45_4c_4d_13,
    run: syncAction1,
  };
}

async function syncAction1(ctx: JobContext): Promise<JobResult> {
  const due = (await db('worker')<DueRow[]>`SELECT * FROM helm.sync_due(25)`)
    .filter((row) => row.provider === 'action1');
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
    // Another worker has it. Normal, not a failure.
    if (!runId) continue;

    try {
      const counts = await syncOne(row.connection_id, actor, log);
      totals.connections += 1;
      totals.created += counts.created;
      totals.updated += counts.updated;
      totals.unchanged += counts.unchanged;
      totals.skipped += counts.skipped;

      await withTenant(
        actor,
        async (tx) => tx`
          SELECT helm.finish_sync_run(
            ${runId}::uuid,
            ${counts.failed > 0 ? 'partial' : 'success'}::sync_run_status,
            ${counts.seen}, ${counts.created}, ${counts.updated}, ${counts.skipped}, ${counts.failed},
            NULL,
            ${counts.failed > 0 ? `${counts.failed} endpoint(s) could not be saved: ${counts.firstError}` : null},
            ${tx.json({
              unchanged: counts.unchanged, organizations: counts.organizations, unmapped: counts.skipped,
              per_organization: counts.perOrganization,
            })})
        `,
        { role: 'worker' },
      );
      log.info('synced', { ...counts });
    } catch (error) {
      totals.failed += 1;
      const message = error instanceof Action1Error
        ? `${error.message}${error.remedy ? ` — ${error.remedy}` : ''}`
        : String(describeError(error).error ?? 'sync failed');
      log.warn('sync failed', { kind: error instanceof Action1Error ? error.kind : 'unknown', ...describeError(error) });

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
  organizations: number;
  /** Whether endpoints had to be read organization by organization. */
  perOrganization: boolean;
  firstError: string | null;
}

async function mappedOrganizations(connectionId: string, actor: Actor): Promise<Map<string, string>> {
  return withTenant(
    actor,
    async (tx) => {
      const rows = await tx<{ action1_org_id: string; organization_id: string }[]>`
        SELECT a.action1_org_id, a.organization_id FROM action1_organization a
        JOIN organization o ON o.id = a.organization_id
        WHERE a.connection_id = ${connectionId}::uuid
          AND o.archived_at IS NULL AND o.deleted_at IS NULL
      `;
      return new Map(rows.map((r) => [r.action1_org_id, r.organization_id]));
    },
    { role: 'worker' },
  );
}

async function syncOne(connectionId: string, actor: Actor, log: JobContext['log']): Promise<SyncCounts> {
  const connection = await withTenant(
    actor,
    async (tx) => {
      const [found] = await tx<ConnectionRow[]>`
        SELECT base_url, config ->> 'client_id' AS client_id,
               credential_secret_ids ->> 'client_secret' AS client_secret_id
        FROM integration_connection WHERE id = ${connectionId}::uuid
      `;
      return found;
    },
    { role: 'worker' },
  );
  if (!connection?.client_id || !connection.client_secret_id) {
    throw new Action1Error('the connection has no client id or secret', 'unauthorized', 'Save them under Administration → Integrations → Action1.');
  }

  const revealed = await getSecretService().reveal(actor, connection.client_secret_id, {
    purpose: 'integration',
    role: 'worker',
    reason: 'Action1 endpoint sync',
  });

  let organizations: Action1Organization[];
  let endpoints: Action1Endpoint[];
  let perOrganization = false;
  /** Endpoints per organization, where known. */
  const perOrg = new Map<string, number>();
  try {
    const target: Action1Target = {
      baseUrl: connection.base_url,
      clientId: connection.client_id,
      // Lives for the requests below and is disposed in the finally.
      clientSecret: revealed.value.expose(),
    };
    const token = await fetchToken(target);
    organizations = await listOrganizations(target, token);
    endpoints = await listAllEndpoints(target, token);

    if (endpoints.some((e) => !e.organization_id)) {
      // Which organization each endpoint is in is the one thing the import
      // cannot guess, so read the mapped organizations one by one instead.
      perOrganization = true;
      log.warn('endpoints came back without organization_id; reading per organization');
      const mapped = await mappedOrganizations(connectionId, actor);
      const known = new Set(organizations.map((o) => o.id));
      endpoints = [];
      let first = true;
      for (const orgId of mapped.keys()) {
        if (!known.has(orgId)) continue;
        if (!first) await new Promise((resolve) => setTimeout(resolve, PER_ORG_PAUSE_MS));
        first = false;
        const rows = await listOrganizationEndpoints(target, token, orgId);
        perOrg.set(orgId, rows.length);
        endpoints.push(...rows);
      }
    } else {
      for (const e of endpoints) perOrg.set(e.organization_id!, (perOrg.get(e.organization_id!) ?? 0) + 1);
    }
  } finally {
    revealed.value.dispose();
  }

  await withTenant(
    actor,
    async (tx) => tx`
      SELECT helm.record_action1_organizations(${connectionId}::uuid, ${tx.json(
        organizations.map((o) => ({
          id: o.id,
          name: o.name ?? null,
          // Unknown (null) keeps the last count, rather than claiming zero.
          deviceCount: perOrganization ? perOrg.get(o.id) ?? null : perOrg.get(o.id) ?? 0,
        })),
      )})
    `,
    { role: 'worker' },
  );
  const mapping = await mappedOrganizations(connectionId, actor);

  const counts: SyncCounts = {
    seen: endpoints.length, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0,
    organizations: organizations.length, perOrganization, firstError: null,
  };

  for (const endpoint of endpoints) {
    const mapped = mapEndpoint(endpoint);
    const organizationId = mapped.action1OrgId ? mapping.get(mapped.action1OrgId) : undefined;
    if (!organizationId) {
      counts.skipped += 1;
      continue;
    }

    try {
      // One transaction per endpoint, so one bad record cannot undo the rest.
      const outcome = await withTenant(
        actor,
        async (tx) => {
          const [result] = await tx<{ outcome: 'created' | 'updated' | 'unchanged' }[]>`
            SELECT outcome FROM helm.upsert_action1_device(
              ${connectionId}::uuid, ${organizationId}::uuid, ${mapped.externalId},
              ${mapped.sha256}, ${mapped.name}, ${mapped.deviceType}::device_type,
              ${tx.json(mapped.values)}, ${tx.json(mapProfile(endpoint) as never)})
          `;
          return result?.outcome ?? 'unchanged';
        },
        { role: 'worker' },
      );
      counts[outcome] += 1;
    } catch (error) {
      counts.failed += 1;
      const described = describeError(error);
      counts.firstError ??= `${mapped.name}: ${String(described.error ?? 'failed')}`;
      log.warn('endpoint not saved', { endpoint: mapped.externalId, ...described });
    }
  }

  return counts;
}
