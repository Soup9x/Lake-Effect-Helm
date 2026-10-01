'use client';

/**
 * The grid for one category, with its filter bar.
 *
 * A CLIENT COMPONENT WRAPPING TWO OTHERS, which exists so the page stays a server
 * component. The filter text and the sort live in the browser; the rows do not.
 * Without this wrapper the page itself would have to be a client component, and
 * every query it runs would have to move to an endpoint.
 *
 * WHAT IT DOES NOT DO: decrypt anything. The copy-username button copies a column
 * that was already on screen. The OTP badge is a LINK to the credential, not a
 * code — generating one requires secret:reveal and writes an audit row, and a
 * grid that minted codes for eighty rows on render would be eighty audited
 * reveals nobody asked for.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Copy, EyeOff, ExternalLink, KeyRound, Check } from 'lucide-react';
import { FilterToolbar } from './filter-toolbar';
import { DataTable, type Column, type GridRow } from './data-table';
import { standardRowActions } from './row-action-icons';
import { Badge } from '../ui/badge';
import { formatDate } from '@/lib/ui/format';
import { copyUnaudited } from '@/lib/ui/clipboard';

export interface CategoryRecord {
  id: string;
  name: string;
  /** Where the name links. Omitted for rows with no detail page yet. */
  href?: string | undefined;
  /** Username, email, city — whatever the second column means here. */
  secondary?: string | null | undefined;
  /** Status, title, code. */
  type?: string | null | undefined;
  /** Phone, size, secret label. */
  extra?: string | null | undefined;
  flagged?: boolean | undefined;
  internalOnly?: boolean | undefined;
  hasTotp?: boolean | undefined;
  externalUrl?: string | null | undefined;
  updatedAt?: string | undefined;
  updatedBy?: string | null | undefined;
  folder?: { itemCount: number; itemNoun: string; href: string } | undefined;
}

interface Row extends GridRow {
  record: CategoryRecord;
}

/**
 * Copy-to-clipboard, through the product's single clipboard door.
 *
 * `copyUnaudited` rather than reaching for the browser API directly, and that is
 * enforced rather than remembered: tests/unit/clipboard.test.ts scans src/ for
 * any direct write and fails on it, which is exactly how this component was
 * caught the first time it was written. (That scan is a text match, so even
 * naming the API in a comment trips it — as this comment originally did.)
 * Unaudited is the right half of the door here — the
 * value is a username already rendered on screen, not secret material, and
 * recording a copy of something anyone with the page open can read would put
 * noise in the trail that matters.
 */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={async () => {
        const outcome = await copyUnaudited(value);
        if (outcome !== 'copied') return;
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="flex size-6 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink"
    >
      {done ? <Check className="size-3.5 text-ok" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}

/**
 * What the four flexible columns are called HERE.
 *
 * The grid's shape is fixed — name, two descriptors, a classification, then
 * timestamps — but what those slots mean is not. A document's second column is
 * its content type, a contact's is their email, a password's is the username.
 * Labelling all three "Username" was the first thing that looked wrong when this
 * was rendered against real rows.
 */
export interface ColumnLabels {
  secondary?: string;
  type?: string;
  extra?: string;
}

export function CategoryGrid({
  records,
  total,
  categoryLabel,
  canWrite,
  labels,
}: {
  records: readonly CategoryRecord[];
  total: number;
  categoryLabel: string;
  canWrite: boolean;
  labels?: ColumnLabels;
}) {
  const params = useSearchParams();
  const query = params?.get('q') ?? '';

  const rows = useMemo<Row[]>(
    () =>
      records.map((record) => ({
        id: record.id,
        record,
        ...(record.flagged ? { flagged: true } : {}),
        ...(record.folder
          ? { folder: { label: record.name, ...record.folder } }
          : {}),
        // Lowercased once here rather than per keystroke in the table.
        search: [record.name, record.secondary, record.type, record.extra]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
        actions: record.folder
          ? []
          : standardRowActions({
              ...(canWrite && record.href ? { editHref: record.href } : {}),
            }),
      })),
    [records, canWrite],
  );

  const columns = useMemo<Column<Row>[]>(
    () => [
      {
        key: 'name',
        header: 'Name',
        sortBy: (r) => r.record.name.toLowerCase(),
        cell: (r) => (
          <span className="flex items-center gap-1.5">
            {r.record.href ? (
              <Link href={r.record.href} className="font-medium text-ink hover:underline">
                {r.record.name}
              </Link>
            ) : (
              <span className="font-medium text-ink">{r.record.name}</span>
            )}
            {r.record.internalOnly && (
              <span title="Internal only — not visible to the client">
                <EyeOff className="size-3.5 text-ink-faint" aria-label="Internal only" />
              </span>
            )}
            {/*
              Inline utilities, always visible: a password list exists so somebody
              can copy from it, and hiding the copy button until the pointer
              arrives makes the list look like it has none.
            */}
            {r.record.secondary && <CopyButton value={r.record.secondary} label="Copy username" />}
            {r.record.hasTotp && (
              <Link
                href={r.record.href ?? '#'}
                title="This credential has a one-time code"
                className="flex items-center gap-0.5 rounded bg-brand-tint px-1 py-0.5 text-[10px] font-medium text-brand"
              >
                <KeyRound className="size-3" aria-hidden />
                OTP
              </Link>
            )}
            {r.record.externalUrl && (
              <a
                href={r.record.externalUrl}
                target="_blank"
                rel="noreferrer noopener"
                title="Open in a new tab"
                className="flex size-6 items-center justify-center rounded text-ink-faint hover:bg-surface-sunken hover:text-ink"
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
          </span>
        ),
      },
      {
        key: 'secondary',
        header: labels?.secondary ?? 'Username',
        sortBy: (r) => r.record.secondary?.toLowerCase() ?? null,
        cell: (r) => <span className="text-ink-muted">{r.record.secondary || '—'}</span>,
      },
      {
        key: 'type',
        header: labels?.type ?? 'Type',
        sortBy: (r) => r.record.type?.toLowerCase() ?? null,
        cell: (r) =>
          r.record.type ? <Badge tone="neutral">{r.record.type}</Badge> : <span className="text-ink-faint">—</span>,
      },
      {
        key: 'extra',
        header: labels?.extra ?? 'Category',
        secondary: true,
        sortBy: (r) => r.record.extra?.toLowerCase() ?? null,
        cell: (r) => <span className="text-ink-muted">{r.record.extra || '—'}</span>,
      },
      {
        key: 'updated',
        header: 'Updated',
        secondary: true,
        sortBy: (r) => r.record.updatedAt ?? null,
        cell: (r) => (
          <span className="whitespace-nowrap text-ink-faint">
            {r.record.updatedAt ? formatDate(new Date(r.record.updatedAt)) : '—'}
          </span>
        ),
      },
      {
        key: 'updatedBy',
        header: 'Updated by',
        secondary: true,
        sortBy: (r) => r.record.updatedBy?.toLowerCase() ?? null,
        cell: (r) => <span className="text-ink-faint">{r.record.updatedBy || '—'}</span>,
      },
    ],
    [labels],
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows.length;
    return rows.filter((r) => (r.search ?? '').includes(needle)).length;
  }, [rows, query]);

  return (
    <>
      <FilterToolbar shown={shown} total={total} />
      <DataTable
        rows={rows}
        columns={columns}
        query={query}
        selectable={canWrite}
        emptyMessage={`No ${categoryLabel.toLowerCase()} recorded for this client yet.`}
      />
    </>
  );
}
