'use client';

/**
 * Taking a row off the list, and saying precisely what that means.
 *
 * IT MEANS DIFFERENT THINGS PER CATEGORY, and a single "Are you sure?" would be
 * lying about at least one of them:
 *
 *   An asset or a document ARCHIVES. archived_at is set, it leaves the list, and
 *   it can be restored — the bulk endpoint flips the same flag back. Nothing is
 *   destroyed, and the credential material behind a password survives untouched.
 *
 *   A contact or a site is REMOVED. Those tables carry deleted_at and have no
 *   archive view and no restore path, so from the interface this is one way.
 *
 * Permanent destruction is deliberately NOT here. helm.delete_credential and
 * helm.delete_document both refuse to run on anything that is not already
 * archived and both sit behind asset:delete — a trash icon on a grid row is the
 * wrong affordance for an irreversible act on encrypted material, and the API
 * says so independently of what this dialog offers.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';

export type RemoveKind = 'node' | 'document' | 'contact' | 'site';

const COPY: Record<RemoveKind, { verb: string; body: string; reversible: boolean }> = {
  node: {
    verb: 'Archive',
    body: 'It leaves this list and stops appearing in search. Nothing is destroyed — any stored value is kept, and it can be restored from the archive.',
    reversible: true,
  },
  document: {
    verb: 'Archive',
    body: 'It leaves this list. The file itself is kept and can be restored; permanently destroying it is a separate, more privileged act.',
    reversible: true,
  },
  contact: {
    verb: 'Remove',
    body: 'This person stops appearing anywhere in Helm. Contacts have no archive view, so this cannot be undone from the interface.',
    reversible: false,
  },
  site: {
    verb: 'Remove',
    body: 'The location stops appearing anywhere in Helm. Anything recorded there — assets, contacts, documents — keeps its record and simply shows no site. Sites have no archive view, so this cannot be undone from the interface.',
    reversible: false,
  },
};

export function RowRemoveDialog({
  rowId,
  rowLabel,
  kind,
  open,
  onOpenChange,
}: {
  rowId: string;
  rowLabel: string;
  kind: RemoveKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[kind];

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const response = await (async () => {
        switch (kind) {
          case 'node':
            // The same endpoint the bulk toolbar uses, with one id — so a single
            // row and a selection of forty take exactly the same path.
            return fetch('/api/bulk/archive', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ target: 'node', ids: [rowId], archived: true }),
            });
          case 'document':
            return fetch(`/api/documents/${rowId}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ archived: true }),
            });
          case 'contact':
            return fetch(`/api/contacts/${rowId}`, { method: 'DELETE' });
          case 'site':
            return fetch(`/api/sites/${rowId}`, { method: 'DELETE' });
        }
      })();

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError((body as { error?: { message?: string } } | null)?.error?.message
          ?? `${rowLabel} could not be removed.`);
        return;
      }

      onOpenChange(false);
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`${copy.verb} ${rowLabel}?`}
      icon={Trash2}
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">{copy.body}</p>

        {!copy.reversible && (
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
          <Button variant="danger" size="sm" onClick={() => void confirm()} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {copy.verb}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
