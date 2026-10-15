import Link from 'next/link';
import { CalendarClock, CheckCircle2, UserRound } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { listMyTasks, type TaskFilters } from '@/lib/sops/queries';
import { formatDateTime } from '@/lib/ui/format';
import { cn } from '@/lib/ui/cn';

export const dynamic = 'force-dynamic';

/**
 * My Tasks — the parity item "tasks assigned to me", and the first page in Helm
 * that is about a PERSON rather than a client.
 *
 * DEFAULTS TO INCOMPLETE AND MINE, which is the whole point: a list that opens
 * on everything ever assigned is a list nobody reads twice. The filters widen
 * it from there, and each one is a link rather than a control, so a particular
 * view can be bookmarked and sent to somebody.
 *
 * "MINE" IS RESOLVED IN SQL, not from a parameter. listMyTasks compares against
 * helm.current_actor_id(), so there is no id in the URL to change and no way to
 * ask for somebody else's list by editing one. `who=anyone` drops the predicate
 * entirely and lets RLS answer — which for a client-side role is their own
 * organisation's runs and nothing else.
 *
 * A TASK IS A STEP, NOT A RUN. The unit of work somebody is handed is one step
 * — "forward the mailbox" — and a run can be split across several people. So
 * this lists steps and names the run each belongs to, rather than listing runs
 * and making somebody open each one to find their part.
 *
 * STILL-LIVE RUNS ONLY, for the open filter. A pending step on an ABANDONED run
 * is not work: the run was given up on, and listing its steps would be the
 * product arguing with itself about whether that decision counted.
 */
const STATES: { key: NonNullable<TaskFilters['state']>; label: string }[] = [
  { key: 'open', label: 'To do' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'all', label: 'Everything' },
];

function isState(value: unknown): value is NonNullable<TaskFilters['state']> {
  return value === 'open' || value === 'overdue' || value === 'all';
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await getServerIdentity();
  const params = await searchParams;

  // An unrecognised filter falls back to the default rather than erroring: a
  // stale link should show the list, which is the same rule the client list
  // applies to a type it no longer has.
  const state = isState(params.state) ? params.state : 'open';
  const who = params.who === 'anyone' ? 'anyone' : 'mine';

  const tasks = await withTenant(actorOf(identity), (tx) =>
    listMyTasks(tx, { who, state }));

  const href = (next: { state?: string; who?: string }) => {
    const query = new URLSearchParams();
    const s = next.state ?? state;
    const w = next.who ?? who;
    if (s !== 'open') query.set('state', s);
    if (w !== 'mine') query.set('who', w);
    const encoded = query.toString();
    return encoded === '' ? '/tasks' : `/tasks?${encoded}`;
  };

  const overdue = tasks.filter((task) => task.overdue).length;

  return (
    <>
      <PageHeader
        title="My Tasks"
        description={
          who === 'mine'
            ? 'Checklist steps assigned to you, soonest first.'
            : 'Checklist steps across every client you can see, soonest first.'
        }
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-2">
          {STATES.map((option) => (
            <Link
              key={option.key}
              href={href({ state: option.key })}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                option.key === state
                  ? 'border-brand bg-brand/10 font-medium text-brand'
                  : 'border-border text-ink-muted hover:text-ink',
              )}
            >
              {option.label}
            </Link>
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <Link
            href={href({ who: who === 'mine' ? 'anyone' : 'mine' })}
            className="rounded-full border border-border px-3 py-1 text-sm text-ink-muted hover:text-ink"
          >
            {who === 'mine' ? 'Anyone' : 'Only mine'}
          </Link>
          {overdue > 0 && (
            <Badge tone="critical">
              {overdue} overdue
            </Badge>
          )}
        </div>

        {tasks.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
              <CheckCircle2 className="size-6 text-ink-faint" aria-hidden />
              <p className="text-sm text-ink-muted">
                {state === 'overdue'
                  ? 'Nothing is overdue.'
                  : who === 'mine'
                    ? 'No checklist steps are assigned to you.'
                    : 'No checklist steps match.'}
              </p>
              <p className="text-xs text-ink-faint">
                Steps are assigned when a checklist is started from a procedure, and can be
                handed on from the run itself.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul>
                {tasks.map((task) => (
                  <li
                    key={task.stepId}
                    className="border-b border-border last:border-b-0"
                  >
                    <Link
                      href={`/runs/${task.runId}`}
                      className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-sunken"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              'text-sm text-ink',
                              task.status === 'done' && 'line-through decoration-ink-faint',
                            )}
                          >
                            {task.title}
                          </span>
                          {task.isOptional && <Badge tone="neutral">Optional</Badge>}
                          {task.status !== 'pending' && (
                            <Badge tone={task.status === 'done' ? 'ok' : 'warning'}>
                              {task.status}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-ink-muted">
                          {task.organizationName} · {task.runTitle}
                          {task.sopName !== task.runTitle && ` · ${task.sopName}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs">
                        {task.dueAt && (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1',
                              task.overdue ? 'font-medium text-danger' : 'text-ink-muted',
                            )}
                          >
                            <CalendarClock className="size-3" aria-hidden />
                            {task.overdue ? 'Overdue — ' : ''}
                            {formatDateTime(task.dueAt)}
                          </span>
                        )}
                        {who === 'anyone' && task.assignedTo && (
                          <span className="inline-flex items-center gap-1 text-ink-faint">
                            <UserRound className="size-3" aria-hidden />
                            {task.assignedTo}
                          </span>
                        )}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </PageBody>
    </>
  );
}
