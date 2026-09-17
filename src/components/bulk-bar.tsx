'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, FileDown, Tag, X } from 'lucide-react';
import { useDismissable } from '@/lib/ui/use-dismissable';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';

export type BulkTarget = 'client' | 'node';

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
}: {
  target: BulkTarget;
  ids: string[];
  onClear: () => void;
  /** When the current view is the archive, the action is Restore rather than Archive. */
  archived?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const noun = target === 'client' ? 'client' : 'item';
  const label = `${ids.length} ${noun}${ids.length === 1 ? '' : 's'} selected`;

  async function post(path: string, body: unknown, verb: string) {
    setBusy(verb);
    setError(null);
    setDone(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
        affected?: number;
        clients?: number;
      } | null;

      if (!response.ok) {
        setError(payload?.error?.message ?? `That did not work (${response.status}).`);
        return false;
      }

      setDone(
        payload?.clients !== undefined
          ? `Queued ${payload.clients} export${payload.clients === 1 ? '' : 's'}.`
          : `${verb} ${payload?.affected ?? ids.length} ${noun}${(payload?.affected ?? ids.length) === 1 ? '' : 's'}.`,
      );
      onClear();
      startTransition(() => router.refresh());
      return true;
    } catch {
      setError('The request did not reach the server. Nothing was changed.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (ids.length === 0) return null;

  return (
    <div className="sticky bottom-4 z-20 mx-auto flex w-fit max-w-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 rounded-full border border-border-strong bg-surface-raised px-3 py-2 shadow-lg">
        <span className="px-1 text-sm font-medium text-ink">{label}</span>

        <TagPopover target={target} ids={ids} onSubmit={post} busy={busy !== null} />

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

        <ExportPopover target={target} ids={ids} onSubmit={post} busy={busy !== null} />

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
