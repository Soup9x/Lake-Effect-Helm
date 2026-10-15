'use client';

/**
 * The clients list, with its filter bar, column chooser and bulk bar.
 *
 * WHY THIS EXISTS RATHER THAN A SWAP. The filter toolbar, column menu and
 * sortable grid were written for the per-category grids and were never wired
 * to this page, which still used SelectableTable. The obvious move — replace
 * SelectableTable with DataTable — loses the bulk bar, and archiving forty
 * clients at once is a shipped feature. So this composes all four instead:
 * DataTable already exposes onSelectionChange, which is the seam that makes it
 * possible without touching either component.
 *
 * SORTING IS IN THE BROWSER, with the same bounded claim DataTable documents:
 * this is one tenant's client list, which is tens to low hundreds. The `total`
 * readout is the honest escape hatch if an install ever grows past that.
 *
 * PINNED CLIENTS FLOAT, BUT ONLY UNSORTED, and that falls out of DataTable
 * rather than being arranged. The previous page put starred clients on top
 * always, which is right for a default view and wrong the moment somebody
 * sorts by name: a list claiming to be alphabetical with four rows out of
 * order reads as a bug. The page hands rows over pinned-first, DataTable
 * preserves that order while no sort is active, and the first click on a
 * column header replaces it. Nothing here has to detect which case it is in.
 */
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { FilterToolbar } from './shell/filter-toolbar';
import { ColumnMenu, useHiddenColumns, type ColumnChoice } from './shell/column-menu';
import { DataTable, type Column, type GridRow } from './shell/data-table';
import { BulkBar } from './bulk-bar';
import { Badge } from './ui/badge';
import { HealthDot } from './ui/health-dot';
import { FavoriteStar } from './favorite-star';
import { ClientAvatar } from './client-avatar';
import { DeletePermanently } from './delete-permanently';
import { relationshipOf } from '@/lib/ui/organization-relationship';
import { matchesBrowse } from '@/lib/ui/browse';

export interface ClientRow extends GridRow {
  id: string;
  name: string;
  status: string;
  relationship: string;
  isMspInternal: boolean;
  industry: string | null;
  logoUrl: string | null;
  tags: string[];
  siteCount: number;
  assetCount: number;
  secretCount: number;
  health: {
    health: string;
    expiredCount: number;
    criticalCount: number;
    warningCount: number;
    reasons: string[] | null;
  };
  pinned: boolean;
}

