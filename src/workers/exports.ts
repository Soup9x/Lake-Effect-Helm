/**
 * Export rendering and expiry.
 *
 * Rendering runs in the background rather than in the request that asked for
 * it, for three reasons that are all about the secret-bearing case: a handover
 * pack for a 4,000-device client takes minutes, the four-eyes approval arrives
 * later than the request by design, and the render decrypts hundreds of
 * credentials — work that belongs in a process the web tier cannot be made to
 * do synchronously.
 *
 * The passphrase problem is the interesting one. A credential-bearing bundle is
 * encrypted under a passphrase generated at render time, and that passphrase is
 * never stored — not in export_job, not in the audit log, not on disk. But the
 * render happens in a worker with nobody watching, so the passphrase has to
 * reach a human somehow.
 *
 * The answer here is the same one the alert worker uses: an explicit delivery
 * channel, configured by the operator, with a default that does not silently
 * lose it. HELM_EXPORT_PASSPHRASE_SINK names where it goes; unset, the render
 * REFUSES to produce a credential-bearing bundle rather than encrypting one
 * under a passphrase nobody will ever see. A file that cannot be opened is not
 * a safer export, it is a failed handover discovered a week later.
 */
import { withTenant } from '../lib/db/client';
import { db } from '../lib/db/client';
import { getExportService } from '../lib/exports/service';
import { getExportStorage } from '../lib/exports/storage';
import type { ExportScope } from '../lib/exports/collect';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';

interface ExportBacklogRow {
  tenant_id: string;
  worker_actor_id: string;
  export_job_id: string;
  organization_id: string;
  kind: string;
  format: string;
  include_secrets: boolean;
  scope: ExportScope;
  requested_at: Date;
}

/**
 * Where a bundle passphrase is delivered.
 *
 * Deliberately an interface with no default implementation that "just logs and
 * moves on": a passphrase in a log file is a passphrase in every log aggregator
 * and every backup of them, which defeats encrypting the bundle at all.
 */
export interface PassphraseSink {
  readonly name: string;
  deliver(delivery: PassphraseDelivery): Promise<void>;
}

export interface PassphraseDelivery {
  readonly tenantId: string;
  readonly exportJobId: string;
  readonly organizationId: string;
  readonly kind: string;
  readonly passphrase: string;
  readonly requestedBy: string | null;
  readonly approvedBy: string | null;
}

/**
 * Writes each passphrase to its own mode-0600 file under a directory, named by
 * export job id, for an operator to collect and hand over out of band.
 *
 * The plainest thing that can work on-premises, and it is honest about what it
 * is: the passphrase is at rest on this host until somebody deletes it. Point
 * it at a directory on encrypted storage that is NOT part of the same backup
 * set as HELM_EXPORT_DIR — the whole scheme rests on the bundle and its
 * passphrase not travelling together.
 */
export class FilePassphraseSink implements PassphraseSink {
  readonly name = 'file';

  constructor(private readonly directory: string) {}

  async deliver(delivery: PassphraseDelivery): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(this.directory, `${delivery.exportJobId}.passphrase`),
      `${delivery.passphrase}\n`,
      { mode: 0o600, flag: 'wx' },
    );
  }
}

let passphraseSink: PassphraseSink | null = null;

export function resolvePassphraseSink(): PassphraseSink | null {
  if (passphraseSink) return passphraseSink;
  const directory = process.env.HELM_EXPORT_PASSPHRASE_DIR?.trim();
  passphraseSink = directory ? new FilePassphraseSink(directory) : null;
  return passphraseSink;
}

export function setPassphraseSink(next: PassphraseSink | null): void {
  passphraseSink = next;
}

export function renderExportsJob(): Job {
  return {
    name: 'exports.render',
    everyMs: 60 * 1000,
    lockKey: 0x48_45_4c_4d_05,
    run: renderExports,
  };
}

export function expireExportsJob(): Job {
  return {
    name: 'exports.expire',
    everyMs: 15 * 60 * 1000,
    lockKey: 0x48_45_4c_4d_06,
    run: expireExports,
  };
}

