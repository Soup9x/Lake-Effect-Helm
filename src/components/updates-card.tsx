'use client';

/**
 * Administration → Updates: which build this is, what is newer on GitHub, and
 * the commands that apply it.
 *
 * THE WEB TIER INSTALLS NOTHING ITSELF. "Update now" writes a request (1210)
 * that the updater on the host picks up — see deploy/updater.sh — and this
 * page follows it, through the restart, by asking every few seconds. Without
 * the updater the page shows the commands to run instead.
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle, CheckCircle2, ExternalLink, GitCommit, RefreshCw, TriangleAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyValueButton } from '@/components/copy-value-button';
import { apiFetch } from '@/lib/ui/api';
import { formatDate, formatDateTime } from '@/lib/ui/format';
import type { UpdateState, UpdateStatus } from '@/lib/updates/check';
import { openRequest, type UpdateRequest, type UpdaterState } from '@/lib/updates/requests';
import { InstallButtons, OpenRequest, UpdateHistory } from './update-install';

export interface UpdatesSnapshot {
  status: UpdateStatus;
  updater: UpdaterState;
  requests: UpdateRequest[];
}

/** How often the page asks while an update is queued or running. */
const FOLLOW_MS = 5000;

const STATE_BADGE: Record<UpdateState, { text: string; tone: BadgeTone }> = {
  available: { text: 'Update available', tone: 'warning' },
  up_to_date: { text: 'Up to date', tone: 'ok' },
  ahead: { text: 'Newer than GitHub', tone: 'neutral' },
  unknown_build: { text: 'Version unknown', tone: 'neutral' },
  disabled: { text: 'Checking off', tone: 'neutral' },
  error: { text: 'Check failed', tone: 'danger' },
};

function short(commit: string | null | undefined): string {
  return commit ? commit.slice(0, 7) : 'unknown';
}

// UTC, as elsewhere in Helm: rendered on the server and again in the browser,
// and a locale-formatted time would differ between the two.
const when = formatDateTime;

