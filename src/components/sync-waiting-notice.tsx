'use client';

/**
 * Why a sync is not happening, in words (1310).
 *
 * Shown on an integration card when Helm's background worker has gone quiet,
 * or when a "Sync now" has sat queued for a couple of minutes. Before this,
 * the card said "Queued" and then nothing, forever, and the only way to find
 * out why was a shell on the Helm server.
 */
import { TriangleAlert } from 'lucide-react';
import { formatDateTime } from '@/lib/ui/format';
import { waitingReason, type RunLike, type WorkerLiveness } from '@/lib/integrations/worker-liveness';

const HOST_DIR = '/opt/lake-effect-helm';

function Command({ children }: { children: string }) {
  return (
    <code className="block overflow-x-auto whitespace-pre rounded bg-surface-sunken px-2 py-1 font-mono text-xs text-ink">
      {children}
    </code>
  );
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function SyncWaitingNotice({
  worker, jobName, runs, label,
}: {
  worker: WorkerLiveness | null;
  /** The worker job that runs this integration, e.g. 'ninja.sync'. */
  jobName: string;
  runs: readonly RunLike[];
  /** "NinjaOne", "Action1"… */
  label: string;
}) {
  const reason = waitingReason(worker, jobName, runs);
  if (!reason) return null;

  let headline: string;
  let detail: string;
  let restart = true;
  switch (reason.kind) {
    case 'never':
      headline = 'Helm’s background worker has not checked in since this update was installed.';
      detail = `Syncs run in the worker, so this ${label} sync will not start until it is running.`;
      break;
    case 'stale':
      headline = `Helm’s background worker last checked in ${plural(reason.minutes, 'minute')} ago (${formatDateTime(reason.seenAt)}).`;
      detail = 'It looks stopped or stuck, so syncs, reminders and notifications are not running. Check its log, then restart it.';
      break;
    case 'connecting':
      headline = `The ${label} sync has been waiting for a database connection for ${plural(reason.minutes, 'minute')}.`;
      detail = 'Every connection the worker has is held by other jobs that have not finished. Copy the log before restarting, so the stuck job can be found.';
      break;
    case 'busy':
      headline = `The ${label} sync job has been busy for ${plural(reason.minutes, 'minute')} (since ${formatDateTime(reason.since)}).`;
      detail = 'This request starts when it finishes. If it never does, it is stuck: check the log, then restart the worker.';
      break;
    case 'locked':
      headline = `Another Helm worker process has held the ${label} sync since ${formatDateTime(reason.since)}.`;
      detail = 'Usually a second worker left running, such as a one-off run that never exited. List the containers, stop the extra one, or restart the worker.';
      break;
    case 'not-picked-up':
      headline = `Queued ${plural(reason.minutes, 'minute')} ago and not picked up, although the worker is running.`;
      detail = 'The worker does not see this connection as due. Its log at debug level says why.';
      restart = false;
      break;
  }

  return (
    <div role="alert" className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
      <p className="flex items-start gap-2 font-medium text-warning">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {headline}
      </p>
      <p className="text-ink-muted">{detail}</p>
      <details className="text-ink-muted">
        <summary className="cursor-pointer text-xs">Commands to run on the Helm server</summary>
        <div className="mt-2 space-y-1">
          <Command>{`cd ${HOST_DIR}\nsudo docker compose ps\nsudo docker compose logs --since 2h worker | tail -n 200`}</Command>
          {restart && <Command>{'sudo docker compose restart worker'}</Command>}
          {!restart && <Command>{'sudo docker compose run --rm -e HELM_LOG_LEVEL=debug worker node dist/worker.mjs --once'}</Command>}
        </div>
      </details>
    </div>
  );
}
