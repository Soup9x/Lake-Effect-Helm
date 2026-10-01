'use client';

/**
 * The grid.
 *
 * SORTING AND FILTERING HAPPEN HERE, not in the database, and that is a bounded
 * claim rather than a lazy one: a page hands this component the rows for one
 * category of one client, which is tens to low hundreds. Round-tripping a sort
 * on 80 rows costs a technician 200ms and the server a query; doing it in the
 * browser costs neither. A category that grows past a few hundred rows wants
 * server-side paging and this component is the wrong tool for it — the
 * `total` prop exists so the caller can say what it actually has.
 *
 * FOLDER ROWS SORT FIRST, ALWAYS. A tree that re-orders its folders into the
 * middle of its leaves is not a tree any more. Folders sort among themselves by
 * the active column and then sit above every asset row.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, Flag, Folder } from 'lucide-react';
import { cn } from '@/lib/ui/cn';
import { RowActionIcons, type RowAction } from './row-action-icons';

export interface Column<T> {
  key: string;
  header: string;
  /** Rendered cell. */
  cell: (row: T) => ReactNode;
  /** Sort value. Omit to make the column unsortable. */
  sortBy?: ((row: T) => string | number | null) | undefined;
  className?: string | undefined;
  /** Hidden at narrow widths. */
  secondary?: boolean | undefined;
}

export interface GridRow {
  id: string;
  /** A folder row: rendered with a folder icon and an item count, sorted first. */
  folder?: { label: string; itemCount: number; itemNoun: string; href: string } | undefined;
  /** Raised flag indicator in the second column. */
  flagged?: boolean | undefined;
  actions?: readonly RowAction[] | undefined;
  /** Free text the filter searches, lowercased by the caller. */
  search?: string | undefined;
}

type Direction = 'asc' | 'desc';

export function DataTable<T extends GridRow>({
  rows,
  columns,
  query = '',
  selectable = false,
  emptyMessage = 'Nothing here yet.',
  onSelectionChange,
}: {
  rows: readonly T[];
  columns: readonly Column<T>[];
  /** The filter text from the toolbar. Matched against `row.search`. */
  query?: string;
  selectable?: boolean;
  emptyMessage?: string;
  onSelectionChange?: ((ids: string[]) => void) | undefined;
}) {
  const [sort, setSort] = useState<{ key: string; direction: Direction } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => (row.search ?? '').includes(needle));
  }, [rows, query]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortBy) return filtered;
    const { sortBy } = column;

    const compare = (a: T, b: T): number => {
      // Folders above assets regardless of direction.
      const af = a.folder ? 0 : 1;
      const bf = b.folder ? 0 : 1;
      if (af !== bf) return af - bf;

      const av = sortBy(a);
      const bv = sortBy(b);
      // Nulls last in both directions: an empty cell is not "smallest", it is
      // absent, and burying it at the top of an ascending sort hides the rows
      // somebody is actually looking for.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;

      const result =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return sort.direction === 'asc' ? result : -result;
    };

    return [...filtered].sort(compare);
  }, [filtered, sort, columns]);

  const toggleSort = (key: string) => {
    setSort((prev) =>
      prev?.key === key
        ? prev.direction === 'asc'
          ? { key, direction: 'desc' }
          : null // third press clears, rather than trapping the person in a cycle
        : { key, direction: 'asc' },
    );
  };

  const setSelection = (next: Set<string>) => {
    setSelected(next);
    onSelectionChange?.([...next]);
  };

  const allVisibleSelected = sorted.length > 0 && sorted.every((r) => selected.has(r.id));

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full caption-bottom border-collapse text-sm">
        <thead>
          <tr className="border-b border-canvas-border bg-surface-sunken/60">
            {selectable && (
              <th scope="col" className="w-12 py-2 pl-6 pr-2">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={() =>
                    setSelection(allVisibleSelected ? new Set() : new Set(sorted.map((r) => r.id)))
                  }
                  aria-label={allVisibleSelected ? 'Clear selection' : 'Select every visible row'}
                  className="size-3.5 rounded border-border-strong"
                />
              </th>
            )}
            <th scope="col" className={cn('w-8 py-2 pr-1', selectable ? 'pl-0' : 'pl-6')}>
              <span className="sr-only">Flag</span>
            </th>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted',
                  column.secondary && 'hidden lg:table-cell',
                  column.className,
                )}
              >
                {column.sortBy ? (
                  <button
                    type="button"
                    onClick={() => toggleSort(column.key)}
                    className="flex items-center gap-1 hover:text-ink"
                    aria-label={`Sort by ${column.header}`}
                  >
                    {column.header}
                    {sort?.key === column.key ? (
                      sort.direction === 'asc' ? (
                        <ArrowUp className="size-3" aria-hidden />
                      ) : (
                        <ArrowDown className="size-3" aria-hidden />
                      )
                    ) : (
                      <ChevronsUpDown className="size-3 opacity-40" aria-hidden />
                    )}
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
            {/* Narrow and right-padded: at 1440 the grid fits without the
                header being cut mid-word by the horizontal scroller. */}
            {/*
              The gutter lives on the first and last CELLS rather than on a
              wrapper with padding, so the row's hover highlight still runs the
              full width of the pane. A grid whose highlight stopped 24px short
              of each edge would look like a mistake at every row.
            */}
            <th scope="col" className="w-24 py-2 pl-3 pr-6 text-right text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Actions
            </th>
          </tr>
        </thead>

        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length + (selectable ? 3 : 2)}
                className="px-6 py-10 text-center text-sm text-ink-muted"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sorted.map((row) => (
              <tr
                key={row.id}
                className="group border-b border-canvas-border last:border-0 hover:bg-surface-sunken/70"
              >
                {selectable && (
                  <td className="py-2 pl-6 pr-2">
                    <input
                      type="checkbox"
                      checked={selected.has(row.id)}
                      onChange={() => {
                        const next = new Set(selected);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        setSelection(next);
                      }}
                      aria-label="Select row"
                      className="size-3.5 rounded border-border-strong"
                    />
                  </td>
                )}
                <td className={cn('py-2 pr-1', selectable ? 'pl-0' : 'pl-6')}>
                  {row.flagged && <Flag className="size-3.5 text-sev-warning" aria-label="Flagged" />}
                </td>

                {row.folder ? (
                  /*
                   * A folder spans the data columns. Rendering a folder through
                   * the same column definitions as an asset would mean every
                   * column having to answer "what does this mean for a folder",
                   * and the answer is almost always nothing.
                   */
                  <td colSpan={columns.length} className="px-3 py-2">
                    <a
                      href={row.folder.href}
                      className="inline-flex items-center gap-2 font-medium text-ink hover:underline"
                    >
                      <Folder className="size-4 text-ink-faint" aria-hidden />
                      {row.folder.label}
                      <span className="text-xs font-normal text-ink-faint">
                        {row.folder.itemCount}{' '}
                        {/* "1 Document", not "1 Documents". The noun arrives
                            singular and is pluralised here so no caller has to
                            remember. */}
                        {row.folder.itemCount === 1
                          ? row.folder.itemNoun
                          : `${row.folder.itemNoun}s`}
                      </span>
                    </a>
                  </td>
                ) : (
                  columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        'px-3 py-2 align-middle text-ink',
                        column.secondary && 'hidden lg:table-cell',
                        column.className,
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))
                )}

                <td className="py-1.5 pl-3 pr-6">
                  <RowActionIcons actions={row.actions ?? []} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
