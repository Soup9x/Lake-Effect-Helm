import Link from 'next/link';
import { Grid3x3 } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { readCoverageGrid } from '@/lib/coverage/queries';
import { columnClientCoverage, columnTotals, coverageOf, gapsOf } from '@/lib/coverage/grid';
import { cn } from '@/lib/ui/cn';

export const dynamic = 'force-dynamic';

/**
 * Documentation coverage: every client against every kind of thing you
 * document.
 *
 * WHAT THE NUMBER MEANS, because this is the page where it would be easiest to
 * invent one. A cell is a count of records; a row's badge is "at least one
 * record of N of the M kinds". Neither is a claim that a client is M-minus-N
 * records short of complete — Helm cannot see what exists in the world, only
 * what has been written down, and a client with no ISP circuit is not an
 * incomplete record. src/lib/coverage/grid.ts carries the full reasoning,
 * including why there are no traffic lights.
 *
 * THE ZEROS ARE THE POINT. Every other view in Helm shows what is there; this
 * one is worth opening because it shows what is not, so an empty cell is styled
 * to be found and a full one is quiet.
 *
 * ONE PAGE OF CLIENTS AT A TIME, which is a measured decision rather than a
 * default — see the header of lib/coverage/queries.ts for the three numbers
 * behind it.
 *
 * RLS DOES THE SCOPING, as everywhere else: a client-side role sees their own
 * organisation and the columns stay the same, so the page needs no branch for
 * them. It would be a thin page for one client, which is why L puts it under
 * Global rather than in a client's drawer.
 */
export default async function CoveragePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await getServerIdentity();
  const params = await searchParams;
  const raw = Array.isArray(params.page) ? params.page[0] : params.page;
  const parsed = Number.parseInt(raw ?? '1', 10);
  // A stale or nonsense ?page shows the first page rather than erroring, which
  // is the rule the client list already applies to an unrecognised ?type.
  const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;

  const grid = await withTenant(actorOf(identity), (tx) =>
    readCoverageGrid(tx, { page: requested }));

  const { rows, columns, clients, page, pageSize } = grid;
  const pages = Math.max(1, Math.ceil(clients / pageSize));
  const totals = columnTotals(rows, columns);
  const clientsWith = columnClientCoverage(rows, columns);

  return (
    <>
      <PageHeader
        title="Coverage"
        description={
          clients === 0
            ? 'No clients yet.'
            : `${clients} client${clients === 1 ? '' : 's'} against `
              + `${columns.length} kind${columns.length === 1 ? '' : 's'} of documentation.`
        }
      />
      <PageBody>
        {columns.length === 0 || rows.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
              <Grid3x3 className="size-6 text-ink-faint" aria-hidden />
              <p className="text-sm text-ink-muted">
                {clients === 0
                  ? 'There are no clients to measure yet.'
                  : 'There is nothing to measure against yet.'}
              </p>
              <p className="text-xs text-ink-faint">
                Coverage counts asset records per client. Define a documentation type under
                Settings, or add assets to a client, and they appear here.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="sticky left-0 bg-surface px-4 py-2 text-left font-medium text-ink-muted">
                      Client
                    </th>
                    <th className="px-3 py-2 text-right font-medium text-ink-muted">Covered</th>
                    {columns.map((column) => (
                      <th
                        key={column.key}
                        className="px-3 py-2 text-right font-medium text-ink-muted"
                      >
                        <span className="inline-block max-w-28 truncate align-bottom" title={column.label}>
                          {column.label}
                        </span>
                        <span className="block text-[0.65rem] font-normal text-ink-faint">
                          {clientsWith[column.key]}/{rows.length} clients
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const coverage = coverageOf(row, columns);
                    const gaps = gapsOf(row, columns);
                    return (
                      <tr key={row.organizationId} className="border-b border-border last:border-b-0">
                        <td className="sticky left-0 bg-surface px-4 py-2">
                          <Link
                            href={`/organizations/${row.organizationId}`}
                            className="text-ink hover:underline"
                          >
                            {row.organizationName}
                          </Link>
                          {row.isMspInternal && (
                            <Badge tone="neutral" className="ml-2">Internal</Badge>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          <span className="tabular-nums text-ink">
                            {coverage.covered}/{coverage.total}
                          </span>
                          <span className="ml-1.5 text-xs text-ink-faint">
                            {coverage.percent}%
                          </span>
                          {gaps.length > 0 && (
                            <span
                              className="block text-[0.65rem] text-ink-faint"
                              title={gaps.map((gap) => gap.label).join(', ')}
                            >
                              {gaps.length} missing
                            </span>
                          )}
                        </td>
                        {columns.map((column) => {
                          const n = row.counts[column.key] ?? 0;
                          return (
                            <td
                              key={column.key}
                              className={cn(
                                'px-3 py-2 text-right tabular-nums',
                                n === 0 ? 'text-ink-faint' : 'text-ink',
                              )}
                            >
                              {n === 0 ? (
                                <>
                                  <span aria-hidden>—</span>
                                  <span className="sr-only">{`No ${column.label} documented`}</span>
                                </>
                              ) : column.categorySlug ? (
                                <Link
                                  href={`/organizations/${row.organizationId}/${column.categorySlug}`}
                                  className="hover:underline"
                                >
                                  {n}
                                </Link>
                              ) : (
                                n
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border text-xs text-ink-faint">
                    <td className="sticky left-0 bg-surface px-4 py-2">
                      This page
                    </td>
                    <td />
                    {columns.map((column) => (
                      <td key={column.key} className="px-3 py-2 text-right tabular-nums">
                        {totals[column.key]}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-ink-faint">
              Page {page} of {pages}
            </span>
            <div className="flex gap-2">
              {page > 1 && (
                <Link
                  href={page === 2 ? '/coverage' : `/coverage?page=${page - 1}`}
                  className="rounded-md border border-border px-3 py-1 text-ink-muted hover:text-ink"
                >
                  Previous
                </Link>
              )}
              {page < pages && (
                <Link
                  href={`/coverage?page=${page + 1}`}
                  className="rounded-md border border-border px-3 py-1 text-ink-muted hover:text-ink"
                >
                  Next
                </Link>
              )}
            </div>
          </div>
        )}
      </PageBody>
    </>
  );
}
