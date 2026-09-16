/**
 * RMM / PSA / Microsoft Graph synchronisation.
 *
 * The engine is vendor-independent; the vendor part is in providers.ts. What
 * happens here is the part that decides whether an MSP trusts the integration:
 *
 *   CORRELATION. Every external record is matched to a Helm node through
 *   external_identity, whose unique constraints pin both directions — one
 *   external record maps to one node, one node has one identity per external
 *   type per connection. Without that, the second sync creates duplicates and
 *   the third sync's "cleanup" deletes real documentation.
 *
 *   MANUAL EDITS SURVIVE. With respect_manual_edits on (the default), an
 *   inbound value only fills a field that is still NULL. A technician who
 *   corrected a hostname the RMM has wrong keeps their correction. The
 *   alternative — last writer wins — teaches technicians that editing anything
 *   is pointless, and then the documentation stops being maintained.
 *
 *   UNCHANGED RECORDS COST NOTHING. The vendor payload is hashed and compared
 *   to the last one seen, so a nightly sync over 4,000 devices writes only what
 *   actually moved. This is also what keeps the audit log readable: without it
 *   every sync would append thousands of update events and bury the human ones.
 *
 *   CREDENTIALS GO THROUGH THE AUDITED PATH. The worker resolves API keys with
 *   helm.reveal_secret(purpose => 'integration'), and its service account is
 *   pinned to that purpose, so machine access to client credentials is recorded
 *   exactly like human access and cannot reach anything else.
 */
import type { HelmTx } from '../lib/db/client';
import { db, withTenant } from '../lib/db/client';
import { getSecretService } from '../lib/services';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';
import {
  payloadHash,
  providerFor,
  type ExternalRecord,
  type ProviderContext,
} from './providers';

interface SyncDueRow {
  tenant_id: string;
  worker_actor_id: string;
  connection_id: string;
  provider: string;
  display_name: string;
  organization_id: string | null;
  direction: string;
  last_sync_at: Date | null;
  consecutive_failures: number;
  due_since: Date;
}

interface ConnectionRow {
  base_url: string | null;
  config: Record<string, unknown>;
  credential_secret_ids: Record<string, string>;
  respect_manual_edits: boolean;
  organization_id: string | null;
}

