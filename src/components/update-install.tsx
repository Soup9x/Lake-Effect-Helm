'use client';

/**
 * Administration → Updates: installing an update from here (1210).
 *
 * The buttons write a request; the updater on the Helm server picks it up
 * within a minute, pulls the update and runs deploy/setup.sh --yes. The web
 * service restarts part way through, so the page keeps asking and says so
 * while nothing answers.
 */
import { useState } from 'react';
import { CalendarClock, CheckCircle2, Download, Loader2, TriangleAlert, XCircle } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHint, Input, Label } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { apiFetch } from '@/lib/ui/api';
import { fromDateTimeLocalInput, toDateTimeLocalInput } from '@/lib/ui/format';
import type { UpdateRequest, UpdateRequestStatus } from '@/lib/updates/requests';

const STATUS_BADGE: Record<UpdateRequestStatus, { text: string; tone: BadgeTone }> = {
  scheduled: { text: 'Scheduled', tone: 'info' },
  running: { text: 'Installing', tone: 'brand' },
  succeeded: { text: 'Installed', tone: 'ok' },
  failed: { text: 'Failed', tone: 'danger' },
  cancelled: { text: 'Cancelled', tone: 'neutral' },
};

const short = (commit: string | null) => (commit ? commit.slice(0, 7) : '?');

/**
 * In the viewer's own time zone, because that is the zone the schedule was
 * picked in. The server renders it in its own, so the first paint can differ
 * from the browser's by the offset; the browser's wins.
 */
function LocalTime({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
    </time>
  );
}

