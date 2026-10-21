'use client';

/**
 * The grid for one category, with its filter bar.
 *
 * A CLIENT COMPONENT WRAPPING TWO OTHERS, which exists so the page stays a server
 * component. The filter text and the sort live in the browser; the rows do not.
 * Without this wrapper the page itself would have to be a client component, and
 * every query it runs would have to move to an endpoint.
 *
 * SELECTION, on lists of entries and on Contacts. A list that is all entries —
 * devices, credentials, domains, the global lists — gets checkboxes and the
 * bulk bar: archive or restore, tags, export, and Make copies — and so does a
 * Contacts list, for contacts. A list mixing kinds the bulk actions cannot
 * treat alike (documents with folders, locations) does not, because a checkbox
 * that does nothing is worse than none.
 *
 * WHAT IT DOES NOT DO: decrypt anything. The OTP badge is a LINK to the credential, not a
 * code — generating one requires secret:reveal and writes an audit row, and a
 * grid that minted codes for eighty rows on render would be eighty audited
 * reveals nobody asked for.
 */
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArchiveRestore, CopyPlus, ExternalLink, EyeOff, KeyRound, Lock, Pencil, Trash2,
} from 'lucide-react';
import { BulkBar } from '../bulk-bar';
import { CopyEntryDialog } from '../copy-entry-dialog';
import { isCopyable } from '@/lib/assets/copyable';
import { FilterToolbar } from './filter-toolbar';
import { ColumnMenu, useHiddenColumns, type ColumnChoice } from './column-menu';
import { DataTable, type Column, type GridRow } from './data-table';
import { matchesBrowse } from '@/lib/ui/browse';
import { RowRemoveDialog, supportsMode, type RemoveKind, type RemoveMode } from './row-remove-dialog';
import { ContactForm } from './contact-form';
import { SiteForm } from '../site-form';
import type { SiteValues } from '@/lib/sites/values';
import { RowPermissionsDialog, type RowPermissions } from './row-permissions-dialog';
import { Badge } from '../ui/badge';
import { formatDate } from '@/lib/ui/format';

export interface CategoryRecord {
  id: string;
  name: string;
  /** Where the name links. Omitted for rows with no detail page yet. */
  href?: string | undefined;
  /** A line under the name: a contact's tags. Matched by the filter too. */
  subtext?: string | null | undefined;
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
  /** What removing this row actually does. Omitted where it cannot be removed. */
  removeKind?: RemoveKind | undefined;
  /** An entry's kind (asset_node.node_type), for Make a copy. Omitted for anything else. */
  nodeType?: string | undefined;
  /**
   * Shown because "Include archived" is on. Its actions become Restore and,
   * for whoever holds asset:delete, Delete permanently.
   */
  archived?: boolean | undefined;
  /** Who can see it. Omitted for rows with no visibility flag — contacts, sites. */
  permissions?: RowPermissions | undefined;
  /** A contact row: Edit opens the contact dialog rather than a page. */
  editContact?: { organizationId: string } | undefined;
  /** A location row: Edit opens the location dialog with these values. */
  editSite?: { organizationId: string; values: SiteValues } | undefined;
  /** Values for the category's extra columns (see CategoryGrid's extraColumns). */
  cells?: Record<string, string | null> | undefined;
}

/** A column a category adds beyond the shared four: configurations' OS, IP, serial… */
export interface ExtraColumn {
  key: string;
  header: string;
  /** Hidden at narrow widths. */
  secondary?: boolean | undefined;
}