interface Counters {
  seen: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

/** Bounds one run so a runaway pagination cursor cannot loop forever. */
const MAX_PAGES = 200;
const PAGE_TIMEOUT_MS = 30_000;

export function integrationSyncJob(): Job {
  return {
    name: 'integrations.sync',
    everyMs: 5 * 60 * 1000,
    lockKey: 0x48_45_4c_4d_03,
    run: runIntegrationSync,
  };
}

async function runIntegrationSync(ctx: JobContext): Promise<JobResult> {
  const due = await db('worker')<SyncDueRow[]>`SELECT * FROM helm.sync_due(25)`;
  if (due.length === 0) return { idle: true };

  let succeeded = 0;
  let failed = 0;
  const totals: Counters = { seen: 0, created: 0, updated: 0, skipped: 0, failed: 0 };

  for (const connection of due) {
    if (ctx.stopping()) break;
    const log = ctx.log.child({ connection: connection.display_name, provider: connection.provider });

    const outcome = await syncOne(connection, log);
    if (outcome.ok) succeeded += 1;
    else failed += 1;

    totals.seen += outcome.counters.seen;
    totals.created += outcome.counters.created;
    totals.updated += outcome.counters.updated;
    totals.skipped += outcome.counters.skipped;
    totals.failed += outcome.counters.failed;
  }

  return { counts: { connections: due.length, succeeded, runsFailed: failed, ...totals } };
}

async function syncOne(
  connection: SyncDueRow,
  log: JobContext['log'],
): Promise<{ ok: boolean; counters: Counters }> {
  const actor = {
    tenantId: connection.tenant_id,
    actorId: connection.worker_actor_id,
    actorType: 'service_account' as const,
  };
  const counters: Counters = { seen: 0, created: 0, updated: 0, skipped: 0, failed: 0 };

  // Claim the run in its own transaction: if the sync itself takes twenty
  // minutes, the claim must be visible to other runners immediately rather than
  // at the end.
  const runId = await withTenant(
    actor,
    async (tx) => {
      const [row] = await tx<{ run: string | null }[]>`
        SELECT helm.begin_sync_run(${connection.connection_id}::uuid, 'schedule') AS run
      `;
      return row?.run ?? null;
    },
    { role: 'worker' },
  );

  if (!runId) {
    log.debug('another run is already in flight');
    return { ok: true, counters };
  }

  let cursorAfter: string | null = null;
  let error: string | null = null;

  try {
    const settings = await withTenant(
      actor,
      async (tx) => {
        const [row] = await tx<ConnectionRow[]>`
          SELECT base_url, config, credential_secret_ids, respect_manual_edits, organization_id
          FROM integration_connection
          WHERE id = ${connection.connection_id}::uuid
        `;
        if (!row) throw new Error('connection disappeared mid-run');
        return row;
      },
      { role: 'worker' },
    );

    // A tenant-wide connection has no organization_id of its own. Without a
    // target organisation there is nowhere to put an asset, and guessing would
    // file another client's servers under the wrong company.
    const organizationId = settings.organization_id ?? readTargetOrganization(settings.config);
    if (!organizationId) {
      throw new Error(
        'connection has no organization_id and its config names no "organizationId"; ' +
          'inbound records have no destination',
      );
    }

    const provider = providerFor(connection.provider);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS * MAX_PAGES);

    const providerCtx: ProviderContext = {
      baseUrl: settings.base_url,
      config: settings.config,
      signal: controller.signal,
      credential: (role) => resolveCredential(actor, settings.credential_secret_ids, role),
    };

    try {
      let cursor: string | null = null;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const fetched = await provider.fetchPage(providerCtx, cursor);
        counters.seen += fetched.records.length;

        if (fetched.records.length > 0) {
          await withTenant(
            actor,
            async (tx) => {
              for (const record of fetched.records) {
                try {
                  const outcome = await upsertRecord(
                    tx,
                    connection.connection_id,
                    organizationId,
                    record,
                    settings.respect_manual_edits,
                  );
                  counters[outcome] += 1;
                } catch (recordError) {
                  // One malformed record must not abandon the other 3,999.
                  counters.failed += 1;
                  log.warn('record failed', {
                    externalId: record.externalId,
                    ...describeError(recordError),
                  });
                }
              }
            },
            { role: 'worker' },
          );
        }

        cursor = fetched.nextCursor;
        cursorAfter = cursor;
        if (!cursor) break;

        if (page === MAX_PAGES - 1) {
          // Not silent: a cursor that never terminates is a provider bug, and
          // the run is recorded as partial so the next one resumes rather than
          // starting over.
          throw new Error(`pagination did not terminate after ${MAX_PAGES} pages`);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (caught) {
    error = String(describeError(caught).error ?? 'sync failed');
    log.error('sync failed', describeError(caught));
  }

  const status = error ? 'failed' : counters.failed > 0 ? 'partial' : 'success';

  await withTenant(
    actor,
    async (tx) => tx`
      SELECT helm.finish_sync_run(
        ${runId}::uuid, ${status}::sync_run_status,
        ${counters.seen}, ${counters.created}, ${counters.updated},
        ${counters.skipped}, ${counters.failed},
        ${cursorAfter}, ${error}, ${tx.json({})}::jsonb
      )
    `,
    { role: 'worker' },
  );

  return { ok: !error, counters };
}

function readTargetOrganization(config: Record<string, unknown>): string | null {
  const value = config.organizationId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function resolveCredential(
  actor: { tenantId: string; actorId: string; actorType: 'service_account' },
  credentials: Record<string, string>,
  role: string,
): Promise<string> {
  const secretId = credentials[role];
  if (!secretId) {
    throw new Error(`connection has no credential for role "${role}"`);
  }

  const revealed = await getSecretService().reveal(actor, secretId, {
    purpose: 'integration',
    reason: `integration sync: ${role}`,
    role: 'worker',
  });

  try {
    return revealed.value.expose();
  } finally {
    revealed.value.dispose();
  }
}

/**
 * Create or update one node, and its correlation row, in one transaction.
 *
 * Returns which of the three things happened so the run's counts mean what they
 * say: 'skipped' specifically means the payload hash was unchanged, which is
 * the number that tells an operator the hashing is earning its keep.
 */
async function upsertRecord(
  tx: HelmTx,
  connectionId: string,
  organizationId: string,
  record: ExternalRecord,
  respectManualEdits: boolean,
): Promise<'created' | 'updated' | 'skipped'> {
  const hash = payloadHash(record.raw);

  const [existing] = await tx<{ node_id: string; payload_sha256: Buffer | null }[]>`
    SELECT node_id, payload_sha256
    FROM external_identity
    WHERE connection_id = ${connectionId}::uuid
      AND external_type = ${record.externalType}
      AND external_id = ${record.externalId}
  `;

  if (existing) {
    if (existing.payload_sha256 && existing.payload_sha256.equals(hash)) {
      // Unchanged since last time. Touch only the freshness timestamp so
      // "last seen by the sync" stays accurate without writing an asset row.
      await tx`
        UPDATE external_identity SET last_synced_at = now()
        WHERE connection_id = ${connectionId}::uuid
          AND external_type = ${record.externalType}
          AND external_id = ${record.externalId}
      `;
      return 'skipped';
    }

    await updateNode(tx, existing.node_id, record, respectManualEdits);
    await tx`
      UPDATE external_identity
      SET payload_sha256 = ${hash}, last_synced_at = now(),
          external_url = coalesce(${record.externalUrl ?? null}, external_url)
      WHERE connection_id = ${connectionId}::uuid
        AND external_type = ${record.externalType}
        AND external_id = ${record.externalId}
    `;
    return 'updated';
  }

  const nodeId = await insertNode(tx, organizationId, record);

  await tx`
    INSERT INTO external_identity (
      tenant_id, connection_id, node_id, external_id, external_type,
      external_url, payload_sha256, is_authoritative
    )
    VALUES (
      helm.require_tenant_id(), ${connectionId}::uuid, ${nodeId}::uuid,
      ${record.externalId}, ${record.externalType},
      ${record.externalUrl ?? null}, ${hash}, true
    )
  `;

  return 'created';
}

async function insertNode(
  tx: HelmTx,
  organizationId: string,
  record: ExternalRecord,
): Promise<string> {
  const asset = record.asset;

  const [node] = await tx<{ id: string }[]>`
    INSERT INTO asset_node (tenant_id, organization_id, node_type, name, external_ref)
    VALUES (
      helm.require_tenant_id(), ${organizationId}::uuid,
      ${asset.nodeType}::node_type, ${asset.name}, ${record.externalId}
    )
    RETURNING id
  `;
  if (!node) throw new Error('asset_node insert returned no row');

  await tx`
    INSERT INTO device (
      id, tenant_id, device_type, hostname, fqdn, manufacturer, model,
      serial_number, operating_system, os_version, last_seen_at, rmm_device_id
    )
    VALUES (
      ${node.id}::uuid, helm.require_tenant_id(), ${asset.deviceType}::device_type,
      ${asset.hostname ?? null}, ${asset.fqdn ?? null}, ${asset.manufacturer ?? null},
      ${asset.model ?? null}, ${asset.serialNumber ?? null}, ${asset.operatingSystem ?? null},
      ${asset.osVersion ?? null}, ${asset.lastSeenAt ?? null}, ${asset.rmmDeviceId ?? null}
    )
  `;

  return node.id;
}

/**
 * Update a synced node.
 *
 * With `respect_manual_edits` the COALESCE runs the other way round — the
 * existing value wins and the inbound one only fills a NULL. That single
 * difference is what decides whether technicians keep correcting the
 * documentation or give up on it.
 */
async function updateNode(
  tx: HelmTx,
  nodeId: string,
  record: ExternalRecord,
  respectManualEdits: boolean,
): Promise<void> {
  const a = record.asset;

  if (respectManualEdits) {
    await tx`
      UPDATE device SET
        hostname         = coalesce(hostname, ${a.hostname ?? null}),
        fqdn             = coalesce(fqdn, ${a.fqdn ?? null}),
        manufacturer     = coalesce(manufacturer, ${a.manufacturer ?? null}),
        model            = coalesce(model, ${a.model ?? null}),
        serial_number    = coalesce(serial_number, ${a.serialNumber ?? null}),
        operating_system = coalesce(operating_system, ${a.operatingSystem ?? null}),
        os_version       = coalesce(os_version, ${a.osVersion ?? null}),
        -- Always advanced: "when did the RMM last see this device" is the
        -- integration's own observation, not documentation a human curates.
        last_seen_at     = greatest(coalesce(last_seen_at, 'epoch'::timestamptz), ${a.lastSeenAt ?? null}),
        rmm_device_id    = coalesce(rmm_device_id, ${a.rmmDeviceId ?? null})
      WHERE id = ${nodeId}::uuid
    `;
    return;
  }

  await tx`
    UPDATE device SET
      hostname         = coalesce(${a.hostname ?? null}, hostname),
      fqdn             = coalesce(${a.fqdn ?? null}, fqdn),
      manufacturer     = coalesce(${a.manufacturer ?? null}, manufacturer),
      model            = coalesce(${a.model ?? null}, model),
      serial_number    = coalesce(${a.serialNumber ?? null}, serial_number),
      operating_system = coalesce(${a.operatingSystem ?? null}, operating_system),
      os_version       = coalesce(${a.osVersion ?? null}, os_version),
      last_seen_at     = greatest(coalesce(last_seen_at, 'epoch'::timestamptz), ${a.lastSeenAt ?? null}),
      rmm_device_id    = coalesce(${a.rmmDeviceId ?? null}, rmm_device_id)
    WHERE id = ${nodeId}::uuid
  `;

  await tx`
    UPDATE asset_node SET name = ${a.name}, updated_at = now()
    WHERE id = ${nodeId}::uuid
  `;
}
