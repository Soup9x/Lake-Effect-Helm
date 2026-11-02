import Link from 'next/link';
import {
  Bell, CalendarClock, Globe, ListChecks, MonitorSmartphone, PlugZap, ShieldCheck,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, severityTone, type BadgeTone } from '@/components/ui/badge';
import { formatDate, formatDateTime, relativeDays } from '@/lib/ui/format';
import {
  providerLabel, type DeviceAttentionRow, type ExpiringRow, type IntegrationHealthRow,
  type IntegrationState,
} from '@/lib/workspace/dashboard-data';
import type { InboxItem } from '@/lib/notifications/inbox';
import type { TaskRow } from '@/lib/sops/queries';
import { MarkAllReadButton } from './mark-all-read';

/**
 * The widgets that read integration data (1230): integration health, devices
 * needing attention, domains, warranties, plus the personal notifications and
 * tasks lists. Like every widget, each renders what it was handed and queries
 * nothing.
 */

function WidgetCard({
  icon: Icon, title, action, children,
}: {
  icon: typeof Bell;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-ink-faint" aria-hidden /> {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="space-y-1 text-sm">{children}</CardContent>
    </Card>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-ink-faint">{children}</p>;
}

function More({ shown, total, href, noun }: { shown: number; total: number; href: string; noun: string }) {
  if (total <= shown) return null;
  return (
    <p className="pt-1 text-xs">
      <Link href={href} className="text-brand hover:underline">
        {total - shown} more {noun}
      </Link>
    </p>
  );
}

// ---------------------------------------------------------------------------

const STATE_LABEL: Record<IntegrationState, string> = {
  healthy: 'Healthy',
  failing: 'Failing',
  partial: 'Partial',
  stale: 'Stale',
  paused: 'Paused',
  waiting: 'Not yet synced',
};

const STATE_TONE: Record<IntegrationState, BadgeTone> = {
  healthy: 'ok',
  failing: 'danger',
  partial: 'warning',
  stale: 'warning',
  paused: 'neutral',
  waiting: 'neutral',
};

export function IntegrationHealthWidget({ rows }: { rows: IntegrationHealthRow[] }) {
  const problems = rows.filter((r) => r.state !== 'healthy' && r.state !== 'paused').length;
  return (
    <WidgetCard
      icon={PlugZap}
      title="Integration health"
      action={rows.length > 0 && (
        <Badge tone={problems > 0 ? 'warning' : 'ok'}>
          {problems > 0 ? `${problems} need${problems === 1 ? 's' : ''} a look` : 'All syncing'}
        </Badge>
      )}
    >
      {rows.length === 0 ? (
        <Empty>
          No integrations are connected.{' '}
          <Link href="/settings/integrations" className="text-brand hover:underline">
            Administration → Integrations
          </Link>{' '}
          sets one up.
        </Empty>
      ) : (
        rows.map((row) => (
          <div key={row.id} className="flex items-start justify-between gap-3 py-1">
            <div className="min-w-0">
              <Link
                href="/settings/integrations"
                className="block truncate font-medium text-ink hover:text-brand"
              >
                {providerLabel(row.provider)}
                {row.organizationName && (
                  <span className="font-normal text-ink-muted"> · {row.organizationName}</span>
                )}
              </Link>
              <div className="truncate text-xs text-ink-faint">
                {row.lastSuccessAt
                  ? `Last good sync ${formatDateTime(row.lastSuccessAt)}`
                  : row.lastSyncAt
                    ? `Last tried ${formatDateTime(row.lastSyncAt)}`
                    : 'Has not run yet'}
                {row.consecutiveFailures > 1 && ` · ${row.consecutiveFailures} failures in a row`}
              </div>
              {row.message && (
                <div
                  className={`line-clamp-2 text-xs ${row.state === 'failing' ? 'text-danger' : 'text-sev-warning'}`}
                  title={row.message}
                >
                  {row.message}
                </div>
              )}
            </div>
            <Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>
          </div>
        ))
      )}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------

export function DeviceAttentionWidget({ rows, total }: { rows: DeviceAttentionRow[]; total: number }) {
  return (
    <WidgetCard
      icon={MonitorSmartphone}
      title="Devices needing attention"
      action={total > 0 && <Badge tone="warning">{total}</Badge>}
    >
      {rows.length === 0 ? (
        <Empty>
          <ShieldCheck className="mr-1 inline size-4 text-ok" aria-hidden />
          Nothing from NinjaOne or Action1 needs a look: no devices offline, short of disk,
          behind on critical patches or waiting on a reboot.
        </Empty>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.nodeId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
              <div className="min-w-0 flex-1 basis-48">
                <Link
                  href={`/assets/${row.nodeId}`}
                  className="block truncate font-medium text-ink hover:text-brand"
                >
                  {row.name}
                </Link>
                <div className="truncate text-xs text-ink-faint">
                  <Link href={`/organizations/${row.organizationId}`} className="hover:text-brand">
                    {row.organizationName}
                  </Link>
                  {' · '}
                  {row.sources.join(' + ')}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {row.issues.map((issue) => (
                  <Badge
                    key={issue}
                    tone={/^(Offline|Not seen|Agent)|critical|^Antivirus/.test(issue) ? 'danger' : 'warning'}
                  >
                    {issue}
                  </Badge>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      <More shown={rows.length} total={total} href="/global/assets" noun="devices" />
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------

function ExpiringList({
  rows, total, empty, moreHref, noun,
}: {
  rows: ExpiringRow[];
  total: number;
  empty: string;
  moreHref: string;
  noun: string;
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <>
      {rows.map((row) => (
        <div key={row.id} className="flex items-start justify-between gap-3 py-1">
          <div className="min-w-0">
            {row.nodeId ? (
              <Link
                href={`/assets/${row.nodeId}`}
                className="block truncate font-medium text-ink hover:text-brand"
              >
                {row.label}
              </Link>
            ) : (
              <span className="block truncate font-medium text-ink">{row.label}</span>
            )}
            <div className="truncate text-xs text-ink-faint">
              {row.organizationName} · {formatDate(row.expiresAt)}
              {row.autoRenew && ' · auto-renews'}
            </div>
          </div>
          <Badge tone={severityTone(row.severity)} className="shrink-0">
            {relativeDays(row.daysRemaining)}
          </Badge>
        </div>
      ))}
      <More shown={rows.length} total={total} href={moreHref} noun={noun} />
    </>
  );
}

export function ExpiringDomainsWidget({ rows, total }: { rows: ExpiringRow[]; total: number }) {
  return (
    <WidgetCard icon={Globe} title="Expiring domains">
      <ExpiringList
        rows={rows}
        total={total}
        empty="No domain registrations run out in the next 90 days."
        moreHref="/expirations"
        noun="domains"
      />
    </WidgetCard>
  );
}

export function ExpiringWarrantiesWidget({ rows, total }: { rows: ExpiringRow[]; total: number }) {
  return (
    <WidgetCard icon={CalendarClock} title="Expiring warranties">
      <ExpiringList
        rows={rows}
        total={total}
        empty="No device warranties end in the next 90 days."
        moreHref="/expirations"
        noun="warranties"
      />
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------

export function NotificationsWidget({ items, unread }: { items: InboxItem[]; unread: number }) {
  return (
    <WidgetCard
      icon={Bell}
      title="Notifications"
      action={unread > 0 && <MarkAllReadButton />}
    >
      {items.length === 0 ? (
        <Empty>You are all caught up.</Empty>
      ) : (
        <>
          {items.map((item) => {
            const body = (
              <>
                <span className="block text-ink">{item.subject}</span>
                <span className="block truncate text-xs text-ink-faint">
                  {item.organizationName ? `${item.organizationName} · ` : ''}
                  {formatDateTime(item.occurredAt)}
                </span>
              </>
            );
            return (
              <div key={item.id} className="flex items-start gap-2 py-1">
                <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" />
                {item.href ? (
                  <Link href={item.href} className="min-w-0 hover:text-brand">{body}</Link>
                ) : (
                  <span className="min-w-0">{body}</span>
                )}
              </div>
            );
          })}
          {unread > items.length && (
            <p className="pt-1 text-xs text-ink-faint">
              {unread - items.length} more unread in the bell.
            </p>
          )}
        </>
      )}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------

export function MyTasksWidget({ tasks, open }: { tasks: TaskRow[]; open: number }) {
  return (
    <WidgetCard
      icon={ListChecks}
      title="My tasks"
      action={<Link href="/tasks" className="text-xs text-brand hover:underline">All tasks</Link>}
    >
      {tasks.length === 0 ? (
        <Empty>Nothing is assigned to you.</Empty>
      ) : (
        <>
          {tasks.map((task) => (
            <div key={task.stepId} className="flex items-start justify-between gap-3 py-1">
              <div className="min-w-0">
                <Link
                  href={`/runs/${task.runId}`}
                  className="block truncate font-medium text-ink hover:text-brand"
                >
                  {task.title}
                </Link>
                <div className="truncate text-xs text-ink-faint">
                  {task.organizationName} · {task.runTitle}
                </div>
              </div>
              {task.dueAt && (
                <Badge tone={task.overdue ? 'danger' : 'neutral'} className="shrink-0">
                  {task.overdue ? 'Overdue' : `Due ${formatDate(task.dueAt)}`}
                </Badge>
              )}
            </div>
          ))}
          <More shown={tasks.length} total={open} href="/tasks" noun="tasks" />
        </>
      )}
    </WidgetCard>
  );
}
