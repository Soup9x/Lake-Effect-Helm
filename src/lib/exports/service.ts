/**
 * The export engine's application layer.
 *
 * Every state transition goes through a SECURITY DEFINER function in
 * db/sql/0310, so the audit row and the transition commit together and the
 * four-eyes rule is enforced by the database rather than by this file. What
 * lives here is the part that cannot live in SQL: decrypting secrets one at a
 * time through the audited reveal path, rendering, encrypting the bundle, and
 * handing the passphrase back exactly once.
 */
import type { ActorRef } from '../secrets/service';
import { withTenant, type HelmTx } from '../db/client';
import { ApiError } from '../api/errors';
import { getSecretService } from '../services';
import { SecretAccessDeniedError } from '../secrets/errors';
import { collectExport, type CollectedExport, type ExportScope } from './collect';
import { packBundle, type BundleEntry } from './bundle';
import { renderJson, renderPdf, type ExportOmission } from './render';
import { getExportStorage } from './storage';

export type ExportKind =
  | 'client_offboarding'
  | 'compliance_audit'
  | 'disaster_recovery'
  | 'asset_inventory'
  | 'ad_hoc';

export type ExportFormat = 'pdf' | 'json' | 'zip';

export interface RequestExportInput {
  readonly organizationId: string;
  readonly kind: ExportKind;
  readonly format: ExportFormat;
  readonly reason: string;
  readonly includeSecrets?: boolean;
  readonly scope?: ExportScope;
  readonly ttlHours?: number;
}

export interface ExportJobSummary {
  id: string;
  organizationId: string;
  organizationName: string;
  kind: string;
  format: string;
  status: string;
  includeSecrets: boolean;
  reason: string;
  requestedBy: string | null;
  requestedByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  completedAt: Date | null;
  byteSize: number | null;
  recordCount: number | null;
  secretCount: number | null;
  omittedSecretCount: number;
  downloadedCount: number;
  contentSha256: string | null;
  encryptionMethod: string | null;
  error: string | null;
  /** True when this actor may approve it: has the permission and did not request it. */
  awaitingMyApproval: boolean;
}

export class ExportService {
  /**
   * Create a job. A secret-bearing one is parked until a second person approves
   * it — the job is `queued` either way, and helm.export_backlog() is the single
   * place that decides what the worker may pick up.
   */
  async request(actor: ActorRef, input: RequestExportInput): Promise<{ exportJobId: string; needsApproval: boolean }> {
    return withTenant(actor, (tx) => this.requestInTransaction(tx, input));
  }

  /**
   * The same request, in a transaction the caller already owns.
   *
   * Exists for bulk export, which queues one job per client and must not leave
   * three of five behind when the fourth fails — `request()` opens its own
   * transaction, so a loop over it commits as it goes and there is no way back.
   * Sharing the caller's transaction makes the whole batch one unit, the same
   * reason SecretService has createInTransaction.
   */
  async requestInTransaction(
    tx: HelmTx,
    input: RequestExportInput,
  ): Promise<{ exportJobId: string; needsApproval: boolean }> {
    const [row] = await tx<{ export_job_id: string; needs_approval: boolean }[]>`
      SELECT * FROM helm.request_export(
        ${input.organizationId}::uuid,
        ${input.kind}::export_kind,
        ${input.format},
        ${input.reason},
        ${input.includeSecrets ?? false},
        ${tx.json(toJson(input.scope ?? {}))}::jsonb,
        ${input.ttlHours ?? 72}
      )
    `;
    if (!row) throw new Error('request_export returned no row');
    return { exportJobId: row.export_job_id, needsApproval: row.needs_approval };
  }

  /** The second pair of eyes. The database refuses self-approval; so does this. */
  async approve(actor: ActorRef, exportJobId: string, reason?: string): Promise<void> {
    await withTenant(actor, async (tx) => {
      await tx`SELECT helm.approve_export(${exportJobId}::uuid, ${reason ?? null})`;
    });
  }

