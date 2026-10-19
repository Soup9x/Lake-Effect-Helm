'use client';

/**
 * A procedure's schedules: the runs it raises on its own.
 *
 * A schedule is a run started in advance — every N days from a first date, a
 * run of the published version appears, assigned and dated the way a person
 * would have started it. The worker raises it (src/workers/schedules.ts and
 * 0770); this card only writes the rows.
 *
 * WHAT A SCHEDULE DOES NOT DO: queue up what it missed. A worker that was down
 * for a month raises one run, not four. The card says "next" and "last", and
 * never "overdue", because the function advances past everything already gone.
 *
 * Adding and changing a schedule needs sop:execute, the same as starting a run.
 * Everyone who can read the procedure sees the list.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, Loader2, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { FieldHint, Input, Label, Select } from './ui/field';
import { Modal } from './ui/modal';
import type { ScheduleRow } from '@/lib/sops/schedules';
import { formatDateTime, fromDateTimeLocalInput, toDateTimeLocalInput } from '@/lib/ui/format';
import { apiFetch } from '@/lib/ui/api';

function everyLabel(days: number): string {
  if (days === 1) return 'Every day';
  if (days === 7) return 'Every week';
  if (days % 7 === 0) return `Every ${days / 7} weeks`;
  return `Every ${days} days`;
}

/** Tomorrow at 09:00 local, the sensible default for a first slot. */
function defaultFirstRun(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return toDateTimeLocalInput(d);
}

