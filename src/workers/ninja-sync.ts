/**
 * NinjaOne device sync (0980).
 *
 * Which connections are due is helm.sync_due()'s answer — the interval, the
 * failure backoff and "never run yet" all live there — and each run is opened
 * with begin_sync_run and closed with finish_sync_run, so the connection's
 * health and the run history are kept the same way for every provider.
 *
 * WHAT THIS MUST NEVER DO, and where that is enforced:
 *
 *   OVERWRITE A PERSON'S EDIT. helm.upsert_ninja_device() names only the
 *   observed columns in its UPDATE, and skips any of those a person has
 *   changed since the sync last wrote it. This file could not do otherwise.
 *
 *   IMPORT INTO THE WRONG CLIENT. A device is imported only when a person has
 *   mapped its NinjaOne organisation to a client. Unmapped is skipped.
 *
 *   DELETE DOCUMENTATION. A device gone from NinjaOne stays in Helm. Its
 *   check-in time stops moving, which is what says so.
 *
 *   SEND THE SECRET ANYWHERE BUT NINJAONE. The connection's address is held to
 *   NinjaOne's regional hosts by a trigger, and the secret is revealed through
 *   the audited path with purpose 'integration', one audit row per run.
 */
import { withTenant, db } from '../lib/db/client';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';
import { getSecretService } from '../lib/services';
import { NinjaError, fetchToken, listDevices, listOrganizations } from '../lib/ninja/client';
import { mapDevice } from '../lib/ninja/devices';

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

export function ninjaSyncJob(): Job {
  return {
    name: 'ninja.sync',
    // The granularity of "due", not the sync rate: each connection's own
    // interval decides that, in sync_due().
    everyMs: 60 * 1000,
    lockKey: 0x48_45_4c_4d_0f,
    run: syncNinja,
  };
}

async function syncNinja(ctx: JobContext): Promise<JobResult> {
  const due = (await db('worker')<DueRow[]>`SELECT * FROM helm.sync_due(25)`)
    .filter((row) => row.provider === 'ninja_one');
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
            ${counts.failed > 0 ? `${counts.failed} device(s) could not be saved: ${counts.firstError}` : null},
            ${tx.json({ unchanged: counts.unchanged, organizations: counts.organizations, unmapped: counts.skipped })})
        `,
        { role: 'worker' },
      );
      log.info('synced', { ...counts });
    } catch (error) {
      totals.failed += 1;
      const message = error instanceof NinjaError
        ? `${error.message}${error.remedy ? ` — ${error.remedy}` : ''}`
        : String(describeError(error).error ?? 'sync failed');
      log.warn('sync failed', { kind: error instanceof NinjaError ? error.kind : 'unknown', ...describeError(error) });

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
  firstError: string | null;
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
    throw new NinjaError('the connection has no client id or secret', 'unauthorized', 'Save them under Administration → Integrations → NinjaOne.');
  }

  const revealed = await getSecretService().reveal(actor, connection.client_secret_id, {
    purpose: 'integration',
    role: 'worker',
    reason: 'NinjaOne device sync',
  });

  let organizations;
  let devices;
  try {
    const target = {
      baseUrl: connection.base_url,
      clientId: connection.client_id,
      // Lives for the requests below and is disposed in the finally.
      clientSecret: revealed.value.expose(),
    };
    const token = await fetchToken(target);
    organizations = await listOrganizations(target, token);
    devices = await listDevices(target, token);
  } finally {
    revealed.value.dispose();
  }

  const perOrg = new Map<string, number>();
  for (const device of devices) {
    const org = device.organizationId === undefined ? null : String(device.organizationId);
    if (org !== null) perOrg.set(org, (perOrg.get(org) ?? 0) + 1);
  }

  const mapping = await withTenant(
    actor,
    async (tx) => {
      await tx`
        SELECT helm.record_ninja_organizations(${connectionId}::uuid, ${tx.json(
          organizations.map((o) => ({
            id: String(o.id),
            name: o.name ?? null,
            deviceCount: perOrg.get(String(o.id)) ?? 0,
          })),
        )})
      `;
      const rows = await tx<{ ninja_org_id: string; organization_id: string }[]>`
        SELECT ninja_org_id, organization_id FROM ninja_organization
        WHERE connection_id = ${connectionId}::uuid AND organization_id IS NOT NULL
      `;
      return new Map(rows.map((r) => [r.ninja_org_id, r.organization_id]));
    },
    { role: 'worker' },
  );

  const counts: SyncCounts = {
    seen: devices.length, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0,
    organizations: organizations.length, firstError: null,
  };

  for (const device of devices) {
    const mapped = mapDevice(device);
    const organizationId = mapped.ninjaOrgId ? mapping.get(mapped.ninjaOrgId) : undefined;
    if (!organizationId) {
      counts.skipped += 1;
      continue;
    }

    try {
      // One transaction per device, so one bad record cannot undo the rest.
      const outcome = await withTenant(
        actor,
        async (tx) => {
          const [result] = await tx<{ outcome: 'created' | 'updated' | 'unchanged' }[]>`
            SELECT outcome FROM helm.upsert_ninja_device(
              ${connectionId}::uuid, ${organizationId}::uuid, ${mapped.externalId},
              ${mapped.sha256}, ${mapped.name}, ${mapped.deviceType}::device_type,
              ${tx.json(mapped.values)})
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
      log.warn('device not saved', { device: mapped.externalId, ...described });
    }
  }

  return counts;
}
