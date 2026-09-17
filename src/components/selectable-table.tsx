'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { BulkBar, type BulkTarget } from './bulk-bar';
import { cn } from '@/lib/ui/cn';

export interface SelectableRow {
  id: string;
  /** For the accessible label on the row's checkbox. */
  label: string;
  cells: ReactNode[];
  /**
   * Rows above this index are pinned and get a rule under the last of them.
   * Passed rather than computed so the table stays ignorant of favourites.
   */
  dividerAfter?: boolean;
}

/**
 * A table whose rows can be ticked, with the bulk bar attached.
 *
 * ONE component for clients and for credentials. They are different tables with
 * different columns, and the selection behaviour — the header checkbox that
 * means "all of these", shift to extend a range, the count, the clear — is
 * identical and worth writing once. The caller supplies the columns and the
 * cells; this owns nothing but which ids are ticked.
 *
 * Client component, so the page around it stays a server component and the
 * queries that build the rows keep running under RLS on the server.
 */
export function SelectableTable({
  columns,
  rows,
  target,
  archived = false,
  selectable = true,
}: {
  columns: ReactNode[];
  rows: SelectableRow[];
  target: BulkTarget;
  archived?: boolean;
  /** False for a read-only role: no checkboxes, no bar, same table. */
  selectable?: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);

  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  // Only ids still on screen. A filter change that removes a selected row must
  // not leave it in a selection the person can no longer see or deselect.
  const live = useMemo(() => ids.filter((id) => selected.has(id)), [ids, selected]);
  const allTicked = live.length > 0 && live.length === ids.length;

  function toggle(index: number, shiftKey: boolean) {
    const row = rows[index];
    if (!row) return;

    setSelected((previous) => {
      const next = new Set(previous);
      // Shift extends from the last row touched, the way every file manager
      // and mail client has worked for thirty years. Without it, tagging forty
      // consecutive clients is forty clicks.
      if (shiftKey && anchor !== null) {
        const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
        const adding = !previous.has(row.id);
        for (let i = from; i <= to; i += 1) {
          const id = rows[i]?.id;
          if (!id) continue;
          if (adding) next.add(id);
          else next.delete(id);
        }
      } else if (next.has(row.id)) {
        next.delete(row.id);
      } else {
        next.add(row.id);
      }
      return next;
    });
    setAnchor(index);
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {selectable && (
              <TableHead className="w-8">
                <input
                  type="checkbox"
                  checked={allTicked}
                  // Some but not all: the box shows a dash, because an empty
                  // box next to nine ticked rows reads as "nothing selected".
                  ref={(el) => {
                    if (el) el.indeterminate = live.length > 0 && !allTicked;
                  }}
                  onChange={() => setSelected(allTicked ? new Set() : new Set(ids))}
                  className="size-4 rounded border-border-strong"
                  aria-label={allTicked ? 'Deselect all' : 'Select all'}
                />
              </TableHead>
            )}
            {columns.map((column, index) => (
              <TableHead key={index}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow
              key={row.id}
              className={cn(
                row.dividerAfter && 'border-b-2 border-b-border',
                selected.has(row.id) && 'bg-brand-tint/40',
              )}
            >
              {selectable && (
                <TableCell className="pr-0">
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={() => undefined}
                    onClick={(event) => toggle(index, event.shiftKey)}
                    className="size-4 rounded border-border-strong"
                    aria-label={`Select ${row.label}`}
                  />
                </TableCell>
              )}
              {row.cells.map((cell, cellIndex) => (
                <TableCell key={cellIndex}>{cell}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {selectable && (
        <BulkBar
          target={target}
          ids={live}
          archived={archived}
          onClear={() => {
            setSelected(new Set());
            setAnchor(null);
          }}
        />
      )}
    </>
  );
}