export function ChecklistSchedulesCard({
  sopId,
  sopName,
  published,
  schedules,
  canManage,
  assignable = [],
  sites = [],
}: {
  sopId: string;
  sopName: string;
  /** False while the procedure has no published version: nothing to schedule. */
  published: boolean;
  schedules: readonly ScheduleRow[];
  canManage: boolean;
  assignable?: readonly { id: string; name: string }[];
  sites?: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [intervalDays, setIntervalDays] = useState('7');
  const [firstRunAt, setFirstRunAt] = useState(defaultFirstRun);
  const [dueAfterDays, setDueAfterDays] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [siteId, setSiteId] = useState('');
  const [title, setTitle] = useState('');

  async function call(key: string, url: string, method: 'POST' | 'PATCH' | 'DELETE', json?: unknown) {
    setBusy(key);
    setError(null);
    try {
      const result = await apiFetch(url, { method, ...(json === undefined ? {} : { json }) });
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

  async function add() {
    const interval = Number.parseInt(intervalDays, 10);
    const due = dueAfterDays.trim() === '' ? null : Number.parseInt(dueAfterDays, 10);
    const first = fromDateTimeLocalInput(firstRunAt);
    if (!Number.isInteger(interval) || interval < 1 || interval > 366) {
      setError('the interval is a whole number of days, from 1 to 366');
      return;
    }
    if (due !== null && (!Number.isInteger(due) || due < 0 || due > 366)) {
      setError('due after is a whole number of days, from 0 to 366, or blank');
      return;
    }
    if (!first) {
      setError('pick the first run’s date');
      return;
    }
    const ok = await call('add', `/api/sops/${sopId}/schedules`, 'POST', {
      intervalDays: interval,
      firstRunAt: first,
      dueAfterDays: due,
      assignedTo: assignedTo === '' ? null : assignedTo,
      siteId: siteId === '' ? null : siteId,
      title: title.trim() === '' ? null : title.trim(),
    });
    if (ok) {
      setAdding(false);
      setTitle('');
      setDueAfterDays('');
    }
  }

  const toggle = (s: ScheduleRow) =>
    call(s.id, `/api/sops/${sopId}/schedules/${s.id}`, 'PATCH', { enabled: !s.enabled });
  const remove = (s: ScheduleRow) => {
    if (!window.confirm('Remove this schedule? Runs it already raised stay.')) return;
    void call(s.id, `/api/sops/${sopId}/schedules/${s.id}`, 'DELETE');
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="size-4 text-ink-faint" aria-hidden /> Schedules
          {schedules.length > 0 && <Badge tone="neutral">{schedules.length}</Badge>}
        </CardTitle>
        {canManage && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { setError(null); setAdding(true); }}
            disabled={!published}
            title={published ? undefined : 'Publish the procedure first'}
          >
            <Plus className="size-3.5" aria-hidden />
            Add a schedule
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {/*
          Said in the card, not only in the button's tooltip: a greyed-out
          button with the reason on hover reads as broken to anybody who does
          not hover.
        */}
        {!published && canManage && (
          <p className="rounded-md border border-sev-warning/30 bg-sev-warning/5 px-3 py-2 text-sm text-ink">
            Publish this procedure to schedule it. A schedule runs the published version, and
            this one has none yet — use Publish in the Checklist card above.
          </p>
        )}
        {schedules.length === 0 ? (
          <p className="text-sm text-ink-faint">
            {published
              ? 'No schedules. A schedule raises a run of this procedure every so many days, assigned and dated, without anyone starting it.'
              : canManage ? 'No schedules yet.' : 'Publish the procedure, then a schedule can raise runs of it.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {schedules.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{s.title ?? sopName}</span>
                    <Badge tone="neutral">{everyLabel(s.intervalDays)}</Badge>
                    {!s.enabled && <Badge tone="warning">Paused</Badge>}
                    {s.lastError && <Badge tone="danger">Last slot skipped</Badge>}
                  </div>
                  <p className="text-xs text-ink-muted">
                    {s.enabled ? 'Next' : 'Would next run'} {formatDateTime(s.nextRunAt)}
                    {s.assignedToName && ` · assigned to ${s.assignedToName}`}
                    {s.siteName && ` · ${s.siteName}`}
                    {s.dueAfterDays !== null && ` · due ${s.dueAfterDays} day${s.dueAfterDays === 1 ? '' : 's'} after`}
                  </p>
                  {s.lastRaisedAt && (
                    <p className="text-xs text-ink-faint">
                      Last raised {formatDateTime(s.lastRaisedAt)}
                      {s.lastRunId && (
                        <>
                          {' · '}
                          <a href={`/runs/${s.lastRunId}`} className="underline hover:text-ink">open that run</a>
                        </>
                      )}
                    </p>
                  )}
                  {s.lastError && <p className="text-xs text-danger">{s.lastError}</p>}
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => void toggle(s)} disabled={busy !== null}>
                      {s.enabled ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                      {s.enabled ? 'Pause' : 'Resume'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(s)} disabled={busy !== null}>
                      <Trash2 className="size-3.5" aria-hidden />
                      <span className="sr-only">Remove schedule</span>
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {error && !adding && (
          <p role="alert" className="text-sm text-danger">{error}</p>
        )}
      </CardContent>

      <Modal
        open={adding}
        onOpenChange={(next) => { setAdding(next); if (!next) setError(null); }}
        title={`Schedule ${sopName}`}
        description="A run of the published version appears at each slot. Slots the worker was down for are skipped, not queued."
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="sched-interval">Every (days)</Label>
              <Input
                id="sched-interval"
                type="number"
                min={1}
                max={366}
                value={intervalDays}
                onChange={(e) => setIntervalDays(e.target.value)}
              />
              <FieldHint>7 for weekly, 30 for monthly-ish, 90 for quarterly.</FieldHint>
            </div>
            <div>
              <Label htmlFor="sched-first">First run</Label>
              <Input
                id="sched-first"
                type="datetime-local"
                value={firstRunAt}
                onChange={(e) => setFirstRunAt(e.target.value)}
              />
              <FieldHint>In your own time zone.</FieldHint>
            </div>
          </div>
          <div>
            <Label htmlFor="sched-title">Title</Label>
            <Input
              id="sched-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={sopName}
              maxLength={200}
            />
            <FieldHint>Each run is titled this, with the slot&rsquo;s date after it.</FieldHint>
          </div>
          {assignable.length > 0 && (
            <div>
              <Label htmlFor="sched-assignee">Assign to</Label>
              <Select id="sched-assignee" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
                <option value="">Nobody in particular</option>
                {assignable.map((person) => (
                  <option key={person.id} value={person.id}>{person.name}</option>
                ))}
              </Select>
              <FieldHint>Every step of every raised run starts assigned to them.</FieldHint>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="sched-due">Due (days after the slot)</Label>
              <Input
                id="sched-due"
                type="number"
                min={0}
                max={366}
                value={dueAfterDays}
                onChange={(e) => setDueAfterDays(e.target.value)}
                placeholder="No deadline"
              />
            </div>
            {sites.length > 0 && (
              <div>
                <Label htmlFor="sched-site">Site</Label>
                <Select id="sched-site" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                  <option value="">Any</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>{site.name}</option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">{error}</p>
          )}

          <div className="flex gap-2">
            <Button type="button" variant="primary" onClick={() => void add()} disabled={busy !== null}>
              {busy === 'add' && <Loader2 className="animate-spin" aria-hidden />}
              Add
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)} disabled={busy !== null}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