  async revoke(actor: ActorRef, exportJobId: string, reason: string): Promise<boolean> {
    return withTenant(actor, async (tx) => {
      const [row] = await tx<{ revoked: boolean }[]>`
        SELECT helm.revoke_export(${exportJobId}::uuid, ${reason}) AS revoked
      `;
      return row?.revoked ?? false;
    });
  }

  async list(
    actor: ActorRef,
    filter: { organizationId?: string; status?: string; limit?: number } = {},
  ): Promise<ExportJobSummary[]> {
    return withTenant(actor, async (tx) => {
      const rows = await tx<RawJobRow[]>`
        SELECT j.*, o.name AS organization_name,
               req.name AS requested_by_name, app.name AS approved_by_name
        FROM export_job j
        JOIN organization o ON o.id = j.organization_id
        LEFT JOIN app_user req ON req.id = j.requested_by
        LEFT JOIN app_user app ON app.id = j.approved_by
        WHERE (${filter.organizationId ?? null}::uuid IS NULL
               OR j.organization_id = ${filter.organizationId ?? null}::uuid)
          AND (${filter.status ?? null}::text IS NULL
               OR j.status::text = ${filter.status ?? null})
        ORDER BY j.created_at DESC
        LIMIT ${Math.min(Math.max(filter.limit ?? 50, 1), 200)}
      `;
      return rows.map((row) => toSummary(row, actor));
    });
  }

  async get(actor: ActorRef, exportJobId: string): Promise<ExportJobSummary> {
    return withTenant(actor, async (tx) => {
      const [row] = await tx<RawJobRow[]>`
        SELECT j.*, o.name AS organization_name,
               req.name AS requested_by_name, app.name AS approved_by_name
        FROM export_job j
        JOIN organization o ON o.id = j.organization_id
        LEFT JOIN app_user req ON req.id = j.requested_by
        LEFT JOIN app_user app ON app.id = j.approved_by
        WHERE j.id = ${exportJobId}::uuid
      `;
      if (!row) throw ApiError.notFound('no such export');
      return toSummary(row, actor);
    });
  }

