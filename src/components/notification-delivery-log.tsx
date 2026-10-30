'use client';

import { useMemo, useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Loader2, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Select } from './ui/field';
import { Badge, type BadgeTone } from './ui/badge';
import { Pager, usePage } from './ui/pager';
import { formatDateTime } from '@/lib/ui/format';
import { apiFetch, type Feedback } from '@/lib/ui/api';
import type { NotificationDelivery, NotificationLogCounts } from './notification-settings';

const PAGE_SIZE = 10;

type View = 'log' | 'archived';
type StatusFilter = 'all' | 'delivered' | 'problems' | 'pending';

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'problems', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
];

const ARCHIVE_AGES: { days: number; label: string }[] = [
  { days: 7, label: 'older than 7 days' },
  { days: 30, label: 'older than 30 days' },
  { days: 90, label: 'older than 90 days' },
  { days: 0, label: 'all finished' },
];

function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'delivered':
      return 'ok';
    case 'pending':
      return 'neutral';
    case 'dead':
      return 'danger';
    default:
      return 'warning';
  }
}

function matches(filter: StatusFilter, status: string): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'delivered':
      return status === 'delivered';
    case 'pending':
      return status === 'pending';
    case 'problems':
      return status === 'dead' || status === 'failed';
  }
}

/**
 * Consecutive deliveries of the same message to the same place with the same
 * outcome, as one row. A destination that is down for a night produces the
 * same dead row over and over; this is what turns that into "×14".
 */
interface DeliveryGroup {
  key: string;
  newest: NotificationDelivery;
  items: NotificationDelivery[];
}

function groupDeliveries(deliveries: NotificationDelivery[]): DeliveryGroup[] {
  const groups: DeliveryGroup[] = [];
  for (const delivery of deliveries) {
    const last = groups[groups.length - 1];
    if (
      last
      && last.newest.destination === delivery.destination
      && last.newest.event === delivery.event
      && last.newest.status === delivery.status
      && last.newest.subject === delivery.subject
    ) {
      last.items.push(delivery);
    } else {
      groups.push({ key: delivery.id, newest: delivery, items: [delivery] });
    }
  }
  return groups;
}

