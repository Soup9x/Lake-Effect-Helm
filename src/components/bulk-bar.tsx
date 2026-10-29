'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Archive, ArchiveRestore, CopyPlus, FileDown, Loader2, Tag, Trash2, X } from 'lucide-react';
import { useDismissable } from '@/lib/ui/use-dismissable';
import { apiFetch } from '@/lib/ui/api';
import { withStepUp } from '@/lib/ui/step-up';
import { useStepUp } from './step-up-dialog';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';
import { Modal } from './ui/modal';

/**
 * What is selected. 'document' is a Documents list's files and written
 * documents together; 'vault' is the signed-in person's own passwords, which
 * offer Delete and nothing else — no tags, no archive, never exported.
 */
export type BulkTarget = 'client' | 'node' | 'contact' | 'document' | 'site' | 'vault';

const NOUNS: Record<BulkTarget, string> = {
  client: 'client',
  node: 'item',
  contact: 'contact',
  document: 'document',
  site: 'location',
  vault: 'password',
};

/**
 * The bar that appears when something is selected.
 *
 * Fixed to the bottom rather than pushed into the page, because a selection
 * made at row 80 of a client list has its actions at row 1 otherwise, and the
 * person scrolls back up to find out what they can do.
 *
 * Every action reports what the server said, INCLUDING a refusal naming how
 * many items were not the caller's to touch. The server refuses the whole
 * batch in that case, so the selection is still intact and still on screen —
 * which is the point of refusing rather than partly applying: they can deselect
 * the ones they cannot reach and try again.
 */
export function BulkBar({
  target,
  ids,
  onClear,
  archived = false,
  copyable = false,
  deletable = false,
}: {
  target: BulkTarget;
  ids: string[];
  onClear: () => void;
  /** When the current view is the archive, the action is Restore rather than Archive. */
  archived?: boolean;
  /** Offer "Make copies": entries, none of them a kind that cannot be copied. */
  copyable?: boolean;
  /**
   * Offer "Delete": a selection this person may delete permanently — passwords
   * with secret:delete, documents with asset:delete, contacts, locations, and
   * their own vault. The server decides either way.
   */
  deletable?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const noun = NOUNS[target];
  // The person's own vault has no tags, no archive and no export.
  const managed = target !== 'vault';
  const label = `${ids.length} ${noun}${ids.length === 1 ? '' : 's'} selected`;

  async function post(path: string, body: unknown, verb: string) {
    setBusy(verb);
    setError(null);
    setDone(null);
    try {
      const result = await apiFetch<{ affected?: number; clients?: number } | undefined>(path, {
        json: body,
      });

      if (!result.ok) {
        // A request that never arrived changed nothing, and the bar should say
        // so: the person is about to decide whether to retry a bulk action.
        setError(result.code === 'network' ? `${result.message} Nothing was changed.` : result.message);
        return false;
      }

      const payload = result.value;
      setDone(
        payload?.clients !== undefined
          ? `Queued ${payload.clients} export${payload.clients === 1 ? '' : 's'}.`
          : `${verb} ${payload?.affected ?? ids.length} ${noun}${(payload?.affected ?? ids.length) === 1 ? '' : 's'}.`,
      );
      onClear();
      startTransition(() => router.refresh());
      return true;
    } finally {
      setBusy(null);
    }
  }

  if (ids.length === 0) return null;

  return (
    <div className="sticky bottom-4 z-20 mx-auto flex w-fit max-w-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 rounded-full border border-border-strong bg-surface-raised px-3 py-2 shadow-lg">
        <span className="px-1 text-sm font-medium text-ink">{label}</span>

        {managed && <TagPopover target={target} ids={ids} onSubmit={post} busy={busy !== null} />}

        {managed && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              void post('/api/bulk/archive', { target, ids, archived: !archived }, archived ? 'Restored' : 'Archived')
            }
          >
            {archived ? <ArchiveRestore className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}
            {archived ? 'Restore' : 'Archive'}
          </Button>
        )}

        {managed && <ExportPopover target={target} ids={ids} onSubmit={post} busy={busy !== null} />}

        {copyable && !archived && target !== 'client' && target !== 'vault' && (
          <CopyAction
            target={target}
            ids={ids}
            busy={busy !== null}
            onDone={(count) => {
              setError(null);
              setDone(`Copied ${count} ${noun}${count === 1 ? '' : 's'}.`);
              onClear();
              startTransition(() => router.refresh());
            }}
            onError={(message) => { setDone(null); setError(message); }}
          />
        )}

        {deletable && target !== 'client' && (
          <DeleteAction target={target} ids={ids} onSubmit={post} busy={busy !== null} />
        )}

        <button
          type="button"
          onClick={onClear}
          className="rounded-full p-1.5 text-ink-faint hover:bg-surface-sunken hover:text-ink"
        >
          <X className="size-4" aria-hidden />
          <span className="sr-only">Clear selection</span>
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="rounded-md border border-ok/30 bg-ok/5 px-3 py-2 text-xs text-ok">
          {done}
        </p>
      )}
    </div>
  );
}