  /**
   * Authorise a download and return the bytes.
   *
   * helm.claim_export_download writes the export_download row and the audit
   * event in the same transaction that authorises the read, then the bytes are
   * fetched. A crash between the two over-records rather than under-records,
   * which is the correct direction for an audit trail.
   */
  async download(
    actor: ActorRef,
    exportJobId: string,
    request: { ip?: string; userAgent?: string } = {},
  ): Promise<{ bytes: Buffer; filename: string; contentType: string; sha256: string; encrypted: boolean }> {
    const claim = await withTenant(actor, async (tx) => {
      const [row] = await tx<ClaimRow[]>`
        SELECT * FROM helm.claim_export_download(
          ${exportJobId}::uuid, ${request.ip ?? null}::inet, ${request.userAgent ?? null}
        )
      `;
      if (!row) throw new Error('claim_export_download returned no row');

      if (!row.granted) return row;

      const [job] = await tx<{ kind: string; organization_name: string; created_at: Date }[]>`
        SELECT j.kind::text, o.name AS organization_name, j.created_at
        FROM export_job j JOIN organization o ON o.id = j.organization_id
        WHERE j.id = ${exportJobId}::uuid
      `;
      return { ...row, job };
    });

    if (!claim.granted) {
      throw mapDownloadDenial(claim.denial_reason);
    }
    if (!claim.storage_key) throw ApiError.notFound('no such export');

    const bytes = await getExportStorage().get(claim.storage_key);

    const job = (claim as { job?: { kind: string; organization_name: string; created_at: Date } }).job;
    const slug = (job?.organization_name ?? 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const day = (job?.created_at ?? new Date()).toISOString().slice(0, 10);

    return {
      bytes,
      filename: `helm-${slug}-${job?.kind ?? 'export'}-${day}.helmbundle`,
      contentType: 'application/octet-stream',
      sha256: claim.content_sha256?.toString('hex') ?? '',
      encrypted: claim.encryption_method !== null,
    };
  }

  /**
   * Render one approved job. Called by the worker, as the export service
   * account, whose reveal purposes are pinned to 'export'.
   *
   * Returns the passphrase for a credential-bearing bundle. The caller stores it
   * nowhere: it goes back to the requester through the same response that told
   * them the render finished, and is then gone.
   */
  async render(
    actor: ActorRef,
    job: RenderableJob,
  ): Promise<{ rendered: boolean; passphrase: string | null; omissions: ExportOmission[] }> {
    const claimed = await withTenant(
      actor,
      async (tx) => {
        const [row] = await tx<{ claimed: boolean }[]>`
          SELECT helm.begin_export_render(${job.exportJobId}::uuid) AS claimed
        `;
        return row?.claimed ?? false;
      },
      { role: 'worker' },
    );

    if (!claimed) return { rendered: false, passphrase: null, omissions: [] };

    try {
      const collected = await withTenant(
        actor,
        async (tx) => collectExport(tx, job.organizationId, job.scope),
        { role: 'worker' },
      );

      const omissions: ExportOmission[] = [];
      let secretCount = 0;

      if (job.includeSecrets) {
        secretCount = await this.#fillSecrets(actor, collected, omissions);
      }

      const options = {
        kind: job.kind,
        includeSecrets: job.includeSecrets,
        reason: job.reason,
        requestedBy: job.requestedByName ?? 'unknown',
        approvedBy: job.approvedByName,
        omissions,
      };

      const entries: BundleEntry[] = [
        { name: 'export.json', contentType: 'application/json', bytes: renderJson(collected, options) },
        { name: 'export.pdf', contentType: 'application/pdf', bytes: renderPdf(collected, options) },
      ];

      const packed = packBundle(entries, job.includeSecrets);
      const storageKey = await getExportStorage().put(packed.bytes);

      const recordCount =
        collected.assets.length +
        collected.credentials.length +
        collected.sites.length +
        collected.contacts.length +
        collected.procedures.length +
        collected.flexibleAssets.length;

      await withTenant(
        actor,
        async (tx) => tx`
          SELECT helm.finish_export_render(
            ${job.exportJobId}::uuid, 'completed'::export_status,
            ${storageKey}, ${packed.bytes.length}, ${packed.sha256},
            ${packed.encryptionMethod}, ${recordCount}, ${secretCount},
            ${tx.json(toJson(omissions))}::jsonb, NULL
          )
        `,
        { role: 'worker' },
      );

      return { rendered: true, passphrase: packed.passphrase, omissions };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await withTenant(
        actor,
        async (tx) => tx`
          SELECT helm.finish_export_render(
            ${job.exportJobId}::uuid, 'failed'::export_status,
            NULL, NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, ${message}
          )
        `,
        { role: 'worker' },
      );
      throw error;
    }
  }

  /**
   * Decrypt each credential in the bundle, one audited reveal at a time.
   *
   * A refusal is RECORDED, not swallowed. The two that actually happen:
   *
   *   step_up_required — a machine identity can never satisfy an interactive
   *   re-authentication, so the most sensitive credentials are, correctly,
   *   unreachable to an automated export. The handover says so on its cover
   *   page and the receiving team knows to ask for those separately.
   *
   *   insufficient_role_rank — a credential pinned above the export worker's
   *   rank. Same treatment.
   *
   * Continuing past a refusal is deliberate: an offboarding pack that fails
   * entirely because one break-glass credential needs step-up helps nobody.
   */
  async #fillSecrets(
    actor: ActorRef,
    collected: CollectedExport,
    omissions: ExportOmission[],
  ): Promise<number> {
    const secrets = getSecretService();
    let revealed = 0;

    for (const credential of collected.credentials) {
      for (const [field, secretId] of [
        ['material', credential.secret_id],
        ['totp_seed', credential.totp_secret_id],
      ] as const) {
        if (!secretId) continue;

        try {
          const result = await secrets.reveal(actor, secretId, {
            purpose: 'export',
            reason: 'compliance/offboarding export render',
            role: 'worker',
          });
          try {
            credential[field] = result.value.expose();
            revealed += 1;
          } finally {
            result.value.dispose();
          }
        } catch (error) {
          if (!(error instanceof SecretAccessDeniedError)) throw error;
          omissions.push({
            secretId,
            label: `${credential.name}${field === 'totp_seed' ? ' (TOTP seed)' : ''}`,
            reason: error.reason,
          });
        }
      }
    }

    return revealed;
  }
}