/** "Update now" and "Schedule…", each behind the password. */
export function InstallButtons({
  latest,
  onRequested,
}: {
  latest: string;
  onRequested: (request: UpdateRequest) => void;
}) {
  const [mode, setMode] = useState<'now' | 'later' | null>(null);
  const [when, setWhen] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [wantsCode, setWantsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (next: 'now' | 'later') => {
    setMode(next);
    setPassword('');
    setCode('');
    setWantsCode(false);
    setError(null);
    if (next === 'later' && !when) {
      // Tonight at 2am, local time: the usual quiet hour.
      const d = new Date();
      d.setDate(d.getDate() + (d.getHours() >= 2 ? 1 : 0));
      d.setHours(2, 0, 0, 0);
      setWhen(toDateTimeLocalInput(d));
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const at = mode === 'later' ? fromDateTimeLocalInput(when) : null;
    if (mode === 'later' && !at) {
      setError('Pick a date and time.');
      return;
    }
    setBusy(true);
    try {
      const result = await apiFetch<{ request: UpdateRequest }>('/api/tenant/updates/requests', {
        json: { password, ...(wantsCode ? { code } : {}), at },
      });
      if (result.ok) {
        setMode(null);
        onRequested(result.value.request);
        return;
      }
      if (result.details?.secondFactor === 'totp') {
        setWantsCode(true);
        setError(wantsCode ? result.message : 'Enter the code from your authenticator app as well.');
        return;
      }
      setError(result.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => open('now')}>
          <Download aria-hidden /> Update now
        </Button>
        <Button variant="secondary" onClick={() => open('later')}>
          <CalendarClock aria-hidden /> Schedule…
        </Button>
      </div>

      <Modal
        open={mode !== null}
        onOpenChange={(next) => !next && !busy && setMode(null)}
        title={mode === 'later' ? 'Schedule the update' : 'Update Helm now'}
        description={`Installs ${short(latest)} from GitHub. Helm is unavailable for a few minutes while it rebuilds and restarts.`}
        icon={Download}
      >
        <form onSubmit={submit} className="space-y-3">
          {mode === 'later' && (
            <div className="space-y-1">
              <Label htmlFor="update-when">Start at</Label>
              <Input
                id="update-when"
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                required
              />
              <FieldHint>Your local time. Up to 30 days ahead; you can cancel it until it starts.</FieldHint>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="update-password">Your password</Label>
            <Input
              id="update-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
            <FieldHint>Asked every time: this rebuilds and restarts all of Helm.</FieldHint>
          </div>
          {wantsCode && (
            <div className="space-y-1">
              <Label htmlFor="update-code">Authenticator code</Label>
              <Input
                id="update-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </div>
          )}
          {error && (
            <p className="flex items-start gap-2 text-sm text-danger">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setMode(null)} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              {mode === 'later' ? 'Schedule update' : 'Update now'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/** The update that is queued or running: when, who, how far along, and Cancel. */
export function OpenRequest({
  request,
  restarting,
  onCancelled,
}: {
  request: UpdateRequest;
  /** The page cannot reach Helm right now — expected while it restarts. */
  restarting: boolean;
  onCancelled: (request: UpdateRequest) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ request: UpdateRequest }>(`/api/tenant/updates/requests/${request.id}`, {
        method: 'DELETE',
      });
      if (result.ok) onCancelled(result.value.request);
      else setError(result.message);
    } finally {
      setBusy(false);
    }
  };

  const due = new Date(request.scheduledFor).getTime() <= Date.now();

  return (
    <div className="space-y-2 rounded-md border border-brand/40 bg-brand-tint/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {request.status === 'running' || restarting
          ? <Loader2 className="size-4 animate-spin text-brand" aria-hidden />
          : <CalendarClock className="size-4 text-brand" aria-hidden />}
        <span className="font-medium text-ink">
          {request.status === 'running'
            ? `Installing ${short(request.targetCommit)}${request.stage ? ` · ${request.stage}` : ''}`
            : due
              ? `Starting ${short(request.targetCommit)} within a minute`
              : <>Update to {short(request.targetCommit)} scheduled for <LocalTime iso={request.scheduledFor} /></>}
        </span>
        {request.requestedBy && <span className="text-ink-muted">· asked for by {request.requestedBy}</span>}
        {request.status === 'scheduled' && (
          <Button variant="secondary" size="sm" className="ml-auto" onClick={cancel} disabled={busy}>
            Cancel update
          </Button>
        )}
      </div>
      {restarting && (
        <p className="text-ink-muted">
          Helm is restarting. This page will reconnect by itself when it is back.
        </p>
      )}
      {request.status === 'running' && request.log && <LogTail log={request.log} />}
      {error && <p className="text-danger">{error}</p>}
    </div>
  );
}

function LogTail({ log }: { log: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded border border-border bg-surface-sunken p-2 font-mono text-[11px] leading-snug text-ink-muted">
      {log.split('\n').slice(-80).join('\n')}
    </pre>
  );
}

/** Earlier updates from this page, newest first. */
export function UpdateHistory({ requests }: { requests: readonly UpdateRequest[] }) {
  if (requests.length === 0) return null;
  return (
    <ul className="divide-y divide-border text-sm">
      {requests.map((r) => {
        const badge = STATUS_BADGE[r.status];
        return (
          <li key={r.id} className="space-y-1 py-2">
            <div className="flex flex-wrap items-center gap-2">
              {r.status === 'succeeded' && <CheckCircle2 className="size-4 text-ok" aria-hidden />}
              {r.status === 'failed' && <XCircle className="size-4 text-danger" aria-hidden />}
              <Badge tone={badge.tone}>{badge.text}</Badge>
              <span className="font-mono text-xs">
                {r.fromCommit ? `${short(r.fromCommit)} → ` : ''}{short(r.toCommit ?? r.targetCommit)}
              </span>
              <span className="text-ink-muted">
                {<LocalTime iso={r.finishedAt ?? r.requestedAt} />}
                {r.requestedBy && ` · ${r.requestedBy}`}
              </span>
            </div>
            {r.error && <p className="text-danger">{r.error}</p>}
            {r.log && (
              <details>
                <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink">Show the log</summary>
                <LogTail log={r.log} />
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}
