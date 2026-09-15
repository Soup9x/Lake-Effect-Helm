import Link from 'next/link';
import { ScrollText, ShieldCheck } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime } from '@/lib/ui/format';
import { cn } from '@/lib/ui/cn';

interface AuditRow {
  event_uid: string;
  occurred_at: Date;
  actor_label: string;
  actor_type: string;
  actor_role_key: string | null;
  action: string;
  outcome: string;
  entity_type: string | null;
  entity_id: string | null;
  organization_name: string | null;
  reason: string | null;
  ip: string | null;
  chain_seq: string;
}

interface ChainRow {
  chain_seq: string;
  anchored_seq: string;
  anchored_at: Date | null;
  anchor_ref: string | null;
}

function outcomeTone(outcome: string): BadgeTone {
  return outcome === 'denied' ? 'warning' : outcome === 'error' ? 'danger' : 'ok';
}

const FILTERS = [
  ['', 'All'],
  ['secret.', 'Secrets'],
  ['export.', 'Exports'],
  ['key.', 'Keys'],
  ['integration.', 'Integrations'],
] as const;

/**
 * The audit trail, and the state of the chain that makes it evidence.
 *
 * The header panel is the part that matters and the part most audit UIs omit:
 * a log is only evidence to the extent that it can be shown not to have been
 * rewritten. `chain_seq` minus `anchored_seq` is how much history is currently
 * protected only by the database — which, on an on-premises box the MSP
 * administers, is a different claim from "protected by an external witness".
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ prefix?: string }>;
}) {
  const identity = await getServerIdentity();
  const params = await searchParams;
  const prefix = FILTERS.some(([value]) => value === params.prefix) ? params.prefix : '';

  const { events, chain } = await withTenant(actorOf(identity), async (tx) => {
    const [rows, chainRows] = await Promise.all([
      tx<AuditRow[]>`
        SELECT a.event_uid, a.occurred_at, a.actor_label, a.actor_type::text, a.actor_role_key,
               a.action, a.outcome::text, a.entity_type, a.entity_id,
               o.name AS organization_name, a.reason, host(a.ip) AS ip, a.chain_seq
        FROM audit_log a
        LEFT JOIN organization o ON o.id = a.organization_id
        ${prefix ? tx`WHERE a.action LIKE ${`${prefix}%`}` : tx``}
        ORDER BY a.occurred_at DESC
        LIMIT 200
      `,
      tx<ChainRow[]>`
        SELECT chain_seq, anchored_seq, anchored_at, anchor_ref FROM audit_chain_head
      `,
    ]);
    return { events: rows, chain: chainRows[0] ?? null };
  });

  const unanchored = chain ? Number(chain.chain_seq) - Number(chain.anchored_seq) : 0;

  return (
    <>
      <PageHeader
        title="Audit"
        description="Every secret read, export, key operation and integration run, in a tamper-evident chain."
      />
      <PageBody>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-ink-faint" aria-hidden /> Chain integrity
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <div className="text-2xl font-semibold tabular-nums text-ink">
                {chain?.chain_seq ?? 0}
              </div>
              <div className="text-xs text-ink-muted">events in the chain</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums text-ink">
                {chain?.anchored_seq ?? 0}
              </div>
              <div className="text-xs text-ink-muted">
                externally anchored
                {chain?.anchored_at && ` · ${formatDateTime(chain.anchored_at)}`}
              </div>
            </div>
            <div>
              <div
                className={cn(
                  'text-2xl font-semibold tabular-nums',
                  unanchored > 0 ? 'text-sev-warning' : 'text-ok',
                )}
              >
                {unanchored}
              </div>
              <div className="text-xs text-ink-muted">
                awaiting a witness
                {chain?.anchor_ref ? (
                  <span className="mt-0.5 block break-all font-mono text-[11px] text-ink-faint">
                    {chain.anchor_ref}
                  </span>
                ) : (
                  <span className="mt-0.5 block text-ink-faint">
                    No anchor recorded. The chain detects edits but has no external witness.
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <nav className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map(([value, label]) => (
            <Link
              key={label}
              href={value ? `/audit?prefix=${value}` : '/audit'}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                prefix === value
                  ? 'border-brand bg-brand text-white'
                  : 'border-border bg-surface-raised text-ink-muted hover:border-border-strong hover:text-ink',
              )}
            >
              {label}
            </Link>
          ))}
        </nav>

        <Card>
          <CardContent className="p-0">
            {events.length === 0 ? (
              <EmptyState icon={ScrollText} title="No audit events match" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>When</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Seq</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((event) => (
                    <TableRow key={event.event_uid}>
                      <TableCell className="whitespace-nowrap text-xs text-ink-muted">
                        {formatDateTime(event.occurred_at)}
                      </TableCell>
                      <TableCell>
                        <div className="text-ink">{event.actor_label}</div>
                        <div className="text-xs text-ink-faint">
                          {event.actor_role_key ?? event.actor_type}
                          {event.ip && ` · ${event.ip}`}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs text-ink">{event.action}</span>
                        {event.reason && (
                          <div className="max-w-md truncate text-xs text-ink-faint" title={event.reason}>
                            {event.reason}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-ink-muted">
                        {event.organization_name ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Badge tone={outcomeTone(event.outcome)}>{event.outcome}</Badge>
                      </TableCell>
                      <TableCell className="tabular-nums text-xs text-ink-faint">
                        {event.chain_seq}
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