export interface RenderableJob {
  readonly exportJobId: string;
  readonly organizationId: string;
  readonly kind: string;
  readonly format: string;
  readonly includeSecrets: boolean;
  readonly scope: ExportScope;
  readonly reason: string;
  /**
   * Who stands behind this export. Supplied by helm.export_backlog() rather
   * than looked up here, because the render worker deliberately has no
   * user:read — it would have to be handed the tenant's staff directory to put
   * two names on a cover page. See db/sql/0330_export_render_context.sql.
   */
  readonly requestedByName: string | null;
  readonly approvedByName: string | null;
}

interface RawJobRow {
  id: string;
  organization_id: string;
  organization_name: string;
  kind: string;
  format: string;
  status: string;
  include_secrets: boolean;
  reason: string;
  requested_by: string | null;
  requested_by_name: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: Date | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  completed_at: Date | null;
  byte_size: string | null;
  record_count: number | null;
  secret_count: number | null;
  omitted_secret_count: number;
  downloaded_count: number;
  content_sha256: Buffer | null;
  encryption_method: string | null;
  error: string | null;
}

interface ClaimRow {
  granted: boolean;
  denial_reason: string | null;
  storage_key: string | null;
  byte_size: string | null;
  content_sha256: Buffer | null;
  encryption_method: string | null;
  download_number: number | null;
}

function toSummary(row: RawJobRow, actor: ActorRef): ExportJobSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    kind: row.kind,
    format: row.format,
    status: row.status,
    includeSecrets: row.include_secrets,
    reason: row.reason,
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    completedAt: row.completed_at,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    recordCount: row.record_count,
    secretCount: row.secret_count,
    omittedSecretCount: row.omitted_secret_count,
    downloadedCount: row.downloaded_count,
    contentSha256: row.content_sha256?.toString('hex') ?? null,
    encryptionMethod: row.encryption_method,
    error: row.error,
    // A hint for the UI only. The database is what actually refuses, so a
    // client that ignores this and calls approve anyway is still refused.
    awaitingMyApproval:
      row.include_secrets &&
      row.approved_by === null &&
      row.status === 'queued' &&
      row.revoked_at === null &&
      row.requested_by !== actor.actorId,
  };
}

function mapDownloadDenial(reason: string | null): ApiError {
  switch (reason) {
    case 'not_found':
      return ApiError.notFound('no such export');
    case 'revoked':
      return ApiError.notFound('this export has been revoked');
    case 'expired':
      return ApiError.notFound('this export has expired');
    case 'not_ready':
      return ApiError.conflict('this export has not finished rendering');
    case 'no_artefact':
      return ApiError.conflict('this export produced no file');
    case 'secret_export_not_permitted':
      return ApiError.forbidden('your role does not permit downloading an export containing credentials');
    default:
      return ApiError.forbidden('you may not download this export');
  }
}

/**
 * postgres.js types its json() helper against a recursive JSONValue, which our
 * own interfaces do not structurally satisfy (no index signature). The values
 * here are plain data by construction — scope objects and omission records —
 * so this is a typing accommodation, not a claim about unchecked content.
 */
function toJson(value: unknown): Parameters<HelmTx['json']>[0] {
  return JSON.parse(JSON.stringify(value)) as Parameters<HelmTx['json']>[0];
}

let service: ExportService | null = null;

export function getExportService(): ExportService {
  service ??= new ExportService();
  return service;
}