type Submit = (path: string, body: unknown, verb: string) => Promise<boolean>;

function TagPopover({
  target,
  ids,
  onSubmit,
  busy,
}: {
  target: BulkTarget;
  ids: string[];
  onSubmit: Submit;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissable(open, useCallback(() => setOpen(false), []), container, trigger);

  // Comma or whitespace separated. Somebody typing "production, buffalo" means
  // two tags, and a form that made them add one at a time would be used once.
  const tags = value
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);

  return (
    <div className="relative" ref={container}>
      <Button ref={trigger} variant="secondary" size="sm" disabled={busy} onClick={() => setOpen((v) => !v)}>
        <Tag className="size-4" aria-hidden />
        Tag
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Add tags"
          className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-md border border-border bg-surface-raised p-3 shadow-lg"
        >
          <Label htmlFor="bulk-tags">Tags</Label>
          <Input
            id="bulk-tags"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            placeholder="production, buffalo"
          />
          <FieldHint>Separate with commas. Existing tags are kept.</FieldHint>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={tags.length === 0}
              onClick={async () => {
                const ok = await onSubmit('/api/bulk/tags', { target, ids, tags, mode: 'add' }, 'Tagged');
                if (ok) {
                  setValue('');
                  setOpen(false);
                }
              }}
            >
              Add tags
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExportPopover({
  target,
  ids,
  onSubmit,
  busy,
}: {
  target: BulkTarget;
  ids: string[];
  onSubmit: Submit;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissable(open, useCallback(() => setOpen(false), []), container, trigger);

  return (
    <div className="relative" ref={container}>
      <Button ref={trigger} variant="secondary" size="sm" disabled={busy} onClick={() => setOpen((v) => !v)}>
        <FileDown className="size-4" aria-hidden />
        Export
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Export selection"
          className="absolute bottom-full left-0 z-30 mb-2 w-80 rounded-md border border-border bg-surface-raised p-3 shadow-lg"
        >
          <Label htmlFor="bulk-reason">Reason</Label>
          <Input
            id="bulk-reason"
            value={reason}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ticket 4821 — quarterly documentation handover"
          />
          <FieldHint>
            Recorded in the audit log. One export per client. Credential material is never included —
            request that one client at a time, from the Exports page.
          </FieldHint>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={reason.trim().length < 10}
              onClick={async () => {
                const ok = await onSubmit(
                  '/api/bulk/export',
                  { target, ids, reason: reason.trim() },
                  'Exported',
                );
                if (ok) {
                  setReason('');
                  setOpen(false);
                }
              }}
            >
              Queue exports
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Make copies": every selected entry as "<name> (copy)", credentials with
 * their passwords. Copying a password is reading it, so this is the one bulk
 * action that can be refused for a step-up or a reason: the step-up is asked
 * for once and the batch retried, and a reason, once given, applies to every
 * password in it. The server copies all of them or none (POST /api/bulk/copy).
 */
function CopyAction({
  target,
  ids,
  busy,
  onDone,
  onError,
}: {
  /** Entries; or contacts, locations and written documents, copied without a reveal. */
  target: 'node' | 'contact' | 'site' | 'document';
  ids: string[];
  busy: boolean;
  onDone: (count: number) => void;
  onError: (message: string) => void;
}) {
  const stepUp = useStepUp();
  const [working, setWorking] = useState(false);
  const [needsReason, setNeedsReason] = useState(false);
  const [reason, setReason] = useState('');

  // Read at call time, so the step-up retry sends what is in the box then.
  const attempt = () =>
    apiFetch<{ affected: number }>('/api/bulk/copy', {
      json: { target, ids, ...(reason.trim() ? { reason: reason.trim() } : {}) },
    });

  async function run() {
    setWorking(true);
    try {
      const result = await withStepUp(attempt, stepUp.prompt);
      if (!result.ok) {
        if (result.code === 'reason_required') setNeedsReason(true);
        onError(result.code === 'network' ? `${result.message} Nothing was copied.` : result.message);
        return;
      }
      setNeedsReason(false);
      setReason('');
      onDone(result.value?.affected ?? ids.length);
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      {stepUp.dialog}
      {needsReason && (
        <Input
          aria-label="Reason for copying these passwords"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason, for the audit log"
          maxLength={500}
          className="h-8 w-56"
        />
      )}
      <Button
        variant="secondary"
        size="sm"
        disabled={busy || working || (needsReason && reason.trim().length < 10)}
        onClick={() => void run()}
        title="Copy each as “<name> (copy)”; credentials bring their passwords, recorded as copies"
      >
        <CopyPlus className="size-4" aria-hidden />
        {needsReason ? 'Copy with reason' : 'Make copies'}
      </Button>
    </>
  );
}

/** What deleting each kind destroys, said before the person confirms it. */
const DELETE_COPY: Record<Exclude<BulkTarget, 'client'>, string> = {
  node: 'Each password and its stored value is destroyed. A value another entry also documents is kept for that entry.',
  document: 'Each file, or written document with every version and attached file, is destroyed. Anything that linked to it will show it as gone.',
  contact: 'Each person is removed from Helm for good.',
  site: 'Each location stops appearing anywhere in Helm. What was recorded there keeps its record and shows no location.',
  vault: 'Each password is removed from your vault for good.',
};

/**
 * "Delete": permanent, so it asks first, and not with a red button muscle
 * memory dismisses. The dialog names the count and what goes, and the button
 * stays off until "delete" is typed — less friction than typing a client's
 * name (DeletePermanently), because a selection has no one name to type.
 *
 * Live rows are archived and then deleted by the server, in that order, so the
 * database's archive-first rule is kept (POST /api/bulk/delete).
 */
function DeleteAction({
  target,
  ids,
  onSubmit,
  busy,
}: {
  target: Exclude<BulkTarget, 'client'>;
  ids: string[];
  onSubmit: Submit;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const count = `${ids.length} ${NOUNS[target]}${ids.length === 1 ? '' : 's'}`;

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setWorking(true);
    try {
      // The bar shows the outcome, success or refusal, under itself.
      await onSubmit('/api/bulk/delete', { target, ids }, 'Deleted');
      setOpen(false);
      setTyped('');
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => setOpen(true)} className="text-danger">
        <Trash2 className="size-4" aria-hidden />
        Delete
      </Button>
      <Modal
        open={open}
        onOpenChange={(next) => { setOpen(next); if (!next) setTyped(''); }}
        title={`Delete ${count} permanently?`}
        icon={Trash2}
      >
        <form className="space-y-4" onSubmit={(event) => void confirm(event)}>
          <p className="text-sm text-ink-muted">{DELETE_COPY[target]}</p>
          <p className="flex items-start gap-2 rounded-md border border-sev-warning/30 bg-sev-warning/5 px-3 py-2 text-sm text-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-sev-warning" aria-hidden />
            {target === 'vault'
              ? 'This cannot be undone.'
              : 'Anything not yet archived is archived and then deleted. This cannot be undone from Helm.'}
          </p>
          <div>
            <Label htmlFor="bulk-delete-confirm">Type delete to confirm</Label>
            <Input
              id="bulk-delete-confirm"
              value={typed}
              autoFocus
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
              placeholder="delete"
            />
          </div>
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={working}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              size="sm"
              disabled={working || typed.trim().toLowerCase() !== 'delete'}
            >
              {working && <Loader2 className="animate-spin" />}
              Delete {count}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
