import Link from 'next/link';
import { AlertTriangle, Building2, CalendarClock, FileDown, KeyRound, Plug } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { DashboardCustomise } from '@/components/dashboard-customise';
import {
  ActivityWidget, ClientHealthWidget, ExpirationsWidget, FavoritesWidget, RecentlyViewedWidget,
  type ActivityRow, type ClientHealthRow, type UpcomingRow,
  SyncStatusWidget,
  UsageSummaryWidget,
} from '@/components/widgets';
import { QuickActionsWidget } from '@/components/widgets/quick-actions';
import { isClientRole } from '@/lib/ui/roles';
import { getLayout, listFavorites, listRecent } from '@/lib/workspace/queries';
import type { WidgetKey } from '@/lib/workspace/widgets';

interface Counts {
  organizations: string;
  assets: string;
  secrets: string;
  expiring_30: string;
  expired: string;
  degraded_integrations: string;
  secret_exports_7d: string;
}

interface HealthRow {
  organization_id: string; name: string; health: string;
  expired_count: number; critical_count: number; warning_count: number;
  reasons: string[] | null;
}

/**
 * The single pane of glass, arranged by whoever is looking at it.
 *
 * Every number here is scoped by RLS to what this actor may see, so a
 * client-side co-managed user gets their own organisation's counts from the
 * same query a super admin runs across every client. There is no "if client
 * then different query" branch, which is exactly the branch that eventually
 * gets the condition backwards.
 *
 * WHAT IS AND IS NOT A WIDGET.
 *
 * The two banners and the counter strip are fixed. They are not panels somebody
 * chose to look at — they are the things that mean somebody has to do something
 * today, and a dashboard where "three credential exports left the building this
 * week" can be switched off is a dashboard where it will be. That banner
 * counted exports awaiting a second approver until 0400; with approval gone it
 * counts exports that ALREADY HAPPENED, which is no longer a queue to work
 * through but the thing somebody is expected to notice. The five widgets below
 * are arrangement: which lists you want in front of you, which is genuinely a
 * matter of what you do all day.
 *
 * Only the widgets in the layout are queried. Somebody who removed the activity
 * widget does not read the audit log on every dashboard load, and that is
 * visible here rather than buried in five components that each fetch their own.
 */
interface UsageRow {
  organizations: string; secrets: string; assets: string;
  sites: string; contacts: string; attachments: string;
}

interface QuickClientRow {
  id: string; name: string; sites: { id: string; name: string }[];
}

interface UnifiSyncRow {
  id: string; name: string; organization_name: string; is_active: boolean;
  last_poll_at: Date | null; last_poll_ok: boolean | null; last_poll_error: string | null;
  poll_interval_seconds: number; consecutive_failures: number;
}

