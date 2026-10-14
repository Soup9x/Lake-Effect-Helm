import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import type { RunSummary } from '@/lib/sops/queries';
import { formatDate } from '@/lib/ui/format';
import { cn } from '@/lib/ui/cn';

/**
 * This client's checklist runs, open ones first.
 *
 * A SERVER COMPONENT — it reads nothing and does nothing, so there is no reason
 * to ship it. The ordering comes from the query (`listRunsForOrganization`),
 * which puts open runs above finished ones because an open run is work and a
 * finished one is a record.
 *
 * NO "START A RUN" BUTTON HERE, deliberately. Starting one means choosing a
 * procedure AND seeing which published version it would follow, and that is
 * visible on the procedure's own page where the version is. A button here would
 * have to open a procedure picker that then explains versioning, which is the
 * same screen one click further away.
 */
const TONE: Record<string, 'ok' | 'neutral' | 'brand' | 'warning'> = {
  completed: 'ok',
  abandoned: 'neutral',
  in_progress: 'brand',
  not_started: 'neutral',
  blocked: 'warning',
};

export function ChecklistRunsCard({ runs }: { runs: readonly RunSummary[] }) {
  const open = runs.filter((r) => r.status !== 'completed' && r.status !== 'abandoned');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="size-4 text-ink-faint" aria-hidden /> Checklists
          {open.length > 0 && <Badge tone="brand">{open.length} open</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-0">
        {runs.map((run) => {
          const finished = run.status === 'completed' || run.status === 'abandoned';
          return (
            <div
              key={run.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2 last:border-b-0"
            >
              <Link
                href={`/runs/${run.id}`}
                className={cn('min-w-0 flex-1 truncate text-sm', finished ? 'text-ink-muted' : 'text-ink hover:underline')}
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
                {run.ticketRef && `${run.ticketRef} · `}
                {finished
                  ? `finished ${formatDate(run.completedAt)}`
                  : `started ${formatDate(run.startedAt)}`}
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
