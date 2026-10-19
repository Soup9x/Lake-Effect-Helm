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
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArchiveRestore, Check, Copy, ExternalLink, EyeOff, KeyRound, Lock, Pencil, Trash2,
} from 'lucide-react';
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
import { copyUnaudited } from '@/lib/ui/clipboard';

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
  actorRoleRank,
  columnScope,
  extraColumns = [],
  canDelete = false,
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
        // A contact's removal is asset:write, as its creation is; files and
        // written documents are asset:delete.
        ...(canWrite && (canDelete || kind === 'contact') && kind && supportsMode(kind, 'delete')
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
    () => [
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
    ],
    [labels, extraColumns],
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
        columnMenu={
          <ColumnMenu columns={choices} hidden={hidden} onToggle={toggle} onReset={reset} />
        }
      />
      <DataTable
        rows={rows}
        columns={columns}
        hiddenColumns={hidden}
        query={query}
        // Not selectable: nothing here acts on a selection. The checkboxes this
        // used to render ticked and did nothing, because a category mixes
        // records BulkBar cannot act on together (assets, documents, contacts,
        // sites, folders). Bulk actions live on the clients list.
        emptyMessage={`No ${categoryLabel.toLowerCase()} recorded for this client yet.`}
      />

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