function summarise(counts: Record<string, number>): string {
  const parts = [
    counts.delivered && `${counts.delivered} delivered`,
    (counts.dead ?? 0) + (counts.failed ?? 0) > 0 && `${(counts.dead ?? 0) + (counts.failed ?? 0)} failed`,
    counts.pending && `${counts.pending} pending`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'nothing in the log';
}

/**
 * The delivery log under the destinations: folded to a one-line summary,
 * grouped, filtered and paged when open, with archiving for the rows somebody
 * has already looked at.
 *
 * ARCHIVE BEFORE DELETE. Archiving hides a finished delivery and takes it out
 * of its destination's "dead" count; it can be restored. Deleting is only
 * offered on the archived side, and the database keeps anything younger than
 * two days because those rows are what stops a task reminder going out twice
 * (see 1220).
 */
export function NotificationDeliveryLog({
  initial,
  initialCounts,
  limit,
  canManage,
}: {
  initial: NotificationDelivery[];
  initialCounts: NotificationLogCounts;
  /** The most rows one side of the log is sent with, to say when it is cut short. */
  limit: number;
  canManage: boolean;
}) {
  // Open on arrival only when something is still going out — a test that was
  // just queued, a retry in progress — because that is when somebody came here
  // to read it. Otherwise the summary line is the whole section.
  const [open, setOpen] = useState(() => initial.some((d) => d.status === 'pending'));
  const [view, setView] = useState<View>('log');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [archiveDays, setArchiveDays] = useState(30);
  const [rows, setRows] = useState<Record<View, NotificationDelivery[] | null>>({ log: initial, archived: null });
  const [counts, setCounts] = useState(initialCounts);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  // The server re-renders the page after a test send or a save; take its rows
  // for the live log when they change, rather than keeping what was first sent.
  const [seenInitial, setSeenInitial] = useState(initial);
  if (seenInitial !== initial) {
    setSeenInitial(initial);
    setRows((r) => ({ ...r, log: initial }));
    setCounts(initialCounts);
  }

  const current = rows[view];
  const groups = useMemo(
    () => groupDeliveries((current ?? []).filter((d) => matches(filter, d.status))),
    [current, filter],
  );
  const page = usePage(groups, PAGE_SIZE);
  const total = view === 'log'
    ? Object.values(counts.active).reduce((a, b) => a + b, 0)
    : counts.archived;

  async function load(next: View) {
    const result = await apiFetch<{ deliveries: NotificationDelivery[]; counts: NotificationLogCounts }>(
      `/api/notifications/log${next === 'archived' ? '?archived=1' : ''}`,
    );
    if (!result.ok) {
      setFeedback({ ok: false, message: result.message });
      return;
    }
    setRows((r) => ({ ...r, [next]: result.value.deliveries }));
    setCounts(result.value.counts);
  }

  async function switchView(next: View) {
    setView(next);
    setSelected(new Set());
    setExpanded(new Set());
    setFilter('all');
    page.setPage(0);
    setFeedback(null);
    if (rows[next] === null) await load(next);
  }

  async function act(
    action: 'archive' | 'restore' | 'delete',
    body: { ids?: string[]; olderThanDays?: number },
    done: (count: number) => string,
  ) {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await apiFetch<{ count: number; counts: NotificationLogCounts }>('/api/notifications/log', {
        method: 'POST',
        json: { action, ...body },
      });
      if (!result.ok) {
        setFeedback({ ok: false, message: result.message });
        return;
      }
      setSelected(new Set());
      setCounts(result.value.counts);
      // Both sides change on archive and restore; the other is fetched again
      // when somebody switches to it.
      setRows((r) => ({ ...r, [view === 'log' ? 'archived' : 'log']: null }));
      await load(view);
      setFeedback({ ok: true, message: done(result.value.count) });
    } finally {
      setBusy(false);
    }
  }

  const plural = (n: number) => `${n} ${n === 1 ? 'delivery' : 'deliveries'}`;
  const selectedIds = [...selected];

  function toggleGroup(group: DeliveryGroup) {
    setSelected((s) => {
      const next = new Set(s);
      const on = group.items.every((d) => next.has(d.id));
      for (const d of group.items) {
        if (on) next.delete(d.id);
        else next.add(d.id);
      }
      return next;
    });
  }

  function toggleExpanded(key: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // A pending delivery cannot be archived, so it is never offered a box.
  const selectable = (group: DeliveryGroup) => canManage && (view === 'archived' || group.newest.status !== 'pending');
  const pageSelectable = page.rows.filter(selectable);
  const pageAllTicked = pageSelectable.length > 0
    && pageSelectable.every((g) => g.items.every((d) => selected.has(d.id)));

  function togglePage() {
    setSelected((s) => {
      const next = new Set(s);
      for (const group of pageSelectable) {
        for (const d of group.items) {
          if (pageAllTicked) next.delete(d.id);
          else next.add(d.id);
        }
      }
      return next;
    });
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="-ml-1 inline-flex flex-wrap items-center gap-x-1 rounded px-1 text-left hover:bg-surface-sunken"
          >
            {open
              ? <ChevronDown className="size-4 text-ink-faint" aria-hidden />
              : <ChevronRight className="size-4 text-ink-faint" aria-hidden />}
            <span className="whitespace-nowrap">Delivery log</span>
            <span className="ml-1 text-xs font-normal text-ink-faint">
              {summarise(counts.active)}
              {counts.archived > 0 && ` · ${counts.archived} archived`}
            </span>
          </button>
        </h3>
        {open && (
          <div className="flex rounded-md border border-border p-0.5 text-xs" role="tablist">
            {(['log', 'archived'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => switchView(v)}
                className={
                  view === v
                    ? 'rounded px-2.5 py-1 font-medium text-ink bg-surface-sunken'
                    : 'rounded px-2.5 py-1 text-ink-muted hover:text-ink'
                }
              >
                {v === 'log' ? 'Log' : `Archived${counts.archived ? ` (${counts.archived})` : ''}`}
              </button>
            ))}
          </div>
        )}
      </div>

      {open && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={filter === f.value}
                  onClick={() => {
                    setFilter(f.value);
                    page.setPage(0);
                  }}
                  className={
                    filter === f.value
                      ? 'rounded-full border border-border-strong bg-surface-sunken px-2.5 py-0.5 text-xs font-medium text-ink'
                      : 'rounded-full border border-border px-2.5 py-0.5 text-xs text-ink-muted hover:text-ink'
                  }
                >
                  {f.label}
                </button>
              ))}
            </div>

            {canManage && selected.size === 0 && view === 'log' && (
              <div className="flex items-center gap-1.5">
                <Select
                  aria-label="Which deliveries to archive"
                  className="h-8 w-auto py-0 text-xs"
                  value={archiveDays}
                  onChange={(e) => setArchiveDays(Number(e.target.value))}
                  disabled={busy}
                >
                  {ARCHIVE_AGES.map((a) => (
                    <option key={a.days} value={a.days}>{a.label}</option>
                  ))}
                </Select>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || total === 0}
                  onClick={() => act('archive', { olderThanDays: archiveDays }, (n) =>
                    n ? `Archived ${plural(n)}.` : 'Nothing that old to archive.')}
                >
                  {busy ? <Loader2 aria-hidden className="animate-spin" /> : <Archive aria-hidden />}
                  Archive
                </Button>
              </div>
            )}

            {canManage && selected.size === 0 && view === 'archived' && counts.archived > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-danger"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(
                    'Delete every archived delivery for good? Anything from the last two days is kept'
                    + ' until it is older, so a reminder is never sent twice.',
                  )) return;
                  void act('delete', {}, (n) =>
                    n ? `Deleted ${plural(n)}.` : 'Nothing old enough to delete yet: archived rows are kept for two days.');
                }}
              >
                <Trash2 aria-hidden />
                Delete all archived
              </Button>
            )}

            {canManage && selected.size > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-ink-muted">
                <span className="tabular-nums">{selected.size} selected</span>
                {view === 'log' ? (
                  <Button variant="secondary" size="sm" disabled={busy}
                    onClick={() => act('archive', { ids: selectedIds }, (n) => `Archived ${plural(n)}.`)}>
                    <Archive aria-hidden />
                    Archive
                  </Button>
                ) : (
                  <>
                    <Button variant="secondary" size="sm" disabled={busy}
                      onClick={() => act('restore', { ids: selectedIds }, (n) => `Restored ${plural(n)} to the log.`)}>
                      <ArchiveRestore aria-hidden />
                      Restore
                    </Button>
                    <Button variant="ghost" size="sm" className="text-danger" disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Delete ${plural(selected.size)} for good?`)) return;
                        void act('delete', { ids: selectedIds }, (n) =>
                          n === selected.size
                            ? `Deleted ${plural(n)}.`
                            : `Deleted ${plural(n)}. The rest are under two days old and are kept until then.`);
                      }}>
                      <Trash2 aria-hidden />
                      Delete
                    </Button>
                  </>
                )}
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            )}
          </div>

          {feedback && (
            <p className={feedback.ok ? 'text-xs text-ok' : 'text-xs text-danger'}>{feedback.message}</p>
          )}

          {current === null ? (
            <p className="flex items-center gap-2 text-xs text-ink-faint">
              <Loader2 aria-hidden className="size-3.5 animate-spin" /> Loading…
            </p>
          ) : groups.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-3 text-xs text-ink-faint">
              {view === 'archived'
                ? 'Nothing archived.'
                : filter === 'all' ? 'Nothing has been sent yet.' : 'Nothing matches this filter.'}
            </p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border text-xs">
              {canManage && pageSelectable.length > 0 && (
                <label className="flex items-center gap-2 bg-surface-sunken px-3 py-1.5 text-ink-faint">
                  <input type="checkbox" checked={pageAllTicked} onChange={togglePage} />
                  Select this page
                </label>
              )}
              {page.rows.map((group) => {
                const d = group.newest;
                const isOpen = expanded.has(group.key);
                const ticked = group.items.every((i) => selected.has(i.id));
                return (
                  <div key={group.key}>
                    <div className="flex items-center gap-2 px-3 py-1.5">
                      {canManage && (
                        <input
                          type="checkbox"
                          aria-label="Select"
                          className={selectable(group) ? '' : 'invisible'}
                          disabled={!selectable(group)}
                          checked={ticked}
                          onChange={() => toggleGroup(group)}
                        />
                      )}
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() => toggleExpanded(group.key)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-ink">{d.subject}</span>
                          {/* Below the subject on a phone, where one line has no room for both. */}
                          <span className="block truncate text-ink-faint sm:hidden">
                            {d.destination} · {formatDateTime(d.createdAt)}
                          </span>
                        </span>
                        {group.items.length > 1 && (
                          <Badge tone="neutral" className="tabular-nums">×{group.items.length}</Badge>
                        )}
                        <span className="hidden shrink-0 text-ink-faint sm:inline">{d.destination}</span>
                        <span className="hidden shrink-0 tabular-nums text-ink-faint sm:inline">
                          {formatDateTime(d.createdAt)}
                        </span>
                        {isOpen
                          ? <ChevronDown className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                          : <ChevronRight className="size-3.5 shrink-0 text-ink-faint" aria-hidden />}
                      </button>
                    </div>
                    {isOpen && (
                      <div className="space-y-1 bg-surface-sunken/50 px-3 pb-2 pt-1 sm:pl-9">
                        <div className="text-ink-muted">
                          {d.subject}
                          <span className="text-ink-faint"> · {d.destination} · {d.event}</span>
                        </div>
                        {group.items.map((item) => (
                          <div key={item.id} className="text-ink-faint">
                            {formatDateTime(item.createdAt)}
                            {item.deliveredAt && ` · delivered ${formatDateTime(item.deliveredAt)}`}
                            {` · ${item.attempts} ${item.attempts === 1 ? 'attempt' : 'attempts'}`}
                            {item.responseCode !== null && ` · HTTP ${item.responseCode}`}
                            {item.error && <span className="text-danger"> · {item.error}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <Pager {...page} noun={groups.length === 1 ? 'row' : 'rows'} />

          {current !== null && current.length >= limit && total > current.length && (
            <p className="text-xs text-ink-faint">
              Showing the newest {limit} of {total}.
              {view === 'log' && ' Archive older deliveries to see the rest.'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
