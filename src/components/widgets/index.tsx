import Link from 'next/link';
import {
  Building2, Clock, Gauge, KeyRound, MapPin, Radio, ScrollText, Star, Users,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, severityTone } from '@/components/ui/badge';
import { HealthDot, type ClientHealth } from '@/components/ui/health-dot';
import {
  Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { formatDate, formatDateTime, humanise, relativeDays } from '@/lib/ui/format';
import { syncLabel, syncState, syncTone, type SyncMapping } from '@/lib/ui/sync-health';
import type { FavoriteClient, RecentItem } from '@/lib/workspace/queries';

/**
 * The dashboard's widgets.
 *
 * Each takes data it was given and renders it. None of them queries: the page
 * fetches only what the user's layout actually asks for, so a dashboard without
 * the activity widget does not read the audit log. A widget that fetched its
 * own data would make that impossible to see, and five widgets each opening
 * their own transaction is five times the connection hold on every dashboard
 * load.
 */

export function FavoritesWidget({ favorites }: { favorites: FavoriteClient[] }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Star className="size-4 text-ink-faint" aria-hidden /> Pinned clients
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {favorites.length === 0 ? (
          <p className="text-ink-faint">
            Nothing pinned yet. The star on a client adds it here.
          </p>
        ) : (
          favorites.map((client) => (
            <div key={client.organizationId} className="flex items-center justify-between gap-3 py-1">
              <Link
                href={`/organizations/${client.organizationId}`}
                className="min-w-0 truncate font-medium text-ink hover:text-brand"
              >
                {client.name}
              </Link>
              {/*
                The real tallies, not zeros. Passing zeros made
                healthExplanation() render "At risk . : *.acme.test" — an
                empty count list followed by the colon that was meant to
                separate it from the reasons.
              */}
              {/* showLabel, like the health widget. A bare coloured dot with the
                  label hidden is exactly the colour-only signal this component
                  exists to avoid, and there is room for three words. */}
              <HealthDot showLabel organizationId={client.organizationId} health={client} />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function RecentlyViewedWidget({ recent }: { recent: RecentItem[] }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="size-4 text-ink-faint" aria-hidden /> Recently viewed
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {recent.length === 0 ? (
          <p className="text-ink-faint">Clients and assets you open appear here.</p>
        ) : (
          recent.map((item) => (
            <div key={`${item.kind}-${item.id}`} className="py-1">
              <Link href={item.href} className="truncate font-medium text-ink hover:text-brand">
                {item.name}
              </Link>
              {item.context && (
                <span className="ml-2 text-xs text-ink-faint">{item.context}</span>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export interface UpcomingRow {
  id: string;
  organization_name: string;
  kind: string;
  label: string;
  expires_at: Date;
  severity: string;
  days_remaining: number;
}

export function ExpirationsWidget({ upcoming }: { upcoming: UpcomingRow[] }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Next 45 days</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Item</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Severity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {upcoming.length === 0 && (
              <TableEmpty colSpan={5}>Nothing expires in the next 45 days.</TableEmpty>
            )}
            {upcoming.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">{row.label}</TableCell>
                <TableCell className="text-ink-muted">{row.organization_name}</TableCell>
                <TableCell className="text-ink-muted">{humanise(row.kind)}</TableCell>
                <TableCell className="text-ink-muted">
                  {formatDate(row.expires_at)}
                  <span className="ml-2 text-xs text-ink-faint">
                    {relativeDays(row.days_remaining)}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge tone={severityTone(row.severity)}>{row.severity}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export interface ActivityRow {
  event_uid: string;
  occurred_at: Date;
  actor_label: string;
  action: string;
  outcome: string;
  organization_name: string | null;
}

export function ActivityWidget({ activity }: { activity: ActivityRow[] }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollText className="size-4 text-ink-faint" aria-hidden /> Recent activity
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {activity.length === 0 ? (
          <p className="text-ink-faint">Nothing recorded yet.</p>
        ) : (
          activity.map((row) => (
            <div key={row.event_uid} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                <span className="truncate text-ink">{row.actor_label}</span>{' '}
                <span className="text-ink-muted">{row.action}</span>
                {row.organization_name && (
                  <span className="text-ink-faint"> · {row.organization_name}</span>
                )}
                {/* Denials are the rows worth reading. An audit feed where a
                    refusal looks like a success is a feed nobody reads. */}
                {row.outcome !== 'success' && (
                  <Badge tone={row.outcome === 'denied' ? 'warning' : 'danger'} className="ml-1.5">
                    {row.outcome}
                  </Badge>
                )}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-ink-faint">
                {formatDateTime(row.occurred_at)}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export interface ClientHealthRow extends ClientHealth {
  organizationId: string;
  name: string;
}

/**
 * Red, amber, green across every client, worst first.
 *
 * Sorted by severity rather than alphabetically on purpose: the point of the
 * widget is the top of it. A list ordered by name puts the client that is on
 * fire wherever the alphabet happens to place them.
 */
export function ClientHealthWidget({ clients }: { clients: ClientHealthRow[] }) {
  const rank = (health: string) => (health === 'red' ? 0 : health === 'amber' ? 1 : 2);
  const sorted = [...clients].sort(
    (a, b) => rank(a.health) - rank(b.health) || a.name.localeCompare(b.name),
  );
  const red = clients.filter((c) => c.health === 'red').length;
  const amber = clients.filter((c) => c.health === 'amber').length;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="size-4 text-ink-faint" aria-hidden /> Client health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p className="pb-1 text-xs text-ink-muted">
          {red} at risk · {amber} to watch · {clients.length - red - amber} healthy
        </p>
        {sorted.slice(0, 8).map((client) => (
          <div key={client.organizationId} className="flex items-center justify-between gap-3 py-0.5">
            <Link
              href={`/organizations/${client.organizationId}`}
              className="min-w-0 truncate text-ink hover:text-brand"
            >
              {client.name}
            </Link>
            <HealthDot showLabel organizationId={client.organizationId} health={client} />
          </div>
        ))}
        {sorted.length > 8 && (
          <Link href="/organizations" className="block pt-1 text-xs text-brand hover:underline">
            All {sorted.length} clients
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export interface UsageTotals {
  organizations: number;
  secrets: number;
  assets: number;
  sites: number;
  contacts: number;
  attachments: number;
}

/**
 * What is documented, at a glance.
 *
 * SCOPED BY RLS LIKE EVERYTHING ELSE, which is the whole reason this is a
 * per-actor query rather than a cached global total: a co-managed client user
 * sees their own organisation's counts from the same statement a super admin
 * runs across every client. A "total documents in the system" figure would
 * either leak the size of the tenant to a customer or need a second query with
 * a different WHERE, and the second query is the one that eventually gets its
 * condition backwards.
 *
 * Deliberately not a breakdown. The counter strip at the top of the dashboard
 * already carries the numbers that mean somebody has to act today; this is the
 * shape of the estate, which is a different question and a calmer one.
 */
export function UsageSummaryWidget({ totals }: { totals: UsageTotals }) {
  const tiles = [
    { icon: Building2, label: 'Clients', value: totals.organizations, href: '/organizations' },
    { icon: KeyRound, label: 'Credentials', value: totals.secrets },
    { icon: Gauge, label: 'Assets', value: totals.assets },
    { icon: MapPin, label: 'Sites', value: totals.sites },
    { icon: Users, label: 'Contacts', value: totals.contacts },
    { icon: ScrollText, label: 'Attachments', value: totals.attachments },
  ] as const;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="size-4 text-ink-faint" aria-hidden /> What is documented
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-3 gap-3">
          {tiles.map(({ icon: Icon, label, value, ...rest }) => {
            const body = (
              <div className="rounded-md border border-border px-3 py-2">
                <dt className="flex items-center gap-1.5 text-xs text-ink-muted">
                  <Icon className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                  {label}
                </dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-ink">
                  {value}
                </dd>
              </div>
            );
            const href = 'href' in rest ? (rest as { href?: string }).href : undefined;
            return (
              <div key={label}>
                {href ? (
                  <Link href={href} className="block transition-colors hover:opacity-80">
                    {body}
                  </Link>
                ) : (
                  body
                )}
              </div>
            );
          })}
        </dl>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export interface SyncMappingRow extends SyncMapping {
  id: string;
  name: string;
  organizationName: string;
  lastPollError: string | null;
}

/**
 * Every UniFi controller Helm polls, and when it last answered.
 *
 * The state comes from src/lib/ui/sync-health.ts rather than from the helpers
 * in unifi-settings.tsx, and the difference between them is the point: the
 * settings card reports a mapping whose last poll SUCCEEDED as "Polling",
 * however long ago that was. This one calls it stale after three missed
 * intervals, because "nothing is red and the documentation is three weeks old"
 * is the failure that hides.
 *
 * Takes rows rather than fetching, like every other widget here: a dashboard
 * without this widget does not query helm.unifi_mappings().
 */
export function SyncStatusWidget({ mappings }: { mappings: SyncMappingRow[] }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radio className="size-4 text-ink-faint" aria-hidden /> Network sync
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {mappings.length === 0 ? (
          <p className="text-ink-faint">
            No UniFi controllers are configured.{' '}
            <Link href="/settings" className="text-brand hover:underline">
              Settings
            </Link>{' '}
            adds one.
          </p>
        ) : (
          mappings.map((mapping) => {
            const state = syncState(mapping);
            return (
              <div key={mapping.id} className="flex items-start justify-between gap-3 py-1">
                <div className="min-w-0">
                  <div className="truncate font-medium text-ink">{mapping.name}</div>
                  <div className="truncate text-xs text-ink-faint">
                    {mapping.organizationName}
                    {mapping.lastPollAt
                      ? ` · last answered ${formatDateTime(mapping.lastPollAt)}`
                      : ' · not yet polled'}
                  </div>
                  {/*
                    The error, when there is one. A badge saying "Erroring" with
                    no cause sends somebody to the settings page to find out
                    what this line already knows.
                  */}
                  {state === 'erroring' && mapping.lastPollError && (
                    <div className="truncate text-xs text-danger">{mapping.lastPollError}</div>
                  )}
                </div>
                <Badge tone={syncTone(state)}>{syncLabel(state)}</Badge>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
