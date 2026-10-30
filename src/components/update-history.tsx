'use client';

/**
 * Administration → Updates → History: every version this server has run
 * (1230), and the update requests from the page that did not end in one.
 *
 * Each version says who put it there — the Helm user who pressed the button,
 * or "on the server" with the account that ran setup.sh by hand — when, which
 * commit and pull requests it brought, and the log when there is one.
 */
import { CheckCircle2, ExternalLink, GitCommit, Server, User, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { DeployEntry } from '@/lib/updates/history';
import type { UpdateRequest } from '@/lib/updates/requests';
import { LocalTime, LogTail } from './update-install';

type Entry =
  | { kind: 'deploy'; at: string; deploy: DeployEntry }
  | { kind: 'request'; at: string; request: UpdateRequest };

const short = (commit: string | null) => (commit ? commit.slice(0, 7) : '?');

export function UpdateTimeline({
  deploys,
  requests,
  repo,
}: {
  deploys: readonly DeployEntry[];
  requests: readonly UpdateRequest[];
  repo: string;
}) {
  // A request that installed something is told through its version; the rest
  // (failed, cancelled) are worth seeing in the same list, in order.
  const installed = new Set(deploys.map((d) => d.updateId).filter(Boolean));
  const entries: Entry[] = [
    ...deploys.map((deploy): Entry => ({ kind: 'deploy', at: deploy.deployedAt, deploy })),
    ...requests
      .filter((r) => (r.status === 'failed' || r.status === 'cancelled') && !installed.has(r.id))
      .map((request): Entry => ({ kind: 'request', at: request.finishedAt ?? request.requestedAt, request })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  if (entries.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        Nothing recorded yet. Each update is added here when deploy/setup.sh finishes starting the new version,
        whether it was run from this page or by hand on the server.
      </p>
    );
  }

  const repoUrl = `https://github.com/${repo}`;
  const latest = deploys[0]?.id;

  return (
    <ol className="divide-y divide-border text-sm">
      {entries.map((entry) =>
        entry.kind === 'deploy'
          ? <DeployRow key={entry.deploy.id} deploy={entry.deploy} repoUrl={repoUrl} current={entry.deploy.id === latest} />
          : <RequestRow key={entry.request.id} request={entry.request} />)}
    </ol>
  );
}

function DeployRow({ deploy, repoUrl, current }: { deploy: DeployEntry; repoUrl: string; current: boolean }) {
  const compare = deploy.previousCommit
    ? `${repoUrl}/compare/${deploy.previousCommit}...${deploy.commit}`
    : `${repoUrl}/commit/${deploy.commit}`;
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <CheckCircle2 className="size-4 shrink-0 text-ok" aria-hidden />
        <span className="font-medium text-ink">Update {deploy.iteration}</span>
        {current && <Badge tone="ok">Running now</Badge>}
        <a
          href={`${repoUrl}/commit/${deploy.commit}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono text-xs text-brand underline-offset-4 hover:underline"
        >
          <GitCommit className="size-3.5" aria-hidden />
          {deploy.previousCommit ? `${short(deploy.previousCommit)} → ` : ''}{short(deploy.commit)}
        </a>
        <span className="ml-auto text-ink-muted"><LocalTime iso={deploy.deployedAt} /></span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-7 text-ink-muted">
        {deploy.title && <span className="text-ink">{deploy.title}</span>}
        <span className="inline-flex items-center gap-1">
          {deploy.source === 'page' ? (
            <>
              <User className="size-3.5" aria-hidden />
              {deploy.requestedBy ?? 'a Helm user'} · from the Updates page
            </>
          ) : (
            <>
              <Server className="size-3.5" aria-hidden />
              On the server (setup.sh{deploy.hostUser ? `, by ${deploy.hostUser}` : ''})
            </>
          )}
        </span>
      </div>

      <div className="space-y-1 pl-7">
        {deploy.changes.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink">
              {deploy.changes.length === 1 ? '1 change' : `${deploy.changes.length} changes`}
            </summary>
            <ul className="mt-1 space-y-0.5">
              {deploy.changes.map((change, i) => (
                <li key={`${change.pr ?? 'c'}-${i}`} className="flex gap-2">
                  {change.pr ? (
                    <a
                      href={`${repoUrl}/pull/${change.pr}`}
                      target="_blank"
                      rel="noreferrer"
                      className="w-12 shrink-0 font-mono text-xs text-brand underline-offset-4 hover:underline"
                    >
                      #{change.pr}
                    </a>
                  ) : (
                    <span className="w-12 shrink-0" />
                  )}
                  <span className="text-ink">{change.title}</span>
                </li>
              ))}
            </ul>
            <a
              href={compare}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-brand underline-offset-4 hover:underline"
            >
              On GitHub <ExternalLink className="size-3" aria-hidden />
            </a>
          </details>
        )}
        {deploy.log ? (
          <details>
            <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink">Show the log</summary>
            <LogTail log={deploy.log} />
          </details>
        ) : deploy.source === 'setup' && (
          <p className="text-xs text-ink-faint">Run by hand, so its output stayed in that terminal.</p>
        )}
      </div>
    </li>
  );
}

function RequestRow({ request }: { request: UpdateRequest }) {
  const failed = request.status === 'failed';
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <XCircle className={failed ? 'size-4 shrink-0 text-danger' : 'size-4 shrink-0 text-ink-faint'} aria-hidden />
        <span className="font-medium text-ink">{failed ? 'Update failed' : 'Update cancelled'}</span>
        <span className="font-mono text-xs text-ink-muted">{short(request.targetCommit)}</span>
        <span className="ml-auto text-ink-muted"><LocalTime iso={request.finishedAt ?? request.requestedAt} /></span>
      </div>
      <div className="space-y-1 pl-7 text-ink-muted">
        <span className="inline-flex items-center gap-1">
          <User className="size-3.5" aria-hidden />
          {request.requestedBy ?? 'a Helm user'} · from the Updates page
        </span>
        {request.error && <p className="text-danger">{request.error}</p>}
        {request.log && (
          <details>
            <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink">Show the log</summary>
            <LogTail log={request.log} />
          </details>
        )}
      </div>
    </li>
  );
}
