'use client';

/**
 * Taking a row off the list, and saying precisely what that means.
 *
 * IT MEANS DIFFERENT THINGS PER CATEGORY, and a single "Are you sure?" would be
 * lying about at least one of them:
 *
 *   An asset, an uploaded file or a written document ARCHIVES. archived_at is
 *   set, it leaves the list, and it can be restored. Nothing is destroyed, and
 *   the credential material behind a password survives untouched.
 *
 *   A contact ARCHIVES too, since 0850, and is deleted from the archive.
 *
 *   A site is REMOVED. It carries deleted_at and has no archive view and no
 *   restore path, so from the interface this is one way.
 *
 *   A folder is DELETED, and only when it is empty: both foreign keys into the
 *   tree are ON DELETE RESTRICT, so the database refuses anything else.
 *
 * THREE MODES. 'remove' is the above. 'restore' flips archived_at back.
 * 'delete' is permanent destruction, offered only on a row that is ALREADY
 * archived and only to asset:delete — helm.delete_document and
 * helm.delete_document_page refuse anything else whatever this dialog offers,
 * so archive-then-delete is the database's rule and this is just its door.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArchiveRestore, Loader2, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { apiFetch, type ApiRequest } from '@/lib/ui/api';

export type RemoveKind = 'node' | 'document' | 'page' | 'folder' | 'contact' | 'site';
export type RemoveMode = 'remove' | 'restore' | 'delete';

const COPY: Record<RemoveKind, { verb: string; body: string; reversible: boolean }> = {
  node: {
    verb: 'Archive',
    body: 'It leaves this list and stops appearing in search. Nothing is destroyed — any stored value is kept, and it can be restored from the archive.',
    reversible: true,
  },
  document: {
    verb: 'Archive',
    body: 'It leaves this list. The file is kept and can be restored from the archive — tick "Include archived" to find it. Deleting it permanently is done from there.',
    reversible: true,
  },
  page: {
    verb: 'Archive',
    body: 'It leaves this list and stops appearing in search. Every version is kept and it can be restored from the archive — tick "Include archived" to find it. Deleting it permanently is done from there.',
    reversible: true,
  },
  folder: {
    verb: 'Delete',
    body: 'The folder is removed. Only an empty folder can be deleted.',
    reversible: false,
  },
  contact: {
    verb: 'Archive',
    body: 'This person leaves the list, search and the contact pickers. Everything about them is kept and they can be restored — tick "Include archived" to find them. Deleting them permanently is done from there.',
    reversible: true,
  },
  site: {
    verb: 'Remove',
    body: 'The location stops appearing anywhere in Helm. Anything recorded there — assets, contacts, documents — keeps its record and simply shows no site. Sites have no archive view, so this cannot be undone from the interface.',
    reversible: false,
  },
};

/** The request each kind and mode makes. Null where the pair is not offered. */
function requestFor(kind: RemoveKind, mode: RemoveMode, id: string): [string, ApiRequest] | null {
  if (mode === 'remove') {
    switch (kind) {
      // The same endpoint the bulk toolbar uses, with one id — so a single row
      // and a selection of forty take exactly the same path.
      case 'node': return ['/api/bulk/archive', { json: { target: 'node', ids: [id], archived: true } }];
      case 'document': return [`/api/documents/${id}`, { method: 'PATCH', json: { archived: true } }];
      case 'page': return [`/api/document-pages/${id}`, { method: 'PATCH', json: { archived: true } }];
      case 'folder': return [`/api/document-folders/${id}`, { method: 'DELETE' }];
      case 'contact': return [`/api/contacts/${id}`, { method: 'PATCH', json: { archived: true } }];
      case 'site': return [`/api/sites/${id}`, { method: 'DELETE' }];
    }
  }
  if (mode === 'restore') {
    switch (kind) {
      case 'node': return ['/api/bulk/archive', { json: { target: 'node', ids: [id], archived: false } }];
      case 'document': return [`/api/documents/${id}`, { method: 'PATCH', json: { archived: false } }];
      case 'page': return [`/api/document-pages/${id}`, { method: 'PATCH', json: { archived: false } }];
      case 'contact': return [`/api/contacts/${id}`, { method: 'PATCH', json: { archived: false } }];
      default: return null;
    }
  }
  switch (kind) {
    case 'document': return [`/api/documents/${id}`, { method: 'DELETE' }];
    case 'page': return [`/api/document-pages/${id}`, { method: 'DELETE' }];
    case 'contact': return [`/api/contacts/${id}`, { method: 'DELETE' }];
    default: return null;
  }
}

/** Whether a kind can be restored from, or deleted out of, the archive. */
export function supportsMode(kind: RemoveKind, mode: RemoveMode): boolean {
  return requestFor(kind, mode, '00000000-0000-0000-0000-000000000000') !== null;
}

export function RowRemoveDialog({
  rowId,
  rowLabel,
  kind,
  mode = 'remove',
  blockedReason,
  open,
  onOpenChange,
  afterHref,
}: {
  rowId: string;
  rowLabel: string;
  kind: RemoveKind;
  mode?: RemoveMode;
  /** Why this cannot go ahead — a folder that still holds things. */
  blockedReason?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where to go once it is gone, when the page showing it no longer exists. */
  afterHref?: string | undefined;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy =
    mode === 'restore'
      ? { verb: 'Restore', body: 'It goes back on the list and into search, exactly as it was archived.', reversible: true }
      : mode === 'delete'
        ? {
            verb: 'Delete permanently',
            body: kind === 'page'
              ? 'The document and every one of its versions are destroyed. Files attached to it go with it.'
              : kind === 'contact'
                ? 'This person is removed from Helm for good, and cannot be restored.'
                : 'The file is destroyed. Anything that linked to it will show it as gone.',
            reversible: false,
          }
        : COPY[kind];

  async function confirm() {
    const request = requestFor(kind, mode, rowId);
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch(request[0], request[1]);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onOpenChange(false);
      if (afterHref) router.push(afterHref);
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'delete' ? `Delete ${rowLabel} permanently?` : `${copy.verb} ${rowLabel}?`}
      icon={mode === 'restore' ? ArchiveRestore : Trash2}
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">{copy.body}</p>

        {blockedReason ? (
          <p className="flex items-start gap-2 rounded-md border border-sev-warning/30 bg-sev-warning/5 px-3 py-2 text-sm text-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-sev-warning" aria-hidden />
            {blockedReason}
          </p>
        ) : !copy.reversible && (
          <p className="flex items-start gap-2 rounded-md border border-sev-warning/30 bg-sev-warning/5 px-3 py-2 text-sm text-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-sev-warning" aria-hidden />
            This cannot be undone from Helm.
          </p>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={mode === 'restore' ? 'primary' : 'danger'}
            size="sm"
            onClick={() => void confirm()}
            disabled={busy || Boolean(blockedReason)}
          >
            {busy && <Loader2 className="animate-spin" />}
            {copy.verb}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
