'use client';

/**
 * A procedure's steps, its published versions, and the three things you can do
 * with it: edit the list, publish it, run it.
 *
 * PUBLISHING IS NOT SAVING, and the card says so rather than hoping. Saving the
 * step list edits `sop_step`, which is the living definition; publishing freezes
 * it into an immutable `sop_version`, and a run copies from THAT. 0090's header
 * is the reason: "Pointing a run at a living, editable document would let
 * today's edit rewrite yesterday's evidence." So an edited-but-unpublished
 * procedure is a real and confusing state — the steps on screen are not the
 * steps a new run would get — and it is called out explicitly instead of being
 * left for somebody to discover.
 *
 * TWO PERMISSIONS, TWO CONTROLS. Editing and publishing need sop:write (tier2
 * and above); starting a run needs sop:execute (tier1 and above). A technician
 * who may run a checklist but not rewrite one sees Start and no editor, which
 * is the split the seed already describes.
 *
 * THE EDITOR REPLACES THE WHOLE LIST. PUT .../steps takes the list as it now
 * stands, for the reason given there: sop_step's position uniqueness is not
 * deferrable, so shuffling positions in place can collide halfway through.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDown, ArrowUp, BookOpen, GripVertical, Loader2, Play, Plus, Trash2, Upload,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { Modal } from './ui/modal';
import { reorder } from '@/lib/workspace/widgets';
import { STEP_LIMITS, validateSteps, type StepDraft } from '@/lib/sops/steps';
import type { TemplateView } from '@/lib/sops/queries';
import { formatDateTime, fromDateTimeLocalInput } from '@/lib/ui/format';

export function ChecklistTemplateCard({
  sopId,
  organizationId,
  sopName,
  template,
  canAuthor,
  canRun,
  assignable = [],
}: {
  sopId: string;
  organizationId: string;
  sopName: string;
  template: TemplateView;
  canAuthor: boolean;
  canRun: boolean;
  /** Active members of this tenant, for the assignee picker (0650). */
  assignable?: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [steps, setSteps] = useState<StepDraft[]>(
    template.steps.map((s) => ({ title: s.title, body: s.body ?? '' })),
  );
  const [runTitle, setRunTitle] = useState('');
  const [ticketRef, setTicketRef] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [dueAt, setDueAt] = useState('');

  const issues = validateSteps(steps);
  const stepIssue = (index: number) => issues.find((i) => i.index === index)?.message;
  const listIssue = issues.find((i) => i.index === -1)?.message;

  function reset() {
    setSteps(template.steps.map((s) => ({ title: s.title, body: s.body ?? '' })));
    setError(null);
  }

  async function send(url: string, method: string, payload?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method,
        ...(payload === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `That did not work (${response.status}).`);
        return false;
      }
      return true;
    } catch {
      setError('The request did not reach the server.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveSteps() {
    const ok = await send(`/api/sops/${sopId}/steps`, 'PUT', {
      steps: steps.map((s) => ({
        title: s.title.trim(),
        body: (s.body ?? '').trim() === '' ? null : (s.body ?? '').trim(),
      })),
    });
    if (ok) {
      setEditing(false);
      router.refresh();
    }
  }

  async function publish() {
    if (await send(`/api/sops/${sopId}/versions`, 'POST', {})) router.refresh();
  }

  async function startRun() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/sop-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sopId,
          organizationId,
          ...(runTitle.trim() === '' ? {} : { title: runTitle.trim() }),
          ...(ticketRef.trim() === '' ? {} : { ticketRef: ticketRef.trim() }),
          ...(assignedTo === '' ? {} : { assignedTo }),
          // datetime-local is zoneless local wall clock; the conversion and
          // its inverse live together in lib/ui/format for the reason given
          // there, which is that slicing toISOString() moves the deadline.
          ...(dueAt === '' ? {} : { dueAt: fromDateTimeLocalInput(dueAt) }),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `The run could not be started (${response.status}).`);
        return;
      }
      const created = (await response.json().catch(() => null)) as { runId?: string } | null;
      setStarting(false);
      if (created?.runId) router.push(`/runs/${created.runId}`);
      else router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="size-4 text-ink-faint" aria-hidden /> Checklist
          {template.current ? (
            <Badge tone="neutral">v{template.current.version}</Badge>
          ) : (
            <Badge tone="warning">Never published</Badge>
          )}
          {template.unpublishedChanges && <Badge tone="warning">Edited since publishing</Badge>}
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {canAuthor && (
            <>
              <Button variant="secondary" size="sm" onClick={() => { reset(); setEditing(true); }}>
                Edit steps
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void publish()}
                disabled={busy || template.steps.length === 0}
                title={template.steps.length === 0 ? 'Add a step first' : undefined}
              >
                <Upload className="size-3.5" aria-hidden />
                Publish v{(template.current?.version ?? 0) + 1}
              </Button>
            </>
          )}
          {canRun && template.current && (
            <Button variant="cta" size="sm" onClick={() => setStarting(true)}>
              <Play className="size-3.5" aria-hidden />
              Start a run
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {template.steps.length === 0 ? (
          <p className="text-sm text-ink-faint">
            No steps yet.{' '}
            {canAuthor ? 'Add some, then publish to make it runnable.' : 'Nothing to run yet.'}
          </p>
        ) : (
          <ol className="space-y-2">
            {template.steps.map((step) => (
              <li key={step.id} className="flex gap-2.5 text-sm">
                <span className="mt-0.5 tabular-nums text-ink-faint">{step.position}.</span>
                <span className="min-w-0">
                  <span className="block text-ink">{step.title}</span>
                  {step.body && (
                    <span className="block whitespace-pre-wrap text-xs text-ink-muted">
                      {step.body}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}

        {/*
          The state that needs saying out loud: a run started now would follow
          the published text, not what is on screen above.
        */}
        {template.unpublishedChanges && (
          <p className="text-xs text-warning">
            These steps have changed since v{template.current?.version} was published. A run
            started now follows the published version — publish again to make these steps the
            ones people get.
          </p>
        )}

        {template.current && (
          <p className="text-xs text-ink-faint">
            v{template.current.version} published {formatDateTime(template.current.publishedAt)}
            {template.current.publishedBy && ` by ${template.current.publishedBy}`}
            {' · '}
            {template.current.steps} step{template.current.steps === 1 ? '' : 's'} frozen
            {template.versions > 1 && ` · ${template.versions} versions in all`}
          </p>
        )}

        {error && !editing && !starting && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </CardContent>

      {/* ---------------------------------------------------------------- editor */}
      <Modal
        open={editing}
        onOpenChange={(next) => { setEditing(next); if (!next) reset(); }}
        title={`Steps for ${sopName}`}
        description="Saving edits the living procedure. Publishing is what makes these the steps a new run gets."
        size="lg"
      >
        <div className="space-y-3">
          <ul className="space-y-2">
            {steps.map((step, index) => (
              <li key={index} className="rounded border border-border p-2">
                <div className="flex items-start gap-1">
                  <GripVertical className="mt-2 size-3.5 shrink-0 text-ink-faint" aria-hidden />
                  <span className="mt-2 w-5 shrink-0 tabular-nums text-xs text-ink-faint">
                    {index + 1}.
                  </span>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Input
                      value={step.title}
                      onChange={(e) => setSteps((list) =>
                        list.map((s, i) => (i === index ? { ...s, title: e.target.value } : s)))}
                      placeholder="What to do"
                      maxLength={STEP_LIMITS.maxTitle}
                      aria-label={`Step ${index + 1} title`}
                    />
                    <Textarea
                      value={step.body ?? ''}
                      onChange={(e) => setSteps((list) =>
                        list.map((s, i) => (i === index ? { ...s, body: e.target.value } : s)))}
                      rows={2}
                      placeholder="Detail, if it needs any"
                      maxLength={STEP_LIMITS.maxBody}
                      aria-label={`Step ${index + 1} detail`}
                    />
                    {stepIssue(index) && (
                      <p role="alert" className="text-xs text-danger">{stepIssue(index)}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col">
                    <button
                      type="button"
                      onClick={() => setSteps((list) => reorder(list, index, index - 1))}
                      disabled={index === 0}
                      className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink disabled:opacity-30"
                    >
                      <ArrowUp className="size-3.5" aria-hidden />
                      <span className="sr-only">Move step {index + 1} up</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSteps((list) => reorder(list, index, index + 1))}
                      disabled={index === steps.length - 1}
                      className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink disabled:opacity-30"
                    >
                      <ArrowDown className="size-3.5" aria-hidden />
                      <span className="sr-only">Move step {index + 1} down</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSteps((list) => list.filter((_, i) => i !== index))}
                      className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-danger"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      <span className="sr-only">Remove step {index + 1}</span>
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setSteps((list) => [...list, { title: '', body: '' }])}
            disabled={steps.length >= STEP_LIMITS.maxSteps}
          >
            <Plus className="size-3.5" aria-hidden />
            Add a step
          </Button>

          {listIssue && (
            <p role="alert" className="text-sm text-danger">
              {listIssue}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <FieldHint>
            An empty list can be saved as a draft. Publishing is what refuses one.
          </FieldHint>

          <div className="flex gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="primary"
              onClick={() => void saveSteps()}
              disabled={busy || issues.some((i) => i.index >= 0)}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Save steps
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => { setEditing(false); reset(); }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* ------------------------------------------------------------ start a run */}
      <Modal
        open={starting}
        onOpenChange={(next) => { setStarting(next); if (!next) setError(null); }}
        title={`Start ${sopName}`}
        description={
          template.current
            ? `The run will follow v${template.current.version} — ${template.current.steps} steps — and keeps following it however the procedure changes afterwards.`
            : ''
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="run-title">Title</Label>
            <Input
              id="run-title"
              value={runTitle}
              onChange={(e) => setRunTitle(e.target.value)}
              placeholder={sopName}
              maxLength={200}
            />
            <FieldHint>What this run is about. Defaults to the procedure&rsquo;s name.</FieldHint>
          </div>
          <div>
            <Label htmlFor="run-ticket">Ticket reference</Label>
            <Input
              id="run-ticket"
              value={ticketRef}
              onChange={(e) => setTicketRef(e.target.value)}
              maxLength={120}
            />
          </div>
          {assignable.length > 0 && (
            <div>
              <Label htmlFor="run-assignee">Assign to</Label>
              <Select
                id="run-assignee"
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
              >
                <option value="">Nobody in particular</option>
                {assignable.map((person) => (
                  <option key={person.id} value={person.id}>{person.name}</option>
                ))}
              </Select>
              <FieldHint>
                Every step starts assigned to them, and each one can be handed on
                individually afterwards.
              </FieldHint>
            </div>
          )}
          <div>
            <Label htmlFor="run-due">Due</Label>
            <Input
              id="run-due"
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
            <FieldHint>In your own time zone. Applies to every step.</FieldHint>
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="button" variant="primary" onClick={() => void startRun()} disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Start
            </Button>
            <Button type="button" variant="ghost" onClick={() => setStarting(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