export function ClientsTable({
  clients,
  query,
  canWrite,
  canDelete,
  archived,
}: {
  clients: readonly ClientRow[];
  /** From the URL, owned by FilterToolbar. */
  query: string;
  canWrite: boolean;
  canDelete: boolean;
  archived: boolean;
}) {
  const { hidden, toggle, reset } = useHiddenColumns('clients');
  const [selected, setSelected] = useState<string[]>([]);
  const [clearSignal, setClearSignal] = useState(0);

  const columns = useMemo<Column<ClientRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Name',
        sortBy: (row) => row.name.toLowerCase(),
        cell: (row) => (
          <div className="flex items-center gap-2.5">
            <FavoriteStar organizationId={row.id} pinned={row.pinned} label={row.name} />
            <ClientAvatar name={row.name} logoUrl={row.logoUrl} size="sm" />
            <div className="min-w-0">
              <Link
                href={`/organizations/${row.id}`}
                className="font-medium text-ink hover:text-brand"
              >
                {row.name}
              </Link>
              {(row.tags.length > 0 || row.industry) && (
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  {row.tags.map((tag) => (
                    <Badge key={tag} tone="neutral">
                      {tag}
                    </Badge>
                  ))}
                  {row.industry && (
                    <span className="text-xs text-ink-faint">{row.industry}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        ),
      },
      {
        key: 'relationship',
        header: 'Type',
        sortBy: (row) => relationshipOf(row.relationship).label,
        cell: (row) => {
          const meta = relationshipOf(row.relationship);
          return <Badge tone={meta.tone}>{meta.label}</Badge>;
        },
      },
      {
        key: 'status',
        header: 'Status',
        sortBy: (row) => row.status,
        cell: (row) => (
          // The raw six-stage value, not an Active/Inactive reduction: "offboarding"
          // is something a technician needs to see, and the filter above does the
          // grouping for anyone who only wants the two.
          <span className="text-xs capitalize text-ink-muted">
            {row.status.replace(/_/g, '-')}
          </span>
        ),
      },
      {
        key: 'health',
        header: 'Health',
        sortBy: (row) => row.health.expiredCount * 1000 + row.health.criticalCount,
        cell: (row) => <HealthDot showLabel organizationId={row.id} health={row.health} />,
      },
      {
        key: 'sites',
        header: 'Sites',
        secondary: true,
        sortBy: (row) => row.siteCount,
        className: 'tabular-nums text-ink-muted',
        cell: (row) => row.siteCount,
      },
      {
        key: 'assets',
        header: 'Assets',
        secondary: true,
        sortBy: (row) => row.assetCount,
        className: 'tabular-nums text-ink-muted',
        cell: (row) => row.assetCount,
      },
      {
        key: 'credentials',
        header: 'Credentials',
        secondary: true,
        sortBy: (row) => row.secretCount,
        className: 'tabular-nums text-ink-muted',
        cell: (row) => row.secretCount,
      },
      // Permanent deletion lives in the archive only, and only for somebody
      // holding organization:delete. helm.delete_organization() refuses a live
      // client whatever the interface offers; this is just where it is reachable.
      ...(archived && canDelete
        ? [
            {
              key: 'delete',
              header: 'Delete',
              cell: (row: ClientRow) => (
                <DeletePermanently
                  endpoint={`/api/organizations/${row.id}`}
                  name={row.name}
                  kind="client"
                  counts={{
                    assets: row.assetCount,
                    secrets: row.secretCount,
                    sites: row.siteCount,
                  }}
                />
              ),
            } satisfies Column<ClientRow>,
          ]
        : []),
    ],
    [archived, canDelete],
  );

  const choices = useMemo<ColumnChoice[]>(
    () =>
      columns.map((column, index) => ({
        key: column.key,
        header: column.header,
        // The first column holds the name, the star and the link out. A list of
        // rows you cannot identify is not a shorter list.
        hideable: index > 0 && column.key !== 'delete',
      })),
    [columns],
  );

  /*
   * `search` is what FilterToolbar's text matches, and it deliberately includes
   * the type and status labels as well as the name: somebody typing "prospect"
   * means the type, and making them reach for a separate control to express it
   * is the kind of friction that gets a filter bar ignored.
   */
  const rows = useMemo(
    () =>
      clients.map((client) => ({
        ...client,
        search: [
          client.name,
          client.industry ?? '',
          relationshipOf(client.relationship).label,
          client.status,
          ...client.tags,
        ]
          .join(' ')
          .toLowerCase(),
      })),
    [clients],
  );

  // The same matcher DataTable filters with, so the count agrees with the rows.
  const shown = useMemo(() => {
    if (!query.trim()) return rows.length;
    return rows.filter((row) => matchesBrowse(row, { text: query })).length;
  }, [rows, query]);

  const onSelectionChange = useCallback((ids: string[]) => setSelected(ids), []);

  return (
    <>
      <FilterToolbar
        shown={shown}
        total={rows.length}
        placeholder="Filter clients by name, type, status or tag..."
        columnMenu={
          <ColumnMenu columns={choices} hidden={hidden} onToggle={toggle} onReset={reset} />
        }
      />
      <DataTable
        rows={rows}
        columns={columns}
        hiddenColumns={hidden}
        query={query}
        selectable={canWrite}
        onSelectionChange={onSelectionChange}
        clearSelectionSignal={clearSignal}
        emptyMessage={
          archived ? 'Nothing is archived.' : 'No clients match what you have typed.'
        }
      />
      {canWrite && selected.length > 0 && (
        <BulkBar
          target="client"
          ids={selected}
          archived={archived}
          // Clears both halves: this component's copy, which hides the bar, and
          // DataTable's own set, which owns the checkboxes.
          onClear={() => {
            setSelected([]);
            setClearSignal((n) => n + 1);
          }}
        />
      )}
    </>
  );
}
