/**
 * What Proxmox says about a host or guest beyond its own fields (1110): state,
 * disks, network, snapshots, last backup, tags; for a host, its storage and
 * how many guests it runs. Read-only — the sync rewrites it every run.
 */
import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge, type BadgeTone } from './ui/badge';
import { formatDateTime } from '@/lib/ui/format';
import type { ProxmoxProfile } from '@/lib/proxmox/machines';

const STATE: Record<string, BadgeTone> = { running: 'ok', online: 'ok', stopped: 'neutral', paused: 'warning', offline: 'danger' };

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  if (days > 0) return `${days} ${days === 1 ? 'day' : 'days'}${hours ? `, ${hours} h` : ''}`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

export function ProxmoxProfileCard({ profile, syncedAt, proxmoxUrl }: {
  profile: ProxmoxProfile;
  syncedAt: string;
  proxmoxUrl: string | null;
}) {
  const rows: [string, ReactNode][] = [];
  const push = (label: string, value: ReactNode | undefined | null) => {
    if (value !== undefined && value !== null && value !== '') rows.push([label, value]);
  };

  if (profile.status) {
    push('State', (
      <>
        <Badge tone={STATE[profile.status] ?? 'neutral'}>{profile.status}</Badge>
        {profile.uptimeSeconds && profile.status !== 'stopped' ? <span className="ml-2 text-ink-muted">up {uptime(profile.uptimeSeconds)}</span> : null}
      </>
    ));
  }

  if (profile.kind === 'node') {
    push('Cluster', profile.cluster);
    push('Proxmox VE', profile.pveVersion);
    push('Kernel', profile.kernel);
    push('Boot', profile.bootMode);
    if (profile.cpu) {
      push('CPU', [
        profile.cpu.sockets && `${profile.cpu.sockets} ${profile.cpu.sockets === 1 ? 'socket' : 'sockets'}`,
        profile.cpu.cores && `${profile.cpu.cores} cores each`,
        profile.cpu.threads && `${profile.cpu.threads} threads`,
      ].filter(Boolean).join(' · '));
    }
    push('Guests', `${profile.guests.running} running of ${profile.guests.total}`);
  } else {
    push('Type', `${profile.kind === 'lxc' ? 'Container (LXC)' : 'Virtual machine (QEMU)'} · ID ${profile.vmid}`);
    push('Host', profile.node);
    push('CPU type', profile.cpuType);
    push('Pool', profile.pool);
    push('Tags', profile.tags && (
      <span className="flex flex-wrap gap-1">{profile.tags.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}</span>
    ));
    push('High availability', profile.haState);
    if (profile.onBoot !== undefined) push('Start at boot', profile.onBoot ? 'Yes' : 'No');
    if (profile.agent) {
      push('Guest agent', profile.agent === 'answered' ? 'Running'
        : profile.agent === 'not_answering' ? <span className="text-ink-muted">Enabled, not answering</span>
          : <span className="text-ink-muted">Off</span>);
    }
    if (profile.snapshots) {
      push('Snapshots', profile.snapshots.count === 0 ? 'None' : (
        <>
          {profile.snapshots.count}
          {profile.snapshots.latestName && (
            <span className="text-ink-muted">
              {' '}· latest {profile.snapshots.latestName}
              {profile.snapshots.latestAt && `, ${formatDateTime(profile.snapshots.latestAt)}`}
            </span>
          )}
        </>
      ));
    }
    push('Last backup', profile.lastBackupAt ? formatDateTime(profile.lastBackupAt) : undefined);
  }

  const disks = profile.kind === 'node' ? [] : profile.disks;
  const nics = profile.kind === 'node' ? [] : profile.nics;
  const storage = profile.kind === 'node' ? profile.storage : [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>From Proxmox</CardTitle>
        <div className="flex items-center gap-3 text-xs text-ink-faint">
          <span>As of {formatDateTime(syncedAt)}</span>
          {proxmoxUrl && (
            <a href={proxmoxUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-brand hover:underline">
              Open in Proxmox <ExternalLink className="size-3" aria-hidden />
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
        {disks.length > 0 && (
          <div className="space-y-1">
            <p className="text-ink-muted">Disks</p>
            <ul className="space-y-0.5">
              {disks.map((d) => (
                <li key={d.name} className="flex flex-wrap justify-between gap-2">
                  <span className="text-ink">{d.name}{d.storage && <span className="text-ink-muted"> · {d.storage}</span>}</span>
                  {d.sizeGb !== undefined && <span className="tabular-nums text-ink-muted">{d.sizeGb} GB</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {nics.length > 0 && (
          <div className="space-y-1">
            <p className="text-ink-muted">Network</p>
            <ul className="space-y-0.5">
              {nics.map((n) => (
                <li key={n.name} className="text-ink">
                  {n.name}
                  <span className="text-ink-muted">
                    {n.bridge && ` · ${n.bridge}`}{n.vlan && ` · VLAN ${n.vlan}`}{n.mac && ` · ${n.mac}`}
                  </span>
                  {n.addresses && n.addresses.length > 0 && (
                    <span className="block font-mono text-xs text-ink-muted">{n.addresses.join(', ')}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {storage.length > 0 && (
          <div className="space-y-2">
            <p className="text-ink-muted">Storage</p>
            <ul className="space-y-2">
              {storage.map((s) => {
                const used = s.totalGb > 0 ? Math.min(1, s.usedGb / s.totalGb) : 0;
                const low = used > 0.9;
                return (
                  <li key={s.name} className="space-y-1">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="text-ink">
                        {s.name}
                        <span className="text-ink-muted">{s.type && ` · ${s.type}`}{s.shared && ' · shared'}</span>
                      </span>
                      <span className={low ? 'text-danger tabular-nums' : 'text-ink-muted tabular-nums'}>
                        {s.usedGb} of {s.totalGb} GB used
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
        {profile.kind !== 'node' && profile.notes && (
          <div className="space-y-1">
            <p className="text-ink-muted">Notes in Proxmox</p>
            <p className="whitespace-pre-wrap break-words text-ink">{profile.notes}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
