'use client';

/**
 * The one control in Helm that destroys something.
 *
 * ARCHIVE FIRST, and this component never sees a live item: the caller renders
 * it only in the Archived view. That is a convenience, not the rail — the rail
 * is in helm.delete_organization() and helm.delete_credential(), which refuse
 * anything whose archived_at is null whoever is asking and by whatever route.
 * A rule that only exists in an interface is one a script walks past.
 *
 * TYPE THE NAME. A confirm dialog with a red button is dismissed by muscle
 * memory; a dialog that will not enable its button until the client's name has
 * been typed cannot be. It is the only thing standing between a misclick and a
 * client's entire documentation, so it is deliberately more friction than the
 * rest of the product has anywhere.
 *
 * SAY WHAT GOES. The counts come from the server, so the sentence is about this
 * client rather than clients in general: "7 assets, 2 credentials, 1 site".
 * Somebody about to destroy a record is owed the size of it.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input, Label } from './ui/field';
import { Modal } from './ui/modal';

export interface DeleteCounts {
  assets?: number;
  secrets?: number;
  sites?: number;
  contacts?: number;
  notes?: number;
  attachments?: number;
}

/** "7 assets, 2 credentials and 1 site" — only the things that are actually there. */
export function describeCascade(counts: DeleteCounts): string {
  const parts = [
    [counts.assets, 'asset'],
    [counts.secrets, 'credential'],
    [counts.sites, 'site'],
    [counts.contacts, 'contact'],
    [counts.notes, 'note'],
    [counts.attachments, 'attachment'],
  ] as const;
  const listed = parts
    .filter(([n]) => (n ?? 0) > 0)
    .map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`);
  if (listed.length === 0) return 'nothing else is recorded against it';
  if (listed.length === 1) return listed[0]!;
  return `${listed.slice(0, -1).join(', ')} and ${listed.at(-1)}`;
}

export function DeletePermanently({
  endpoint,
  name,
  kind,
  counts,
  redirectTo,
}: {
  /** The DELETE URL. /api/organizations/:id or /api/assets/:id. */
  endpoint: string;
  name: string;
  kind: 'client' | 'credential';
  /** What goes with it. Omitted for a credential, which takes only itself. */
  counts?: DeleteCounts;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = typed.trim() === name.trim();

  async function destroy(event: React.FormEvent) {
    event.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: 'DELETE' });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `It could not be deleted (${response.status}).`);
        return;
      }
      setOpen(false);
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="gap-1.5 text-danger"
      >
        <Trash2 />
        Delete permanently
      </Button>

      <Modal
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setTyped('');
            setError(null);
          }
        }}
        title={`Delete ${name} permanently`}
        icon={AlertTriangle}
        description="This cannot be undone."
      >
        <form onSubmit={destroy} className="space-y-3">
          <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-ink">
            {kind === 'client' ? (
              <>
                <p>
                  Deleting this client also deletes {describeCascade(counts ?? {})}, in one
                  operation. None of it is recoverable.
                </p>
                <p className="mt-2 text-xs text-ink-muted">
                  The audit trail is not deleted. What was done to this client, and by whom,
                  remains readable afterwards.
                </p>
              </>
            ) : (
              <>
                <p>
                  Deleting this credential removes the stored value and every past version of
                  it. Material also documented elsewhere is left alone.
                </p>
                <p className="mt-2 text-xs text-ink-muted">
                  The audit trail is not deleted.
                </p>
              </>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="confirm-name">
              Type <span className="font-mono text-ink">{name}</span> to confirm
            </Label>
            <Input
              id="confirm-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoFocus
              disabled={busy}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" size="sm" disabled={!confirmed || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Delete permanently
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
