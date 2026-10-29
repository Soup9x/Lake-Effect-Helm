/**
 * What Action1 says about a machine beyond its own fields (1160): agent
 * status, missing updates, reboot, last user and boot, vulnerabilities, disk.
 * Read-only — the sync rewrites it every run, like NinjaOne's card.
 */
import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge, type BadgeTone } from './ui/badge';
import { formatDateTime } from '@/lib/ui/format';
import type { Action1Profile } from '@/lib/action1/devices';

const ONLINE: Record<string, { label: string; tone: BadgeTone }> = {
  SUCCESS: { label: 'Seen in the last 7 days', tone: 'ok' },
  WARNING: { label: 'Not seen for 8 to 30 days', tone: 'warning' },
  ERROR: { label: 'Not seen for over 30 days', tone: 'danger' },
};

const VULNERABILITIES: Record<string, { label: string; tone: BadgeTone }> = {
  SUCCESS: { label: 'None found', tone: 'ok' },
  WARNING: { label: 'Some found', tone: 'warning' },
  ERROR: { label: 'Critical found', tone: 'danger' },
};

export function Action1ProfileCard({ profile, syncedAt, action1Url }: {
  profile: Action1Profile;
  syncedAt: string;
  /** The machine's organization in Action1's console. */
  action1Url: string | null;
}) {
  const rows: [string, ReactNode][] = [];
  const push = (label: string, value: ReactNode | undefined | null) => {
    if (value !== undefined && value !== null && value !== '') rows.push([label, value]);
  };

  if (profile.agentStatus) {
    const connected = /^connected$/i.test(profile.agentStatus);
    const online = profile.onlineStatus ? ONLINE[profile.onlineStatus] : undefined;
    push('Agent', (
      <>
        <Badge tone={connected ? 'ok' : 'warning'}>{profile.agentStatus}</Badge>
        {online && !connected && <span className="ml-2 text-ink-muted">{online.label.toLowerCase()}</span>}
      </>
    ));
  }
  if (profile.missingUpdates) {
    const { critical, other } = profile.missingUpdates;
    push('Missing updates', critical + other === 0 ? 'None' : (
      <>
        {critical + other}
        {critical > 0 && <Badge tone="danger" className="ml-2">{critical} critical</Badge>}
      </>
    ));
  }
  if (profile.vulnerabilityStatus) {
    const v = VULNERABILITIES[profile.vulnerabilityStatus];
    if (v) push('Vulnerabilities', <Badge tone={v.tone}>{v.label}</Badge>);
  }
  push('Last logged-on user', profile.lastLoggedInUser);
  push('Last boot', profile.lastBootAt && (
    <>
      {formatDateTime(profile.lastBootAt)}
      {profile.needsReboot && <Badge tone="warning" className="ml-2">Needs a reboot</Badge>}
    </>
  ));
  if (!profile.lastBootAt && profile.needsReboot) push('Reboot', <Badge tone="warning">Needs a reboot</Badge>);
  push('Disk', profile.disk);
  push('Processor', profile.processor);
  push('Public IP', profile.publicIp);
  push('AD OU', profile.adOrganizationUnit);
  push('Platform', [profile.platform, profile.architecture].filter(Boolean).join(' · '));
  push('Agent version', profile.agentVersion);

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>From Action1</CardTitle>
        <div className="flex items-center gap-3 text-xs text-ink-faint">
          <span>As of {formatDateTime(syncedAt)}</span>
          {action1Url && (
            <a href={action1Url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-brand hover:underline">
              Open in Action1 <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </div>
      </CardHeader>
      <CardContent className="text-sm">
        <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-muted">{label}</dt>
              <dd className="break-words text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
