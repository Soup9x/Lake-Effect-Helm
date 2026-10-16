'use client';

/**
 * Backups, from inside Helm (0820): when, where, how many to keep, and
 * whether last night's actually happened.
 *
 * THE DESTINATION IS A SETTING; ITS CREDENTIALS ARE NOT. A folder under the
 * mounted backup root or a bucket and prefix are chosen here. The object
 * store's keys and the passphrase the archives are sealed with live in .env
 * and the secrets directory with the master key, and the card says what is
 * missing rather than offering a destination that cannot work.
 *
 * THE BANNER IS THE POINT. A backup that silently stopped is the failure
 * mode; the card shows the last successful run and turns amber when it is
 * older than two schedule intervals.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, CheckCircle2, Loader2, Play, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { FieldHint, Input, Label, Select } from './ui/field';
import { apiFetch } from '@/lib/ui/api';
import { formatDateTime } from '@/lib/ui/format';
import { formatBytes } from '@/lib/ui/documents';
import { cronProblem, describeCron, nextRun } from '@/lib/backups/cron';
import { lastSuccessfulBackup, type BackupCapabilities, type BackupRun, type BackupSettings } from '@/lib/backups/settings';

const PRESETS: { label: string; cron: string }[] = [
  { label: 'Daily at 02:00 UTC', cron: '0 2 * * *' },
  { label: 'Twice a day (02:00 and 14:00 UTC)', cron: '0 2,14 * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Weekly, Sunday 03:00 UTC', cron: '0 3 * * 0' },
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function BackupSettingsCard({
  initial,
  runs,
  capabilities,
  canManage,
}: {
  initial: BackupSettings;
  runs: BackupRun[];
  capabilities: BackupCapabilities;
  canManage: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<BackupSettings>(initial);
  const [custom, setCustom] = useState(!PRESETS.some((p) => p.cron === initial.schedule));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof BackupSettings>(key: K, value: BackupSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const scheduleProblem = cronProblem(form.schedule);
  const last = lastSuccessfulBackup(runs);
  const open = runs.find((r) => r.status === 'requested' || r.status === 'running');

  // Stale: no success within two intervals of the schedule, while enabled.
  let stale: string | null = null;
  if (initial.enabled && !scheduleProblem) {
    const now = new Date();
    const next = nextRun(initial.schedule, now);
    const after = nextRun(initial.schedule, next);
    const interval = after.getTime() - next.getTime();
    const lastAt = last ? new Date(last.finishedAt ?? last.requestedAt).getTime() : 0;
    if (now.getTime() - lastAt > 2 * interval) {
      stale = last
        ? `The last successful backup was ${formatDateTime(last.finishedAt ?? last.requestedAt)}; more than two intervals ago.`
        : 'Backups are enabled but none has succeeded yet.';
    }
  }

  async function save() {
    setBusy('save'); setError(null); setSaved(false);
    try {
      const result = await apiFetch<{ settings: BackupSettings }>('/api/tenant/backups', {
        method: 'PUT',
        json: {
          enabled: form.enabled,
          schedule: form.schedule.trim(),
          destinationKind: form.destinationKind,
          localSubdir: form.localSubdir.trim(),
          s3Bucket: form.s3Bucket?.trim() || null,
          s3Prefix: form.s3Prefix.trim(),
          s3Endpoint: form.s3Endpoint?.trim() || null,
          s3Region: form.s3Region.trim() || 'us-east-1',
          keepDays: form.keepDays,
          keepCount: form.keepCount,
          includeVolumes: form.includeVolumes,
          verifyWeekday: form.verifyWeekday,
        },
      });
      if (!result.ok) { setError(result.message); return; }
      setForm(result.value!.settings);
      setSaved(true);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function run(kind: 'backup' | 'verify') {
    setBusy(kind); setError(null);
    try {
      const result = await apiFetch('/api/tenant/backups/run', { json: { kind } });
      if (!result.ok) { setError(result.message); return; }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const statusIcon = (r: BackupRun) =>
    r.status === 'succeeded' ? <CheckCircle2 className="size-4 text-ok" aria-label="Succeeded" />
      : r.status === 'failed' ? <XCircle className="size-4 text-danger" aria-label="Failed" />
        : <Loader2 className="size-4 animate-spin text-ink-faint" aria-label={r.status} />;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Archive className="size-4 text-ink-faint" aria-hidden /> Backups
          {initial.enabled ? <Badge tone="ok">On</Badge> : <Badge tone="warning">Off</Badge>}
        </CardTitle>
        {canManage && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={busy !== null || !!open || !capabilities.passphraseConfigured}
                    onClick={() => void run('backup')} title={open ? 'A run is already queued' : undefined}>
              {busy === 'backup' ? <Loader2 className="animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
              Back up now
            </Button>
            <Button variant="ghost" size="sm" disabled={busy !== null || !!open || !last}
                    onClick={() => void run('verify')} title={last ? 'Restore the newest backup into a scratch database and compare' : 'Nothing to verify yet'}>
              <ShieldCheck className="size-3.5" aria-hidden /> Verify now
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {/* ------------------------------------------------------------ status */}
        <div className="space-y-2 text-sm">
          {!capabilities.passphraseConfigured && (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                No backup passphrase is configured, so the service cannot seal an archive. Create
                <code className="mx-1 font-mono text-xs">deploy/secrets/backup.pass</code>
                (the install guide, §7) and recreate the backup container.
              </span>
            </p>
          )}
          {stale && (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{stale}</span>
            </p>
          )}
          <p className="text-ink-muted">
            {last
              ? <>Last successful backup {formatDateTime(last.finishedAt ?? last.requestedAt)}{last.bytes ? ` · ${formatBytes(last.bytes)}` : ''}{last.location ? ` · ${last.location}` : ''}.</>
              : 'No successful backup recorded yet.'}
            {initial.enabled && !scheduleProblem && <> Next scheduled {formatDateTime(nextRun(initial.schedule, new Date()).toISOString())}.</>}
          </p>
          <p className="text-xs text-ink-faint">
            A backup is a consistent database dump plus the documents, passphrase, anchor and Caddy volumes,
            each sealed with the backup passphrase. The master key is never included: keep its copy somewhere the
            backups are not.
          </p>
        </div>

        {/* ------------------------------------------------------------ settings */}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2">
            <input type="checkbox" checked={form.enabled} disabled={!canManage}
                   onChange={(e) => set('enabled', e.target.checked)} />
            Run backups on a schedule
          </label>

          <div>
            <Label htmlFor="bk-schedule">Schedule</Label>
            <Select
              id="bk-schedule"
              value={custom ? 'custom' : form.schedule}
              disabled={!canManage}
              onChange={(e) => {
                if (e.target.value === 'custom') { setCustom(true); return; }
                setCustom(false); set('schedule', e.target.value);
              }}
            >
              {PRESETS.map((p) => <option key={p.cron} value={p.cron}>{p.label}</option>)}
              <option value="custom">Custom (cron)</option>
            </Select>
            {custom && (
              <Input className="mt-2 font-mono" value={form.schedule} disabled={!canManage}
                     onChange={(e) => set('schedule', e.target.value)} placeholder="0 2 * * *" />
            )}
            <FieldHint>
              {scheduleProblem ? <span className="text-danger">{scheduleProblem}</span> : describeCron(form.schedule)}. Times are UTC.
            </FieldHint>
          </div>

          <div>
            <Label htmlFor="bk-verify">Restore rehearsal</Label>
            <Select id="bk-verify" value={form.verifyWeekday === null ? '' : String(form.verifyWeekday)} disabled={!canManage}
                    onChange={(e) => set('verifyWeekday', e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">Never</option>
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>Weekly, {d}</option>)}
            </Select>
            <FieldHint>Restores the newest dump into a scratch database and compares row counts. An untested backup is a hope.</FieldHint>
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="bk-dest">Destination</Label>
            <Select id="bk-dest" value={form.destinationKind} disabled={!canManage}
                    onChange={(e) => set('destinationKind', e.target.value as 'local' | 's3')}>
              <option value="local">Folder on the host</option>
              <option value="s3" disabled={!capabilities.s3Configured}>
                Object store (S3-compatible){capabilities.s3Configured ? '' : ' — keys not configured in .env'}
              </option>
            </Select>
          </div>

          {form.destinationKind === 'local' ? (
            <div className="sm:col-span-2">
              <Label htmlFor="bk-subdir">Folder</Label>
              <div className="flex items-center gap-2">
                <span className="shrink-0 font-mono text-xs text-ink-faint">{capabilities.localRoot}/</span>
                <Input id="bk-subdir" value={form.localSubdir} disabled={!canManage} placeholder="(root)"
                       onChange={(e) => set('localSubdir', e.target.value)} />
              </div>
              <FieldHint>
                Inside the backup directory mounted into the container (HELM_BACKUP_DIR in .env). Point that mount at
                a NAS or a second disk; a backup on the same disk as the database survives a bad upgrade, not a dead host.
              </FieldHint>
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="bk-bucket">Bucket</Label>
                <Input id="bk-bucket" value={form.s3Bucket ?? ''} disabled={!canManage}
                       onChange={(e) => set('s3Bucket', e.target.value)} />
              </div>
              <div>
                <Label htmlFor="bk-prefix">Prefix</Label>
                <Input id="bk-prefix" value={form.s3Prefix} disabled={!canManage}
                       onChange={(e) => set('s3Prefix', e.target.value)} />
              </div>
              <div>
                <Label htmlFor="bk-endpoint">Endpoint</Label>
                <Input id="bk-endpoint" value={form.s3Endpoint ?? ''} disabled={!canManage} placeholder="https://s3.example.com (blank for AWS)"
                       onChange={(e) => set('s3Endpoint', e.target.value)} />
              </div>
              <div>
                <Label htmlFor="bk-region">Region</Label>
                <Input id="bk-region" value={form.s3Region} disabled={!canManage}
                       onChange={(e) => set('s3Region', e.target.value)} />
              </div>
            </>
          )}

          <div>
            <Label htmlFor="bk-days">Keep for (days)</Label>
            <Input id="bk-days" type="number" min={1} max={3650} value={form.keepDays} disabled={!canManage}
                   onChange={(e) => set('keepDays', Number(e.target.value))} />
          </div>
          <div>
            <Label htmlFor="bk-count">Always keep the newest</Label>
            <Input id="bk-count" type="number" min={1} max={1000} value={form.keepCount} disabled={!canManage}
                   onChange={(e) => set('keepCount', Number(e.target.value))} />
            <FieldHint>Whichever rule keeps more wins, and the newest backup is never pruned.</FieldHint>
          </div>

          <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2">
            <input type="checkbox" checked={form.includeVolumes} disabled={!canManage}
                   onChange={(e) => set('includeVolumes', e.target.checked)} />
            Include the documents, passphrase, anchor and Caddy volumes
          </label>
        </div>

        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {saved && !error && <p className="text-sm text-ok">Saved. The service picks the change up within a minute.</p>}

        {canManage && (
          <div className="flex gap-2 border-t border-border pt-3">
            <Button variant="primary" size="sm" onClick={() => void save()}
                    disabled={busy !== null || scheduleProblem !== null || (form.destinationKind === 's3' && !(form.s3Bucket ?? '').trim())}>
              {busy === 'save' && <Loader2 className="animate-spin" aria-hidden />} Save
            </Button>
          </div>
        )}

        {/* ------------------------------------------------------------ runs */}
        <div>
          <h4 className="mb-1 text-sm font-medium text-ink">Recent runs</h4>
          {runs.length === 0 ? (
            <p className="text-sm text-ink-faint">None yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-muted">
                <tr>
                  <th className="py-1 pr-3 font-medium">When</th>
                  <th className="py-1 pr-3 font-medium">Kind</th>
                  <th className="py-1 pr-3 font-medium">Result</th>
                  <th className="py-1 pr-3 font-medium">Size</th>
                  <th className="py-1 pr-3 font-medium">Where</th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 10).map((r) => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-ink-muted">{formatDateTime(r.startedAt ?? r.requestedAt)}</td>
                    <td className="py-1.5 pr-3 text-ink">{r.kind === 'verify' ? 'Verify' : 'Backup'}<span className="text-xs text-ink-faint"> · {r.trigger}</span></td>
                    <td className="py-1.5 pr-3">
                      <span className="flex items-center gap-1.5">{statusIcon(r)}<span className="text-ink-muted">{r.status}</span></span>
                      {r.error && <div className="mt-0.5 max-w-md break-words text-xs text-danger">{r.error}</div>}
                    </td>
                    <td className="py-1.5 pr-3 text-ink-muted">{r.bytes ? formatBytes(r.bytes) : '—'}</td>
                    <td className="py-1.5 pr-3 break-all font-mono text-xs text-ink-faint">{r.location ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
