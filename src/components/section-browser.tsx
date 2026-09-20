'use client';

/**
 * A client-page section: a small card, and the whole list in a modal.
 *
 * WHY THE PAGE SHRANK. Every section on a client page rendered its full list
 * inline — every credential, every asset, every site, every contact, one after
 * another. On a client with any real documentation the page became a scroll,
 * and the thing somebody came for was below three lists they were not looking
 * at. The card now carries the count and the first few names; the list itself
 * opens where the add flows already open, in a modal.
 *
 * ONE COMPONENT FOR ALL FIVE SECTIONS, not five that drift. Credentials,
 * assets, sites, contacts and expiring items differ in their columns and in
 * which facets they can be filtered by, and in nothing else — so those are
 * props. The alternative was five search boxes with five subtly different
 * ideas of what a match is.
 *
 * ROWS, NOT JSX, is what makes that possible. SelectableRow is {id, label,
 * cells} and every cell is already a ReactNode, so a server component can build
 * the rows and hand them here for filtering. Bulk selection comes along
 * unchanged for the sections that had it, because the filtered rows go to the
 * same SelectableTable.
 *
 * The filtering itself is in src/lib/ui/browse.ts, tested there.
 */
import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input, Label, Select } from './ui/field';
import { Modal } from './ui/modal';
import { SelectableTable, type SelectableRow } from './selectable-table';
import { EmptyState } from './app-shell';
import { facetValues, filterBrowse, type BrowsableFacets } from '@/lib/ui/browse';
import { humanise } from '@/lib/ui/format';

export interface BrowsableRow extends SelectableRow {
  /** Everything matchable, already lowercased by the caller. */
  search: string;
  facets?: BrowsableFacets;
  /** Days until expiry, for the time-window control. Negative is overdue. */
  days?: number;
}

export interface SectionFilter {
  /** Matches a key in each row's `facets`. */
  key: string;
  label: string;
}

/** The windows the expirations modal offers, in days. */
export const EXPIRY_WINDOWS = [30, 60, 90] as const;

export function SectionBrowser({
  title,
  icon: Icon,
  rows,
  columns,
  emptyTitle,
  emptyDescription,
  bulk,
  filters = [],
  showWindows = false,
  previewCount = 4,
  action,
}: {
  title: string;
  icon?: ComponentType<{ className?: string }>;
  rows: BrowsableRow[];
  columns: ReactNode[];
  emptyTitle: string;
  emptyDescription?: string;
  /** Omit for a section with no bulk actions — sites, contacts, expirations. */
  bulk?: { target: 'client' | 'node'; selectable: boolean };
  filters?: SectionFilter[];
  /** The 30/60/90 day control. Expirations only. */
  showWindows?: boolean;
  previewCount?: number;
  /** The section's add control, shown on the card beside the count. */
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<BrowsableFacets>({});
  const [withinDays, setWithinDays] = useState<number | undefined>(undefined);

  const visible = useMemo(
    () => filterBrowse(rows, { text, facets: chosen, withinDays }),
    [rows, text, chosen, withinDays],
  );

  // Built from the rows, so a control never offers a value that matches nothing.
  const options = useMemo(
    () => filters.map((f) => ({ ...f, values: facetValues(rows, f.key) })),
    [filters, rows],
  );

  function reset() {
    setText('');
    setChosen({});
    setWithinDays(undefined);
  }

  const narrowed = visible.length !== rows.length;

  return (
    <>
      <Card className="h-full">
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-2">
            {Icon && <Icon className="size-4 text-ink-faint" aria-hidden />}
            {title}
            <span className="tabular-nums text-ink-faint">{rows.length}</span>
          </CardTitle>
          {action}
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {rows.length === 0 ? (
            <p className="text-ink-faint">{emptyTitle}</p>
          ) : (
            <>
              {/*
                The first cell of the first few rows. Every section puts the
                name there, so one rule gives every card a preview without a
                second description of what each row is called.
              */}
              <ul className="space-y-1">
                {rows.slice(0, previewCount).map((row) => (
                  <li key={row.id} className="truncate text-ink">
                    {row.cells[0]}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="flex items-center gap-0.5 text-xs font-medium text-brand hover:underline"
              >
                {rows.length > previewCount
                  ? `View all ${rows.length}`
                  : `Open ${title.toLowerCase()}`}
                <ChevronRight className="size-3" aria-hidden />
              </button>
            </>
          )}
        </CardContent>
      </Card>

      <Modal
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // A filter left on from last time is a list that looks empty for no
          // visible reason the next time it opens.
          if (!next) reset();
        }}
        title={title}
        {...(Icon ? { icon: Icon } : {})}
        description={
          narrowed ? `${visible.length} of ${rows.length} shown` : `${rows.length} in total`
        }
        size="lg"
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1 space-y-1">
              <Label htmlFor={`browse-${title}`} className="sr-only">
                Search {title.toLowerCase()}
              </Label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint"
                  aria-hidden
                />
                <Input
                  id={`browse-${title}`}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder={`Search ${title.toLowerCase()} by name`}
                  className="pl-7"
                  autoFocus
                />
              </div>
            </div>

            {options.map((filter) =>
              filter.values.length === 0 ? null : (
                <div key={filter.key} className="space-y-1">
                  <Label htmlFor={`browse-${title}-${filter.key}`} className="text-xs">
                    {filter.label}
                  </Label>
                  <Select
                    id={`browse-${title}-${filter.key}`}
                    value={chosen[filter.key] ?? ''}
                    onChange={(event) =>
                      setChosen((current) => ({ ...current, [filter.key]: event.target.value }))
                    }
                    className="w-40"
                  >
                    <option value="">Any</option>
                    {filter.values.map((value) => (
                      <option key={value} value={value}>
                        {humanise(value)}
                      </option>
                    ))}
                  </Select>
                </div>
              ),
            )}

            {showWindows && (
              <div className="space-y-1">
                <Label htmlFor={`browse-${title}-window`} className="text-xs">
                  Due within
                </Label>
                <Select
                  id={`browse-${title}-window`}
                  value={withinDays ?? ''}
                  onChange={(event) =>
                    setWithinDays(event.target.value ? Number(event.target.value) : undefined)
                  }
                  className="w-40"
                >
                  <option value="">Any time</option>
                  {EXPIRY_WINDOWS.map((days) => (
                    <option key={days} value={days}>
                      Next {days} days
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          {visible.length === 0 ? (
            <EmptyState
              title={narrowed ? 'Nothing matches' : emptyTitle}
              {...(narrowed
                ? { description: 'Clear the search or the filters to see the rest.' }
                : emptyDescription
                  ? { description: emptyDescription }
                  : {})}
            />
          ) : (
            <div className="-mx-1 overflow-x-auto">
              <SelectableTable
                // Bulk selection is meaningless without a target, and three of
                // the five sections have no bulk actions. `selectable={false}`
                // renders the same table without checkboxes.
                target={bulk?.target ?? 'node'}
                selectable={bulk?.selectable ?? false}
                columns={columns}
                rows={visible}
              />
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