export function UpdatesCard({ initial }: { initial: UpdatesSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const { status, updater, requests } = snapshot;
  const open = openRequest(requests);

  const checkNow = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await apiFetch<UpdatesSnapshot>('/api/tenant/updates', { method: 'POST' });
      if (result.ok) setSnapshot(result.value);
      else setFailure(result.message);
    } finally {
      setBusy(false);
    }
  };

  const refresh = useCallback(async () => {
    const result = await apiFetch<UpdatesSnapshot>('/api/tenant/updates');
    // Nothing answering is what a restart looks like from here. Anything else
    // that is not ok (a 403 because the session ended, say) is left alone;
    // the next tick tries again.
    setRestarting(!result.ok && (result.status === 0 || result.status >= 500 || result.code === 'http'));
    if (result.ok) setSnapshot(result.value);
  }, []);

  // Follow a queued or running update until it finishes.
  const following = open !== null || restarting;
  useEffect(() => {
    if (!following) return;
    const timer = setInterval(() => void refresh(), FOLLOW_MS);
    return () => clearInterval(timer);
  }, [following, refresh]);

  const replace = (request: UpdateRequest) =>
    setSnapshot((s) => ({ ...s, requests: [request, ...s.requests.filter((r) => r.id !== request.id)] }));
  const history = requests.filter((r) => r !== open);

  const commands = [`cd ${status.installDir}`, 'git pull', 'sudo ./deploy/setup.sh'].join('\n');
  const badge = STATE_BADGE[status.state];
  const repoUrl = `https://github.com/${status.repo}`;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <ArrowUpCircle className="size-4 text-ink-faint" aria-hidden /> Helm version
            <Badge tone={badge.tone}>{badge.text}</Badge>
            {status.state !== 'disabled' && status.state !== 'unknown_build' && (
              <Button variant="secondary" size="sm" className="ml-auto" onClick={checkNow} disabled={busy}>
                <RefreshCw className={busy ? 'animate-spin' : undefined} aria-hidden />
                {busy ? 'Checking…' : 'Check now'}
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-ink-muted">Running</dt>
            <dd className="flex items-center gap-1.5">
              <GitCommit className="size-3.5 text-ink-faint" aria-hidden />
              {status.current.commit ? (
                <a
                  href={`${repoUrl}/commit/${status.current.commit}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-brand underline-offset-4 hover:underline"
                >
                  {short(status.current.commit)}
                </a>
              ) : (
                <span className="font-mono">unknown</span>
              )}
              {status.current.date && <span className="text-ink-muted">· {when(status.current.date)}</span>}
            </dd>
            {status.latest && status.state === 'available' && (
              <>
                <dt className="text-ink-muted">Latest on {status.branch}</dt>
                <dd className="flex items-center gap-1.5">
                  <GitCommit className="size-3.5 text-ink-faint" aria-hidden />
                  <a
                    href={`${repoUrl}/commit/${status.latest.commit}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-brand underline-offset-4 hover:underline"
                  >
                    {short(status.latest.commit)}
                  </a>
                  {status.latest.date && <span className="text-ink-muted">· {when(status.latest.date)}</span>}
                </dd>
              </>
            )}
            <dt className="text-ink-muted">Checks</dt>
            <dd>
              <a href={repoUrl} target="_blank" rel="noreferrer" className="text-brand underline-offset-4 hover:underline">
                {status.repo}
              </a>
              <span className="text-ink-muted">
                {' '}· {status.branch}{status.checkedAt && ` · last checked ${when(status.checkedAt)}`}
              </span>
            </dd>
          </dl>

          {status.state === 'up_to_date' && (
            <p className="flex items-center gap-2 text-ok">
              <CheckCircle2 className="size-4" aria-hidden /> This is the newest Helm on {status.branch}.
            </p>
          )}
          {status.state === 'ahead' && (
            <p className="text-ink-muted">
              This build has commits that are not on {status.branch} yet, so there is nothing newer to install.
            </p>
          )}
          {status.state === 'unknown_build' && (
            <p className="text-ink-muted">
              This Helm was built without recording which commit it came from, so it cannot tell whether it is
              behind. Update once with the commands below; deploy/setup.sh records the commit and checking starts
              from then on.
            </p>
          )}
          {status.state === 'disabled' && (
            <p className="text-ink-muted">
              Update checks are turned off (HELM_UPDATE_CHECK in .env). Helm does not contact GitHub.
            </p>
          )}
          {(status.state === 'error' || failure) && (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{failure ?? status.error}</span>
            </p>
          )}
        </CardContent>
      </Card>

      {status.state === 'available' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              What’s new
              <span className="text-sm font-normal text-ink-muted">
                {status.behindBy === 1 ? '1 commit' : `${status.behindBy} commits`} since this build
              </span>
              {status.compareUrl && (
                <a
                  href={status.compareUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex items-center gap-1 text-sm font-normal text-brand underline-offset-4 hover:underline"
                >
                  Full comparison on GitHub <ExternalLink className="size-3.5" aria-hidden />
                </a>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {status.changes.length > 0 ? (
              <ul className="divide-y divide-border text-sm">
                {status.changes.map((change) => (
                  <li key={change.sha} className="flex items-baseline gap-3 py-1.5">
                    <a
                      href={change.pr ? `${repoUrl}/pull/${change.pr}` : change.url}
                      target="_blank"
                      rel="noreferrer"
                      className="w-14 shrink-0 font-mono text-xs text-brand underline-offset-4 hover:underline"
                    >
                      {change.pr ? `#${change.pr}` : short(change.sha)}
                    </a>
                    <span className="min-w-0 flex-1 text-ink">{change.title}</span>
                    {change.date && (
                      <span className="shrink-0 text-xs text-ink-faint">
                        {formatDate(change.date)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">The comparison on GitHub lists the changes.</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Install the update</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {open && <OpenRequest request={open} restarting={restarting} onCancelled={replace} />}

          {!open && status.state === 'available' && status.latest && updater.installed && (
            <div className="space-y-2">
              <p className="text-ink-muted">
                Helm installs it itself: the updater on the server pulls {short(status.latest.commit)} from GitHub,
                rebuilds, applies any database migrations and restarts, keeping every setting from the last setup.
                Helm is unavailable for a few minutes while it restarts.
              </p>
              <InstallButtons latest={status.latest.commit} onRequested={replace} />
            </div>
          )}

          {!open && status.state === 'available' && status.migrations > 0 && (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                This update includes {status.migrations === 1 ? 'a database migration' : `${status.migrations} database migrations`}.
                They are applied during the update. A recent backup (Administration → Backups) is worth having first.
              </span>
            </p>
          )}

          {!updater.installed && (
            <p className="text-ink-muted">
              To install updates from this page, run setup.sh on the server once more and answer yes to
              {' '}<span className="font-medium text-ink">Allow updates from Helm’s Updates page?</span>
              {updater.lastSeenAt && <> The updater last checked in <span suppressHydrationWarning>{when(updater.lastSeenAt)}</span>, so it may have stopped.</>}
            </p>
          )}

          <div className="space-y-2">
            <p className="text-ink-muted">
              {updater.installed ? 'Or, on the Helm server in a terminal:' : 'On the Helm server, in a terminal:'}
            </p>
            <div className="flex items-start gap-2 rounded-md border border-border bg-surface-sunken p-3">
              <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-relaxed text-ink">{commands}</pre>
              <CopyValueButton value={commands} label="Copy the update commands" />
            </div>
          </div>
        </CardContent>
      </Card>

      {history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Updates from this page</CardTitle>
          </CardHeader>
          <CardContent>
            <UpdateHistory requests={history} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
