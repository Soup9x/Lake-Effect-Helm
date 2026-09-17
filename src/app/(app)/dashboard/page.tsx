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
} from '@/components/widgets';
import { getLayout, listFavorites, listRecent } from '@/lib/workspace/queries';
import type { WidgetKey } from '@/lib/workspace/widgets';

interface Counts {
  organizations: string;
  assets: string;
  secrets: string;
  expiring_30: string;
  expired: string;
  degraded_integrations: string;
  pending_approvals: string;
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
 * today, and a dashboard where "three credential exports are waiting for a
 * second approver" can be switched off is a dashboard where it will be. The
 * five widgets below are arrangement: which lists you want in front of you,
 * which is genuinely a matter of what you do all day.
 *
 * Only the widgets in the layout are queried. Somebody who removed the activity
 * widget does not read the audit log on every dashboard load, and that is
 * visible here rather than buried in five components that each fetch their own.
 */
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
        (SELECT count(*) FROM export_job
          WHERE status = 'queued' AND include_secrets AND approved_by IS NULL
            AND revoked_at IS NULL AND expires_at > now()) AS pending_approvals
    `;

    const [favorites, recent, upcoming, activity, health] = await Promise.all([
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
    ]);

    return { layout, counts: countRow, favorites, recent, upcoming, activity, health };
  });

  const { layout, counts, favorites, recent, upcoming, activity, health } = data;
  const expired = Number(counts?.expired ?? 0);
  const pendingApprovals = Number(counts?.pending_approvals ?? 0);

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
  const WIDE = new Set<WidgetKey>(['expirations']);

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

        {pendingApprovals > 0 && (
          <Link
            href="/exports"
            className="flex items-center gap-3 rounded-[--radius-card] border border-sev-warning/40 bg-sev-warning/5 px-4 py-3 text-sm"
          >
            <FileDown className="size-4 shrink-0 text-sev-warning" aria-hidden />
            <span className="text-ink">
              <strong className="font-semibold">{pendingApprovals}</strong> credential{' '}
              {pendingApprovals === 1 ? 'export is' : 'exports are'} waiting for a second approver.
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