interface Row extends GridRow {
  record: CategoryRecord;
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
  actorRoleRank,
  columnScope,
  extraColumns = [],
  canDelete = false,
  emptyMessage,
  omitColumns,
  archivable = true,
}: {
  records: readonly CategoryRecord[];
  total: number;
  categoryLabel: string;
  canWrite: boolean;
  labels?: ColumnLabels;
  /** Caps the minimum-role select in the permissions dialog. */
  actorRoleRank: number;
  /** Namespaces the viewer's column choice. One per category. */
  columnScope: string;
  extraColumns?: readonly ExtraColumn[] | undefined;
  /** asset:delete — offers Delete permanently on archived rows. */
  canDelete?: boolean | undefined;
  /** For a list that is not a client's. */
  emptyMessage?: string | undefined;
  /** Columns a list has nothing for, left out rather than shown as dashes. */
  omitColumns?: readonly ('secondary' | 'type' | 'extra' | 'updatedBy')[] | undefined;
  /** False where the rows have no archive, so Include archived would do nothing. */
  archivable?: boolean | undefined;
}) {
  const params = useSearchParams();
  const query = params?.get('q') ?? '';

  /*
   * ONE DIALOG EACH, driven by which row asked for it, rather than a pair per
   * row. Eighty rows would otherwise mount a hundred and sixty dialogs — all
   * closed, all holding state — and the Radix portal for each is real work on
   * every render.
   */
  const { hidden, toggle, reset } = useHiddenColumns(columnScope);

  const [removing, setRemoving] = useState<{ record: CategoryRecord; mode: RemoveMode } | null>(null);
  const [permissioning, setPermissioning] = useState<CategoryRecord | null>(null);
  const [editingContact, setEditingContact] = useState<CategoryRecord | null>(null);
  const [editingSite, setEditingSite] = useState<CategoryRecord | null>(null);
  const [copying, setCopying] = useState<CategoryRecord | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [clearSignal, setClearSignal] = useState(0);

  // Checkboxes only where every row is an entry, or every row a contact: see
  // the header. A list mixing the two would need two kinds of bulk action.
  const bulkTarget: 'node' | 'contact' | null =
    records.length > 0 && records.every((r) => r.removeKind === 'node') ? 'node'
      : records.length > 0 && records.every((r) => r.removeKind === 'contact') ? 'contact'
        : null;
  const selectable = canWrite && bulkTarget !== null;
  const chosen = useMemo(() => {
    const ids = new Set(selected);
    return records.filter((r) => ids.has(r.id));
  }, [records, selected]);

  /*
   * A row's actions. A folder's is Delete, only ever of an empty folder; an
   * archived row's are Restore and, for asset:delete, Delete permanently —
   * archive first, then delete, which is the rule the database enforces too.
   */
  const actionsFor = useCallback((record: CategoryRecord) => {
    const kind = record.removeKind;
    if (record.folder) {
      return canWrite && kind
        ? [{ label: 'Delete', icon: Trash2, tone: 'danger' as const,
             onClick: () => setRemoving({ record, mode: 'remove' }) }]
        : [];
    }
    if (record.archived) {
      return [
        ...(canWrite && kind && supportsMode(kind, 'restore')
          ? [{ label: 'Restore', icon: ArchiveRestore, onClick: () => setRemoving({ record, mode: 'restore' }) }]
          : []),
        // A contact's, a location's and a diagram's removal is asset:write, as
        // their creation is; files and written documents are asset:delete.
        ...(canWrite && (canDelete || kind === 'contact' || kind === 'site' || kind === 'diagram') && kind && supportsMode(kind, 'delete')
          ? [{ label: 'Delete permanently', icon: Trash2, tone: 'danger' as const,
               onClick: () => setRemoving({ record, mode: 'delete' }) }]
          : []),
      ];
    }
    return [
      // A row whose edit is a dialog links its name to its page instead.
      ...(canWrite && record.href && !record.editContact && !record.editSite
        ? [{ label: 'Edit', icon: Pencil, href: record.href }]
        : []),
      // A contact has no page of its own; its edit is a dialog (0790).
      ...(canWrite && record.editContact
        ? [{ label: 'Edit', icon: Pencil, onClick: () => setEditingContact(record) }]
        : []),
      ...(canWrite && record.editSite
        ? [{ label: 'Edit', icon: Pencil, onClick: () => setEditingSite(record) }]
        : []),
      ...(canWrite && isCopyable(record.nodeType)
        ? [{ label: 'Make a copy', icon: CopyPlus, onClick: () => setCopying(record) }]
        : []),
      // Only where there is a flag to edit: a contact has no visibility
      // of its own, so offering the control would be offering nothing.
      ...(canWrite && record.permissions
        ? [{ label: 'Permissions', icon: Lock, onClick: () => setPermissioning(record) }]
        : []),
      ...(canWrite && kind
        ? [{
            label: 'Remove', icon: Trash2, tone: 'danger' as const,
            onClick: () => setRemoving({ record, mode: 'remove' }),
          }]
        : []),
    ];
  }, [canWrite, canDelete]);

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
        search: [record.name, record.subtext, record.secondary, record.type, record.extra,
                 ...Object.values(record.cells ?? {})]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
        actions: actionsFor(record),
      })),
    [records, actionsFor],
  );

  const columns = useMemo<Column<Row>[]>(
    () => ([
      {
        key: 'name',
        header: 'Name',
        sortBy: (r) => r.record.name.toLowerCase(),
        cell: (r) => (
          <span className="flex items-center gap-1.5">
            <span className="min-w-0">
              {r.record.href ? (
                <Link href={r.record.href} className="font-medium text-ink hover:underline">
                  {r.record.name}
                </Link>
              ) : (
                <span className="font-medium text-ink">{r.record.name}</span>
              )}
              {r.record.subtext && (
                <span className="block text-xs text-ink-faint">{r.record.subtext}</span>
              )}
            </span>
            {r.record.archived && <Badge tone="neutral">Archived</Badge>}
            {r.record.internalOnly && (
              <span title="Internal only — not visible to the client">
                <EyeOff className="size-3.5 text-ink-faint" aria-label="Internal only" />
              </span>
            )}
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
      ...extraColumns.map<Column<Row>>((c) => ({
        key: c.key,
        header: c.header,
        secondary: c.secondary,
        sortBy: (r) => r.record.cells?.[c.key]?.toLowerCase() ?? null,
        cell: (r) => <span className="text-ink-muted">{r.record.cells?.[c.key] || '—'}</span>,
      })),
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
    ] as Column<Row>[]).filter((c) => !(omitColumns as readonly string[] | undefined)?.includes(c.key)),
    [labels, extraColumns, omitColumns],
  );

  // The same matcher DataTable filters with, so the count agrees with the rows.
  const shown = useMemo(() => {
    if (!query.trim()) return rows.length;
    return rows.filter((r) => matchesBrowse({ search: r.search ?? '' }, { text: query })).length;
  }, [rows, query]);

  /* The identity column is not hideable — see ColumnMenu. */
  const choices: ColumnChoice[] = columns.map((c, i) => ({
    key: c.key,
    header: c.header,
    hideable: i > 0,
  }));

  return (
    <>
      <FilterToolbar
        shown={shown}
        total={total}
        showArchivedToggle={archivable}
        columnMenu={
          <ColumnMenu columns={choices} hidden={hidden} onToggle={toggle} onReset={reset} />
        }
      />
      <DataTable
        rows={rows}
        columns={columns}
        hiddenColumns={hidden}
        query={query}
        selectable={selectable}
        onSelectionChange={setSelected}
        clearSelectionSignal={clearSignal}
        emptyMessage={emptyMessage ?? `No ${categoryLabel.toLowerCase()} recorded for this client yet.`}
      />

      {selectable && chosen.length > 0 && (
        <BulkBar
          target={bulkTarget ?? 'node'}
          ids={chosen.map((r) => r.id)}
          // Restore when everything ticked is archived; Archive otherwise.
          archived={chosen.every((r) => r.archived)}
          copyable={bulkTarget === 'contact' || chosen.every((r) => isCopyable(r.nodeType))}
          // Clears both halves: this copy, which hides the bar, and the
          // table's own set, which owns the checkboxes.
          onClear={() => {
            setSelected([]);
            setClearSignal((n) => n + 1);
          }}
        />
      )}

      {copying?.nodeType && (
        <CopyEntryDialog
          key={copying.id}
          nodeId={copying.id}
          name={copying.name}
          nodeType={copying.nodeType}
          open
          onOpenChange={(next) => { if (!next) setCopying(null); }}
        />
      )}

      {removing?.record.removeKind && (
        <RowRemoveDialog
          rowId={removing.record.id}
          rowLabel={removing.record.name}
          kind={removing.record.removeKind}
          mode={removing.mode}
          blockedReason={
            removing.record.folder && removing.record.folder.itemCount > 0
              ? `It still holds ${removing.record.folder.itemCount} item${removing.record.folder.itemCount === 1 ? '' : 's'}, counting archived ones. Move or delete them first.`
              : undefined
          }
          open
          onOpenChange={(next) => { if (!next) setRemoving(null); }}
        />
      )}

      {editingContact?.editContact && (
        <ContactForm
          organizationId={editingContact.editContact.organizationId}
          contactId={editingContact.id}
          open
          onOpenChange={(next) => { if (!next) setEditingContact(null); }}
        />
      )}

      {editingSite?.editSite && (
        <SiteForm
          key={editingSite.id}
          organizationId={editingSite.editSite.organizationId}
          site={{ id: editingSite.id, values: editingSite.editSite.values }}
          open
          onOpenChange={(next) => { if (!next) setEditingSite(null); }}
        />
      )}

      {permissioning?.permissions && (
        <RowPermissionsDialog
          rowId={permissioning.id}
          rowLabel={permissioning.name}
          kind={permissioning.removeKind === 'document' ? 'document' : 'node'}
          permissions={permissioning.permissions}
          actorRoleRank={actorRoleRank}
          open
          onOpenChange={(next) => { if (!next) setPermissioning(null); }}
        />
      )}
    </>
  );
}
