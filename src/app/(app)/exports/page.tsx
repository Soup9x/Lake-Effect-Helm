import { FileDown } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { getExportService } from '@/lib/exports/service';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { ExportRequestForm } from '@/components/export-request-form';
import {
  ApproveExportButton,
  DownloadExportButton,
  RevokeExportButton,
} from '@/components/export-actions';
import { formatBytes, formatDateTime, humanise } from '@/lib/ui/format';

function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'running':
      return 'brand';
    case 'failed':
      return 'danger';
    case 'revoked':
    case 'expired':
      return 'neutral';
    default:
      return 'notice';
  }
}

/**
 * The export ledger, and the queue of things waiting for a second person.
 *
 * Readable by anyone who may create an export rather than only by the person
 * who made each one: "who exported this client's credentials, when, and who
 * approved it" is a question the whole team should be able to answer without
 * asking an administrator to run a query.
 */
export default async function ExportsPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const identity = await getServerIdentity();
  const params = await searchParams;
  const actor = actorOf(identity);

  const [exports, { organizations, permissions }] = await Promise.all([
    getExportService().list(actor, { limit: 100 }),
    withTenant(actor, async (tx) => {
      const [organizationRows, permissionRows] = await Promise.all([
        tx<{ id: string; name: string }[]>`
          SELECT id, name FROM organization WHERE deleted_at IS NULL ORDER BY name
        `,
        tx<{ permissions: string[] }[]>`
          SELECT string_to_array(current_setting('helm.permissions', true), ',') AS permissions
        `,
      ]);
      return {
        organizations: organizationRows,
        permissions: new Set(permissionRows[0]?.permissions ?? []),
      };
    }),
  ]);

  const awaitingApproval = exports.filter((job) => job.awaitingMyApproval);
  const canApprove = permissions.has('export:approve');

  return (
    <>
      <PageHeader
        title="Exports"
        description="Compliance packs and client handovers. Anything containing credentials needs a second approver."
      />
      <PageBody>
        {awaitingApproval.length > 0 && canApprove && (
          <Card className="border-sev-warning/40">
            <CardHeader>
              <CardTitle>
                {awaitingApproval.length} credential{' '}
                {awaitingApproval.length === 1 ? 'export needs' : 'exports need'} your review
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {awaitingApproval.map((job) => (
                <div
                  key={job.id}
                  className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4 last:border-0 last:pb-0"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="font-medium text-ink">
                      {job.organizationName} · {humanise(job.kind)}
                    </div>
                    <p className="max-w-xl text-sm text-ink-muted">{job.reason}</p>
                    <p className="text-xs text-ink-faint">
                      Requested by {job.requestedByName ?? 'unknown'} ·{' '}
                      {formatDateTime(job.createdAt)}
                    </p>
                  </div>
                  <ApproveExportButton exportJobId={job.id} disabled={false} />
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <ExportRequestForm
          organizations={organizations}
          canExportSecrets={permissions.has('secret:export')}
          defaultOrganizationId={params.organizationId}
        />

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardContent className={exports.length === 0 ? 'p-0' : 'space-y-4'}>
            {exports.length === 0 ? (
              <EmptyState
                icon={FileDown}
                title="No exports yet"
                description="Every export is recorded here permanently, including who requested it, who approved it and who downloaded it."
              />
            ) : (
              exports.map((job) => (
                <div
                  key={job.id}
                  className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4 last:border-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{job.organizationName}</span>
                      <Badge tone={statusTone(job.status)}>{job.status}</Badge>
                      <Badge tone="neutral">{humanise(job.kind)}</Badge>
                      {job.includeSecrets && <Badge tone="critical">Credentials</Badge>}
                      {job.omittedSecretCount > 0 && (
                        <Badge tone="warning">{job.omittedSecretCount} omitted</Badge>
                      )}
                    </div>

                    <p className="max-w-2xl text-sm text-ink-muted">{job.reason}</p>

                    <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-faint">
                      <div>
                        Requested by{' '}
                        <span className="text-ink-muted">{job.requestedByName ?? '—'}</span>{' '}
                        {formatDateTime(job.createdAt)}
                      </div>
                      {job.approvedByName && (
                        <div>
                          Approved by{' '}
                          <span className="text-ink-muted">{job.approvedByName}</span>{' '}
                          {formatDateTime(job.approvedAt)}
                        </div>
                      )}
                      {job.status === 'completed' && (
                        <>
                          <div>
                            {job.recordCount ?? 0} records
                            {job.includeSecrets ? `, ${job.secretCount ?? 0} credentials` : ''}
                          </div>
                          <div>{formatBytes(job.byteSize)}</div>
                          <div>
                            {job.downloadedCount} download
                            {job.downloadedCount === 1 ? '' : 's'}
                          </div>
                          <div>Expires {formatDateTime(job.expiresAt)}</div>
                        </>
                      )}
                      {job.error && <div className="text-danger">{job.error}</div>}
                    </dl>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {job.status === 'completed' && !job.revokedAt && (
                      <DownloadExportButton
                        exportJobId={job.id}
                        filename={`helm-${job.organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${job.kind}.helmbundle`}
                        encrypted={job.encryptionMethod !== null}
                      />
                    )}
                    {job.awaitingMyApproval && canApprove && (
                      <ApproveExportButton exportJobId={job.id} disabled={false} />
                    )}
                    {job.includeSecrets &&
                      !job.approvedBy &&
                      job.status === 'queued' &&
                      !job.awaitingMyApproval && (
                        <span className="text-xs text-ink-faint">
                          {canApprove
                            ? 'You requested this — someone else must approve it'
                            : 'Awaiting approval'}
                        </span>
                      )}
                    {['queued', 'running', 'completed'].includes(job.status) && !job.revokedAt && (
                      <RevokeExportButton exportJobId={job.id} />
                    )}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