export default async function DashboardPage() {
  const identity = await getServerIdentity();

  const data = await withTenant(actorOf(identity), async (tx) => {
    // The layout first: everything after it is conditional on what it names.
    const layout = await getLayout(tx);
    const wants = (key: WidgetKey) => layout.includes(key);

    const [countRow] = await tx<Counts[]>`
      SELECT
        (SELECT count(*) FROM organization WHERE deleted_at IS NULL) AS organizations,
        (SELECT count(*) FROM asset_node WHERE archived_at IS NULL) AS assets,
        (SELECT count(*) FROM v_secret_metadata) AS secrets,
        (SELECT count(*) FROM v_expiration_dashboard
          WHERE days_remaining BETWEEN 0 AND 30) AS expiring_30,
        (SELECT count(*) FROM v_expiration_dashboard WHERE days_remaining < 0) AS expired,
        (SELECT count(*) FROM integration_connection
          WHERE status IN ('degraded', 'error') AND disabled_at IS NULL) AS degraded_integrations,
        -- Credential exports produced in the last week. Two-person approval
        -- was removed in 0400, so this is no longer "somebody needs to act" —
        -- it is "this happened, and somebody should have noticed". A banner
        -- rather than a widget for the same reason the other one was: a number
        -- that can be switched off is a number that will be.
        (SELECT count(*) FROM export_job
          WHERE include_secrets AND revoked_at IS NULL
            AND created_at > now() - interval '7 days') AS secret_exports_7d
    `;

    const [favorites, recent, upcoming, activity, health, usage, quickClients, mappings] =
      await Promise.all([
      wants('favorites') ? listFavorites(tx) : [],
      wants('recently_viewed') ? listRecent(tx, 8) : [],
      wants('expirations')
        ? tx<UpcomingRow[]>`
            SELECT id, organization_name, kind::text, label, expires_at, severity::text,
                   days_remaining
            FROM v_expiration_dashboard
            WHERE days_remaining <= 45
            ORDER BY expires_at
            LIMIT 12
          `
        : [],
      wants('audit_activity')
        ? tx<ActivityRow[]>`
            SELECT a.event_uid, a.occurred_at, a.actor_label, a.action, a.outcome::text,
                   o.name AS organization_name
            FROM audit_log a
            LEFT JOIN organization o ON o.id = a.organization_id
            ORDER BY a.occurred_at DESC
            LIMIT 10
          `
        : [],
      wants('client_health')
        ? tx<HealthRow[]>`
            SELECT h.organization_id, h.organization_name AS name, h.health,
                   h.expired_count, h.critical_count, h.warning_count, h.reasons
            FROM v_client_health h
          `
        : [],
      // Every count RLS lets this actor see. One statement rather than six,
      // and only when the widget asking for it is on the layout.
      wants('usage_summary')
        ? tx<UsageRow[]>`
            SELECT
              (SELECT count(*) FROM organization WHERE deleted_at IS NULL) AS organizations,
              (SELECT count(*) FROM v_secret_metadata) AS secrets,
              (SELECT count(*) FROM asset_node WHERE archived_at IS NULL) AS assets,
              (SELECT count(*) FROM site WHERE deleted_at IS NULL) AS sites,
              (SELECT count(*) FROM contact) AS contacts,
              (SELECT count(*) FROM attachment WHERE deleted_at IS NULL) AS attachments
          `
        : [],
      // The clients and their sites, so the quick-action panel can hand the
      // REAL create forms exactly what they expect. Archived clients are left
      // out: starting new work on one is not a thing somebody means to do.
      wants('quick_actions')
        ? tx<QuickClientRow[]>`
            SELECT o.id, o.name,
                   coalesce(
                     jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)
                               ORDER BY s.name) FILTER (WHERE s.id IS NOT NULL),
                     '[]'::jsonb) AS sites
            FROM organization o
            LEFT JOIN site s ON s.organization_id = o.id AND s.deleted_at IS NULL
            WHERE o.deleted_at IS NULL AND o.archived_at IS NULL
            GROUP BY o.id, o.name
            ORDER BY o.is_msp_internal, o.name
          `
        : [],
      wants('sync_status')
        ? tx<UnifiSyncRow[]>`
            SELECT id, name, organization_name, is_active, last_poll_at, last_poll_ok,
                   last_poll_error, poll_interval_seconds, consecutive_failures
            FROM helm.unifi_mappings()
            ORDER BY organization_name, name
          `
        : [],
    ]);

    return {
      layout, counts: countRow, favorites, recent, upcoming, activity, health,
      usage: usage[0], quickClients, mappings,
    };
  });

  const {
    layout, counts, favorites, recent, upcoming, activity, health,
    usage, quickClients, mappings,
  } = data;
  const expired = Number(counts?.expired ?? 0);
  const secretExports = Number(counts?.secret_exports_7d ?? 0);

  const clients: ClientHealthRow[] = health.map((row) => ({
    organizationId: row.organization_id,
    name: row.name,
    health: row.health,
    expiredCount: row.expired_count,
    criticalCount: row.critical_count,
    warningCount: row.warning_count,
    reasons: row.reasons,
  }));

  // Two columns of widgets, except the expirations table, which is a five
  // column table and unreadable in half the width.
  const WIDE = new Set<WidgetKey>(['expirations', 'quick_actions']);

  function render(key: WidgetKey) {
    switch (key) {
      case 'favorites':
        return <FavoritesWidget favorites={favorites} />;
      case 'recently_viewed':
        return <RecentlyViewedWidget recent={recent} />;
      case 'expirations':
        return <ExpirationsWidget upcoming={upcoming} />;
      case 'audit_activity':
        return <ActivityWidget activity={activity} />;
      case 'client_health':
        return <ClientHealthWidget clients={clients} />;
      case 'quick_actions':
        return (
          <QuickActionsWidget
            canWrite={!isClientRole(identity.roleKey)}
            clients={quickClients.map((c) => ({ id: c.id, name: c.name, sites: c.sites }))}
          />
        );
      case 'usage_summary':
        return (
          <UsageSummaryWidget
            totals={{
              organizations: Number(usage?.organizations ?? 0),
              secrets: Number(usage?.secrets ?? 0),
              assets: Number(usage?.assets ?? 0),
              sites: Number(usage?.sites ?? 0),
              contacts: Number(usage?.contacts ?? 0),
              attachments: Number(usage?.attachments ?? 0),
            }}
          />
        );
      case 'sync_status':
        return (
          <SyncStatusWidget
            mappings={mappings.map((m) => ({
              id: m.id,
              name: m.name,
              organizationName: m.organization_name,
              isActive: m.is_active,
              lastPollAt: m.last_poll_at,
              lastPollOk: m.last_poll_ok,
              lastPollError: m.last_poll_error,
              pollIntervalSeconds: m.poll_interval_seconds,
              consecutiveFailures: m.consecutive_failures,
            }))}
          />
        );
    }
  }

  return (
    <>
      <PageHeader
        title={identity.tenantName}
        description="Everything that needs attention, across every client."
        actions={<DashboardCustomise layout={layout} />}
      />
      <PageBody>
        {/*
          Two banners, and only two. A dashboard that surfaces eight kinds of
          warning trains people to scroll past all of them; these are the two
          that mean somebody has to do something today.
        */}
        {expired > 0 && (
          <Link
            href="/expirations?severity=expired"
            className="flex items-center gap-3 rounded-[--radius-card] border border-sev-expired/30 bg-sev-expired/5 px-4 py-3 text-sm"
          >
            <AlertTriangle className="size-4 shrink-0 text-sev-expired" aria-hidden />
            <span className="text-ink">
              <strong className="font-semibold">{expired}</strong>{' '}
              {expired === 1 ? 'item has' : 'items have'} already expired.
            </span>
          </Link>
        )}

        {secretExports > 0 && (
          <Link
            href="/exports"
            className="flex items-center gap-3 rounded-[--radius-card] border border-sev-warning/40 bg-sev-warning/5 px-4 py-3 text-sm"
          >
            <FileDown className="size-4 shrink-0 text-sev-warning" aria-hidden />
            <span className="text-ink">
              <strong className="font-semibold">{secretExports}</strong> credential{' '}
              {secretExports === 1 ? 'export was' : 'exports were'} produced in the last seven
              days. Review who requested them.
            </span>
          </Link>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat icon={Building2} label="Clients" value={counts?.organizations} href="/organizations" />
          <Stat icon={KeyRound} label="Assets" value={counts?.assets} />
          <Stat icon={KeyRound} label="Credentials" value={counts?.secrets} />
          <Stat
            icon={CalendarClock}
            label="Expiring in 30 days"
            value={counts?.expiring_30}
            href="/expirations"
          />
          <Stat
            icon={Plug}
            label="Integrations degraded"
            value={counts?.degraded_integrations}
            href="/settings"
          />
        </div>

        {layout.length === 0 ? (
          <p className="rounded-[--radius-card] border border-dashed border-border px-4 py-8 text-center text-sm text-ink-muted">
            No widgets on your dashboard. Customise adds them back.
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {layout.map((key) => (
              <div key={key} className={WIDE.has(key) ? 'lg:col-span-2' : undefined}>
                {render(key)}
              </div>
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: typeof Building2;
  label: string;
  value: string | undefined;
  href?: string;
}) {
  const body = (
    <Card className="h-full transition-colors hover:border-border-strong">
      <CardContent className="flex items-start justify-between gap-3">
        <div>
          <div className="text-2xl font-semibold tabular-nums tracking-tight text-ink">
            {value ?? '0'}
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">{label}</div>
        </div>
        <Icon className="size-4 shrink-0 text-ink-faint" aria-hidden />
      </CardContent>
    </Card>
  );

  return href ? <Link href={href}>{body}</Link> : body;
}
