import Link from 'next/link';
import { AlertTriangle, Building2, CalendarClock, FileDown, KeyRound, Plug } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, severityTone } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, humanise, relativeDays } from '@/lib/ui/format';

interface Counts {
  organizations: string;
  assets: string;
  secrets: string;
  expiring_30: string;
  expired: string;
  degraded_integrations: string;
  pending_approvals: string;
}

interface UpcomingRow {
  id: string;
  organization_name: string;
  kind: string;
  label: string;
  expires_at: Date;
  severity: string;
  days_remaining: number;
}

/**
 * The single pane of glass.
 *
 * Every number here is scoped by RLS to what this actor may see, so a
 * client-side co-managed user gets their own organisation's counts from the
 * same query a super admin runs across every client. There is no "if client
 * then different query" branch, which is exactly the branch that eventually
 * gets the condition backwards.
 */
export default async function DashboardPage() {
  const identity = await getServerIdentity();

  const { counts, upcoming } = await withTenant(actorOf(identity), async (tx) => {
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

    const rows = await tx<UpcomingRow[]>`
      SELECT id, organization_name, kind::text, label, expires_at, severity::text, days_remaining
      FROM v_expiration_dashboard
      WHERE days_remaining <= 45
      ORDER BY expires_at
      LIMIT 12
    `;

    return { counts: countRow, upcoming: rows };
  });

  const expired = Number(counts?.expired ?? 0);
  const pendingApprovals = Number(counts?.pending_approvals ?? 0);

  return (
    <>
      <PageHeader
        title={identity.tenantName}
        description="Everything that needs attention, across every client."
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

        <Card>
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