async function renderExports(ctx: JobContext): Promise<JobResult> {
  const backlog = await db('worker')<ExportBacklogRow[]>`SELECT * FROM helm.export_backlog(10)`;
  if (backlog.length === 0) return { idle: true };

  const exports = getExportService();
  const sink = resolvePassphraseSink();
  let rendered = 0;
  let failed = 0;
  let omitted = 0;

  for (const job of backlog) {
    if (ctx.stopping()) break;
    const log = ctx.log.child({ export: job.export_job_id, kind: job.kind });

    // Refuse before decrypting anything. Rendering a credential bundle whose
    // passphrase has nowhere to go produces a file that cannot be opened and an
    // audit trail saying every credential was read — the worst of both.
    if (job.include_secrets && !sink) {
      failed += 1;
      log.error('no passphrase sink configured; refusing to render a credential-bearing export', {
        remedy: 'set HELM_EXPORT_PASSPHRASE_DIR, or install a sink with setPassphraseSink()',
      });
      await markFailed(job, 'no passphrase delivery channel is configured on this server');
      continue;
    }

    const actor = {
      tenantId: job.tenant_id,
      actorId: job.worker_actor_id,
      actorType: 'service_account' as const,
    };

    try {
      const result = await exports.render(actor, {
        exportJobId: job.export_job_id,
        organizationId: job.organization_id,
        kind: job.kind,
        format: job.format,
        includeSecrets: job.include_secrets,
        scope: job.scope ?? {},
      });

      if (!result.rendered) {
        log.debug('another worker claimed this export');
        continue;
      }

      if (result.passphrase && sink) {
        await sink.deliver({
          tenantId: job.tenant_id,
          exportJobId: job.export_job_id,
          organizationId: job.organization_id,
          kind: job.kind,
          passphrase: result.passphrase,
          requestedBy: null,
          approvedBy: null,
        });
      }

      rendered += 1;
      omitted += result.omissions.length;

      log.info('export rendered', {
        omitted: result.omissions.length,
        encrypted: result.passphrase !== null,
        sink: sink?.name ?? 'none',
      });

      if (result.omissions.length > 0) {
        // Said at warn level because somebody has to act on it: those
        // credentials must be handed over another way.
        log.warn('export is incomplete', {
          omitted: result.omissions.length,
          reasons: [...new Set(result.omissions.map((o) => o.reason))],
        });
      }
    } catch (error) {
      failed += 1;
      log.error('render failed', describeError(error));
    }
  }

  return { counts: { rendered, failed, omitted } };
}

async function markFailed(job: ExportBacklogRow, message: string): Promise<void> {
  const actor = {
    tenantId: job.tenant_id,
    actorId: job.worker_actor_id,
    actorType: 'service_account' as const,
  };

  await withTenant(
    actor,
    async (tx) => {
      await tx`SELECT helm.begin_export_render(${job.export_job_id}::uuid)`;
      await tx`
        SELECT helm.finish_export_render(
          ${job.export_job_id}::uuid, 'failed'::export_status,
          NULL, NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, ${message}
        )
      `;
    },
    { role: 'worker' },
  );
}

/**
 * Retire artefacts past their TTL and delete the bytes.
 *
 * The database marks rows expired and returns their storage keys; the deletion
 * is driven by what it returned. A row marked expired while the file stays on
 * disk is exactly the failure the TTL exists to prevent, so a deletion that
 * fails is logged loudly rather than swallowed — the row is already expired, so
 * the file is now orphaned and needs a human.
 */
async function expireExports(ctx: JobContext): Promise<JobResult> {
  // Reuses the alert enumerator: it lists every active tenant, which is the
  // same set this job needs, rather than adding a fourth near-identical one.
  const tenants = await db('worker')<{ tenant_id: string; worker_actor_id: string }[]>`
    SELECT h.tenant_id, helm.worker_actor(h.tenant_id, 'system_export') AS worker_actor_id
    FROM audit_chain_head h
    JOIN tenant t ON t.id = h.tenant_id AND t.status = 'active'
    WHERE helm.worker_actor(h.tenant_id, 'system_export') IS NOT NULL
  `;

  const storage = getExportStorage();
  let expired = 0;
  let orphaned = 0;

  for (const tenant of tenants) {
    if (ctx.stopping()) break;

    const rows = await withTenant(
      { tenantId: tenant.tenant_id, actorId: tenant.worker_actor_id, actorType: 'service_account' },
      async (tx) => tx<{ export_job_id: string; storage_key: string | null }[]>`
        SELECT * FROM helm.expire_exports()
      `,
      { role: 'worker' },
    );

    for (const row of rows) {
      expired += 1;
      if (!row.storage_key) continue;
      try {
        await storage.remove(row.storage_key);
      } catch (error) {
        orphaned += 1;
        ctx.log.error('expired export bytes could not be deleted', {
          export: row.export_job_id,
          ...describeError(error),
        });
      }
    }
  }

  return { counts: { expired, orphaned }, idle: expired === 0 };
}
