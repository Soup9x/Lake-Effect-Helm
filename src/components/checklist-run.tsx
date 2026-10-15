'use client';

/**
 * Working down a checklist.
 *
 * THREE CONTROLS PER STEP, NOT A DROPDOWN OF SEVEN. sop_step_status carries
 * pending, in_progress, done, skipped, blocked, failed and not_applicable. A
 * person working through a list reaches three of them: the box is unticked,
 * ticked, or skipped with a reason. The other four stay in the enum and get no
 * control until something is built that means them — `blocked` wants a reason
 * and a way to unblock, `failed` wants an incident, `not_applicable` wants a
 * judgement recorded. Four words with no behaviour behind them would be the
 * placeholder shape this plan has been removing; they are recorded as deferred
 * in docs/itg-parity.md.
 *
 * SKIPPING A REQUIRED STEP ASKS WHY, because sop_run_step_skip_needs_note
 * refuses one without a note. The constraint is the authority — this asks so
 * the answer is a prompt rather than a 400.
 *
 * COMPLETE IS DISABLED WHILE REQUIRED STEPS ARE PENDING, from the same
 * function the route uses. Optional steps may be left; that is what optional
 * means.
 *
 * A FINISHED RUN IS READ-ONLY. Editing a step afterwards would rewrite the
 * evidence the run exists to be, so the controls go away rather than failing.
 * That includes reassignment: handing somebody a step on a run that is already
 * over is not a smaller act than ticking one off.
 *
 * WHO AND WHEN (0650). Each step shows its assignee and due date, and "Assign"
 * changes both in one PATCH. `overdue` is computed in SQL rather than compared
 * to Date.now() here — a date comparison during render answers one way on the
 * server and another in the browser, which is a hydration mismatch, and it
 * would put the meaning of "overdue" in a third place.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, Check, CircleSlash, Loader2, RotateCcw, UserRound } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { Modal } from './ui/modal';
import { unsettledRequiredSteps, type RunStepState } from '@/lib/sops/steps';
import type { RunView } from '@/lib/sops/queries';
import {
  formatDateTime, fromDateTimeLocalInput, toDateTimeLocalInput,
} from '@/lib/ui/format';
import { cn } from '@/lib/ui/cn';
import { apiFetch } from '@/lib/ui/api';

const STATUS_TONE: Record<string, 'ok' | 'neutral' | 'warning' | 'critical' | 'brand'> = {
  completed: 'ok',
  in_progress: 'brand',
  not_started: 'neutral',
  blocked: 'warning',
  abandoned: 'neutral',
};

export function ChecklistRun({
  run,
  canExecute,
  assignable = [],
}: {
  run: RunView;
  canExecute: boolean;
  /** Active members of this tenant, for the assignee picker (0650). */
  assignable?: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipping, setSkipping] = useState<{ id: string; title: string } | null>(null);
  const [skipNote, setSkipNote] = useState('');
  const [abandoning, setAbandoning] = useState(false);
  const [abandonReason, setAbandonReason] = useState('');
  const [assigning, setAssigning] = useState<
    { id: string; title: string; assignedToId: string | null; dueAt: string | null } | null
  >(null);
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');

  const finished = run.status === 'completed' || run.status === 'abandoned';
  const editable = canExecute && !finished;
  const outstanding = unsettledRequiredSteps(
    run.steps.map((s) => ({ status: s.status, isOptional: s.isOptional })),
  );
  const done = run.steps.filter((s) => s.status === 'done').length;

  async function send(url: string, payload: unknown, key: string): Promise<boolean> {
    setBusy(key);
    setError(null);
    try {
      const result = await apiFetch(url, {
        method: 'PATCH',
        json: payload,
      });
      if (!result.ok) {
        setError(result.message);
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setBusy(null);
    }
  }

  const setStep = (id: string, status: RunStepState, note?: string | null) =>
    send(
      `/api/sop-runs/${run.id}/steps/${id}`,
      { status, ...(note === undefined ? {} : { note }) },
      id,
    );

  async function confirmSkip() {
    if (!skipping) return;
    if (await setStep(skipping.id, 'skipped', skipNote.trim() === '' ? null : skipNote.trim())) {
      setSkipping(null);
      setSkipNote('');
    }
  }

  async function confirmAssign() {
    if (!assigning) return;
    const payload = {
      assignedTo: assignee === '' ? null : assignee,
      dueAt: fromDateTimeLocalInput(due),
    };
    if (await send(`/api/sop-runs/${run.id}/steps/${assigning.id}`, payload, assigning.id)) {
      setAssigning(null);
    }
  }

  async function confirmAbandon() {
    if (await send(`/api/sop-runs/${run.id}`, {
      status: 'abandoned', reason: abandonReason.trim(),
    }, 'run')) {
      setAbandoning(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[run.status] ?? 'neutral'}>{run.status.replace(/_/g, ' ')}</Badge>
        <Badge tone="neutral">
          {done} of {run.steps.length} done
        </Badge>
        {run.ticketRef && <Badge tone="neutral">{run.ticketRef}</Badge>}
        {run.assignedTo && <Badge tone="neutral">Assigned to {run.assignedTo}</Badge>}
        {run.dueAt && (
          <Badge tone="neutral">Run due {formatDateTime(run.dueAt)}</Badge>
        )}
        {!finished && outstanding > 0 && (
          <Badge tone="warning">
            {outstanding} required step{outstanding === 1 ? '' : 's'} left
          </Badge>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Steps</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {run.steps.map((step) => {
            const settled = step.status !== 'pending';
            return (
              <div
                key={step.id}
                className={cn(
                  'flex flex-wrap items-start gap-3 rounded-md border-b border-border px-1 py-2.5 last:border-b-0',
                  step.status === 'done' && 'opacity-70',
                )}
              >
                <span className="mt-0.5 w-6 shrink-0 tabular-nums text-sm text-ink-faint">
                  {step.position}.
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        'text-sm text-ink',
                        step.status === 'done' && 'line-through decoration-ink-faint',
                      )}
                    >
                      {step.title}
                    </span>
                    {step.isOptional && <Badge tone="neutral">Optional</Badge>}
                    {step.status === 'skipped' && <Badge tone="warning">Skipped</Badge>}
                  </div>
                  {step.body && (
                    <p className="mt-0.5 whitespace-pre-wrap text-xs text-ink-muted">{step.body}</p>
                  )}
                  {step.note && (
                    <p className="mt-1 whitespace-pre-wrap text-xs text-ink-muted">
                      <span className="text-ink-faint">Note: </span>
                      {step.note}
                    </p>
                  )}
                  {settled && step.completedAt && (
                    <p className="mt-0.5 text-xs text-ink-faint">
                      {step.status === 'done' ? 'Done' : 'Skipped'}{' '}
                      {formatDateTime(step.completedAt)}
                      {step.completedBy && ` by ${step.completedBy}`}
                    </p>
                  )}
                  {(step.assignedTo || step.dueAt) && (
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                      {step.assignedTo && (
                        <span className="inline-flex items-center gap-1 text-ink-muted">
                          <UserRound className="size-3" aria-hidden />
                          {step.assignedTo}
                        </span>
                      )}
                      {step.dueAt && (
                        <span
                          className={cn(
                            'inline-flex items-center gap-1',
                            step.overdue ? 'font-medium text-danger' : 'text-ink-muted',
                          )}
                        >
                          <CalendarClock className="size-3" aria-hidden />
                          {step.overdue ? 'Overdue — due ' : 'Due '}
                          {formatDateTime(step.dueAt)}
                        </span>
                      )}
                    </p>
                  )}
                </div>

                {editable && (
                  <div className="flex shrink-0 gap-1.5">
                    {busy === step.id ? (
                      <Loader2 className="size-4 animate-spin text-ink-faint" aria-hidden />
                    ) : step.status === 'pending' ? (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void setStep(step.id, 'done')}
                        >
                          <Check className="size-3.5" aria-hidden />
                          Done
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSkipping({ id: step.id, title: step.title });
                            setSkipNote('');
                          }}
                        >
                          <CircleSlash className="size-3.5" aria-hidden />
                          Skip
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void setStep(step.id, 'pending', null)}
                      >
                        <RotateCcw className="size-3.5" aria-hidden />
                        Undo
                      </Button>
                    )}
                    {busy !== step.id && step.status === 'pending' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setAssigning({
                            id: step.id,
                            title: step.title,
                            assignedToId: step.assignedToId,
                            dueAt: step.dueAt,
                          });
                          setAssignee(step.assignedToId ?? '');
                          setDue(toDateTimeLocalInput(step.dueAt));
                          setError(null);
                        }}
                      >
                        <UserRound className="size-3.5" aria-hidden />
                        Assign
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {run.steps.length === 0 && (
            <p className="text-sm text-ink-faint">
              This run has no steps, which should not happen — the version it was started from had
              none readable.
            </p>
          )}
        </CardContent>
      </Card>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {finished ? (
        <Card>
          <CardContent className="space-y-1 text-sm">
            <p className="text-ink">
              {run.status === 'completed' ? 'Completed' : 'Abandoned'}{' '}
              {run.completedAt && formatDateTime(run.completedAt)}
            </p>
            {run.abandonedReason && (
              <p className="whitespace-pre-wrap text-ink-muted">{run.abandonedReason}</p>
            )}
            <FieldHint>
              A finished run cannot be edited. It records what was followed and when, which is what
              makes it usable as evidence later.
            </FieldHint>
          </CardContent>
        </Card>
      ) : (
        editable && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => void send(`/api/sop-runs/${run.id}`, { status: 'completed' }, 'run')}
              disabled={busy !== null || outstanding > 0}
              title={outstanding > 0 ? `${outstanding} required steps still to do` : undefined}
            >
              {busy === 'run' && <Loader2 className="animate-spin" aria-hidden />}
              Mark complete
            </Button>
            <Button variant="ghost" onClick={() => setAbandoning(true)} disabled={busy !== null}>
              Abandon
            </Button>
            {outstanding > 0 && (
              <span className="text-xs text-ink-faint">
                {outstanding} required step{outstanding === 1 ? '' : 's'} still to do.
              </span>
            )}
          </div>
        )
      )}

      <p className="text-xs text-ink-faint">
        Started {run.startedAt ? formatDateTime(run.startedAt) : '—'}
        {run.startedBy && ` by ${run.startedBy}`} · following v{run.version} of {run.sopName},
        which stays fixed however the procedure changes afterwards.
      </p>

      <Modal
        open={assigning !== null}
        onOpenChange={(next) => { if (!next) { setAssigning(null); setError(null); } }}
        title="Assign this step"
        description="Who it belongs to and when it is due. Either can be cleared."
      >
        <div className="space-y-3">
          <p className="text-sm text-ink">{assigning?.title}</p>
          <div>
            <Label htmlFor="step-assignee">Assign to</Label>
            <Select
              id="step-assignee"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            >
              <option value="">Nobody</option>
              {assignable.map((person) => (
                <option key={person.id} value={person.id}>{person.name}</option>
              ))}
            </Select>
            {assignable.length === 0 && (
              <FieldHint>
                Nobody to assign to — this tenant has no other active members.
              </FieldHint>
            )}
          </div>
          <div>
            <Label htmlFor="step-due">Due</Label>
            <Input
              id="step-due"
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
            <FieldHint>In your own time zone.</FieldHint>
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void confirmAssign()} disabled={busy !== null}>
              {busy !== null && <Loader2 className="animate-spin" aria-hidden />}
              Save
            </Button>
            <Button variant="ghost" onClick={() => setAssigning(null)} disabled={busy !== null}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={skipping !== null}
        onOpenChange={(next) => { if (!next) { setSkipping(null); setError(null); } }}
        title="Skip this step"
        description="A step that was not done is worth a line about why. Required steps cannot be skipped without one."
      >
        <div className="space-y-3">
          <p className="text-sm text-ink">{skipping?.title}</p>
          <div>
            <Label htmlFor="skip-note">Why</Label>
            <Textarea
              id="skip-note"
              value={skipNote}
              onChange={(e) => setSkipNote(e.target.value)}
              rows={3}
              maxLength={4000}
              autoFocus
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void confirmSkip()} disabled={busy !== null}>
              {busy !== null && <Loader2 className="animate-spin" aria-hidden />}
              Skip the step
            </Button>
            <Button variant="ghost" onClick={() => setSkipping(null)} disabled={busy !== null}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={abandoning}
        onOpenChange={(next) => { setAbandoning(next); if (!next) setError(null); }}
        title="Abandon this run"
        description="Abandoning says the procedure was not followed, which is a different claim from completing it. It cannot be undone."
      >
        <div className="space-y-3">
          <div>
            <Label htmlFor="abandon-reason">Why</Label>
            <Textarea
              id="abandon-reason"
              value={abandonReason}
              onChange={(e) => setAbandonReason(e.target.value)}
              rows={3}
              maxLength={2000}
              autoFocus
            />
            <FieldHint>Required — a run that stopped without a reason tells nobody anything.</FieldHint>
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="danger"
              onClick={() => void confirmAbandon()}
              disabled={busy !== null || abandonReason.trim() === ''}
            >
              {busy === 'run' && <Loader2 className="animate-spin" aria-hidden />}
              Abandon
            </Button>
            <Button variant="ghost" onClick={() => setAbandoning(false)} disabled={busy !== null}>
              Keep it open
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
