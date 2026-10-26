/**
 * What NinjaOne says about a machine beyond its own fields (1080): disks, the
 * last user and boot, antivirus, pending patches and warranty. Read-only — the
 * sync rewrites it every run, so it reads like NinjaOne's own dashboard rather
 * than like documentation somebody keeps.
 */
import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { formatDate, formatDateTime } from '@/lib/ui/format';
import type { NinjaProfile } from '@/lib/ninja/devices';

export function NinjaProfileCard({ profile, syncedAt }: { profile: NinjaProfile; syncedAt: string }) {
  const rows: [string, ReactNode][] = [];
  const push = (label: string, value: ReactNode | undefined | null) => {
    if (value !== undefined && value !== null && value !== '') rows.push([label, value]);
  };

  if (profile.offline !== undefined) {
    push('Agent', <Badge tone={profile.offline ? 'warning' : 'ok'}>{profile.offline ? 'Offline' : 'Online'}</Badge>);
  }
  push('Last logged-on user', profile.lastLoggedInUser);
  push('Last boot', profile.lastBootAt && (
    <>
      {formatDateTime(profile.lastBootAt)}
      {profile.needsReboot && <Badge tone="warning" className="ml-2">Needs a reboot</Badge>}
    </>
  ));
  if (!profile.lastBootAt && profile.needsReboot) push('Reboot', <Badge tone="warning">Needs a reboot</Badge>);
  push('Domain', profile.domain);
  push('Public IP', profile.publicIp);
  push('Architecture', profile.architecture);
  if (profile.pendingPatches) {
    const { total, critical } = profile.pendingPatches;
    push('Pending patches', total === 0 ? 'None' : (
      <>
        {total}
        {critical > 0 && <Badge tone="danger" className="ml-2">{critical} critical</Badge>}
      </>
    ));
  }
  if (profile.antivirus) {
    push('Antivirus', profile.antivirus.length === 0 ? <span className="text-ink-faint">None reported</span> : (
      <ul className="space-y-0.5">
        {profile.antivirus.map((av) => (
          <li key={av.product}>
            {av.product}
            {av.state && <span className="text-ink-muted"> · {av.state.toLowerCase().replace(/_/g, ' ')}</span>}
            {av.definitions && <span className="text-ink-muted"> · definitions {av.definitions.toLowerCase().replace(/_/g, ' ')}</span>}
          </li>
        ))}
      </ul>
    ));
  }
  if (profile.warranty) {
    const { startsAt, endsAt } = profile.warranty;
    push('Warranty', [startsAt && `from ${formatDate(startsAt)}`, endsAt && `until ${formatDate(endsAt)}`]
      .filter(Boolean).join(' '));
  }

  const volumes = profile.volumes ?? [];
  if (rows.length === 0 && volumes.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>From NinjaOne</CardTitle>
        <div className="flex items-center gap-3 text-xs text-ink-faint">
          <span>As of {formatDateTime(syncedAt)}</span>
          {profile.ninjaUrl && (
            <a href={profile.ninjaUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-brand hover:underline">
              Open in NinjaOne <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {rows.length > 0 && (
          <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-ink-muted">{label}</dt>
                <dd className="break-words text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {volumes.length > 0 && (
          <div className="space-y-2">
            <p className="text-ink-muted">Disks</p>
            <ul className="space-y-2">
              {volumes.map((v) => {
                const used = v.capacityGb > 0 ? Math.min(1, Math.max(0, 1 - v.freeGb / v.capacityGb)) : 0;
                const low = v.freeGb / v.capacityGb < 0.1;
                return (
                  <li key={`${v.name}:${v.label ?? ''}`} className="space-y-1">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="text-ink">{v.name}{v.label && <span className="text-ink-muted"> · {v.label}</span>}</span>
                      <span className={low ? 'text-danger tabular-nums' : 'text-ink-muted tabular-nums'}>
                        {v.freeGb} GB free of {v.capacityGb} GB
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
                      <div className={low ? 'h-full bg-danger' : 'h-full bg-brand'} style={{ width: `${Math.round(used * 100)}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
