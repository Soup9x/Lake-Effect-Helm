import Link from 'next/link';
import { CalendarClock } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, severityTone } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, humanise, relativeDays } from '@/lib/ui/format';
import { cn } from '@/lib/ui/cn';

const SEVERITIES = ['expired', 'critical', 'warning', 'notice', 'info'] as const;

interface ExpirationRow {
  id: string;
  organization_id: string;
  organization_name: string;
  kind: string;
  node_id: string | null;
  label: string;
  expires_at: Date;
  auto_renew: boolean;
  severity: string;
  days_remaining: number;
}

/**
 * The cross-tenant expiry view, filtered by severity.
 *
 * Severity is computed at read time by helm.expiration_severity(), never
 * stored: a stored severity is wrong the moment the clock passes midnight and
 * nobody has run a job. The filter is therefore applied in SQL against the
 * computed value rather than against a column.
 */
export default async function ExpirationsPage({
  searchParams,
}: {
  searchParams: Promise<{ severity?: string }>;
}) {
  const identity = await getServerIdentity();
  const params = await searchParams;
  const severity = SEVERITIES.includes(params.severity as never) ? params.severity : undefined;

  const rows = await withTenant(actorOf(identity), async (tx) => {
    return tx<ExpirationRow[]>`
      SELECT id, organization_id, organization_name, kind::text, node_id, label,
             expires_at, auto_renew, severity::text, days_remaining
      FROM v_expiration_dashboard
      ${severity ? tx`WHERE severity = ${severity}::alert_severity` : tx``}
      ORDER BY expires_at
      LIMIT 500
    `;
  });

  return (
    <>
      <PageHeader
        title="Expirations"
        description="Certificates, domains, warranties, licences and contracts across every client, in one list."
      />
      <PageBody>
        <nav className="flex flex-wrap items-center gap-1.5">
          <FilterLink href="/expirations" active={!severity}>
            All
          </FilterLink>
          {SEVERITIES.map((value) => (
            <FilterLink
              key={value}
              href={`/expirations?severity=${value}`}
              active={severity === value}
            >
              {humanise(value)}
            </FilterLink>
          ))}
        </nav>

        <Card>
          <CardContent className="p-0">
            {rows.length === 0 ? (
              <EmptyState
                icon={CalendarClock}
                title={severity ? `Nothing is ${severity}` : 'Nothing is tracked as expiring'}
                description="Expirations are projected automatically from certificates, domains, devices, licences and contracts as they are documented."
              />
            ) : (
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
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        {row.node_id ? (
                          <Link
                            href={`/assets/${row.node_id}`}
                            className="font-medium text-ink hover:text-brand"
                          >
                            {row.label}
                          </Link>
                        ) : (
                          <span className="font-medium">{row.label}</span>
                        )}
                        {row.auto_renew && (
                          <Badge tone="ok" className="ml-2">
                            auto-renew
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-ink-muted">
                        <Link
                          href={`/organizations/${row.organization_id}`}
                          className="hover:text-brand"
                        >
                          {row.organization_name}
                        </Link>
                      </TableCell>
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
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-brand bg-brand text-on-brand'
          : 'border-border bg-surface-raised text-ink-muted hover:border-border-strong hover:text-ink',
      )}
    >
      {children}
    </Link>
  );
}
