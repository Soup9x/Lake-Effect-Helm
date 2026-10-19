'use client';

/**
 * Checklist runs, in three tabs: Open, Completed and Abandoned.
 *
 * ON A CLIENT'S PAGE it is that client's runs of every procedure; ON A
 * PROCEDURE'S PAGE it is every run of that procedure, with the client each was
 * for. A completed run is the record of what was done, by whom and when — the
 * tab exists so that record can be found again, rather than scrolling past
 * every open run to reach it.
 *
 * The rows come from one query (listRunsForOrganization / listRunsForSop) and
 * are split here, so switching tabs is instant and the counts on the tabs are
 * the rows behind them.
 *
 * NO "START A RUN" BUTTON on the client's card, deliberately. Starting one means
 * choosing a procedure AND seeing which published version it would follow, and
 * that is visible on the procedure's own page where the version is.
 */
import { useState } from 'react';
import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import type { RunSummary } from '@/lib/sops/queries';
import { formatDate } from '@/lib/ui/format';
import { cn } from '@/lib/ui/cn';

const TONE: Record<string, 'ok' | 'neutral' | 'brand' | 'warning'> = {
  completed: 'ok',
  abandoned: 'neutral',
  in_progress: 'brand',
  not_started: 'neutral',
  blocked: 'warning',
};

type Tab = 'open' | 'completed' | 'abandoned';
const TABS: readonly [Tab, string][] = [['open', 'Open'], ['completed', 'Completed'], ['abandoned', 'Abandoned']];

const tabOf = (status: string): Tab =>
  status === 'completed' ? 'completed' : status === 'abandoned' ? 'abandoned' : 'open';

export function ChecklistRunsCard({
  runs,
  title = 'Checklists',
  showClient = false,
}: {
  runs: readonly RunSummary[];
  title?: string;
  /** On a procedure's page: name the client each run was for. */
  showClient?: boolean;
}) {
  const counts: Record<Tab, number> = { open: 0, completed: 0, abandoned: 0 };
  for (const run of runs) counts[tabOf(run.status)] += 1;
  // Opens on the open runs when there are any: those are work.
  const [tab, setTab] = useState<Tab>(counts.open > 0 || counts.completed === 0 ? 'open' : 'completed');
  const shown = runs
    .filter((r) => tabOf(r.status) === tab)
    // Finished ones newest first; open ones as the query ordered them.
    .sort((a, b) => (tab === 'open' ? 0 : (b.completedAt ?? b.startedAt ?? '').localeCompare(a.completedAt ?? a.startedAt ?? '')));

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="size-4 text-ink-faint" aria-hidden /> {title}
          {counts.open > 0 && <Badge tone="brand">{counts.open} open</Badge>}
        </CardTitle>
        <div className="flex gap-1" role="tablist" aria-label="Which runs">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs',
                tab === key
                  ? 'border-transparent bg-brand font-medium text-on-brand'
                  : 'border-border text-ink-muted hover:border-border-strong hover:text-ink',
              )}
            >
              {label} <span className="tabular-nums opacity-80">{counts[key]}</span>
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-0">
        {shown.length === 0 && (
          <p className="text-sm text-ink-faint">
            {tab === 'open' ? 'No open runs.' : tab === 'completed' ? 'No completed runs yet.' : 'No abandoned runs.'}
          </p>
        )}
        {shown.map((run) => {
          const finished = run.status === 'completed' || run.status === 'abandoned';
          return (
            <div
              key={run.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2 last:border-b-0"
            >
              <Link
                href={`/runs/${run.id}`}
                className={cn('min-w-0 flex-1 truncate text-sm hover:underline', finished ? 'text-ink-muted' : 'text-ink')}
              >
                {run.title}
              </Link>
              <Badge tone={TONE[run.status] ?? 'neutral'}>{run.status.replace(/_/g, ' ')}</Badge>
              <span className="tabular-nums text-xs text-ink-muted">
                {run.doneSteps}/{run.totalSteps}
                {!finished && run.remainingRequired > 0 && (
                  <span className="text-sev-warning">
                    {' '}· {run.remainingRequired} required left
                  </span>
                )}
              </span>
              <span className="text-xs text-ink-faint">
                {showClient && `${run.organizationName} · `}
                {run.ticketRef && `${run.ticketRef} · `}
                {run.status === 'completed'
                  ? `completed ${formatDate(run.completedAt)}${run.completedBy ? ` by ${run.completedBy}` : ''}`
                  : `started ${formatDate(run.startedAt)}`}
                {!finished && run.assignedTo && ` · ${run.assignedTo}`}
                {/*
                  The run's own due date, not a step's. A step can be due
                  sooner than the run, and surfacing the earliest step date
                  here would make this line disagree with the run page — so it
                  says what the run says, and My Tasks is where per-step dates
                  are the subject.
                */}
                {!finished && run.dueAt && ` · due ${formatDate(run.dueAt)}`}
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
