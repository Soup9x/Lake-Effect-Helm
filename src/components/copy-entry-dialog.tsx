'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CopyPlus, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';
import { Modal } from './ui/modal';
import { useStepUp } from './step-up-dialog';
import { withStepUp } from '@/lib/ui/step-up';
import { apiFetch } from '@/lib/ui/api';

/**
 * "Make a copy": a new entry from an existing one, under a name you choose,
 * opened straight away so the parts that differ can be changed. Opened from a
 * list row's actions; a whole selection is copied from the bulk bar instead.
 *
 * What comes across is the copy route's business. What this dialog has to say
 * is what a credential's copy means: its password is read to be copied, which
 * is a reveal like any other, so a step-up or a reason is asked for here when
 * the password requires one, and the audit log records it as a copy.
 */
export function CopyEntryDialog({
  nodeId,
  name,
  nodeType,
  open,
  onOpenChange,
}: {
  nodeId: string;
  name: string;
  nodeType: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const stepUp = useStepUp();
  const isDomain = nodeType === 'domain';
  const isCredential = nodeType === 'credential';
  // A domain is called by its domain name, which must be unique, so there is
  // no sensible default to offer; anything else gets "(copy)".
  const initial = isDomain ? '' : `${name} (copy)`;
  const [copyName, setCopyName] = useState(initial);
  const [reason, setReason] = useState('');
  // Shown once the password has said it wants one, as Reveal does.
  const [needsReason, setNeedsReason] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setCopyName(initial);
      setReason('');
      setNeedsReason(false);
      setError(null);
    }
  };

  // Read at call time, so the step-up retry sends what is in the boxes then.
  const attempt = () =>
    apiFetch<{ asset: { id: string } }>(`/api/assets/${nodeId}/copy`, {
      json: { name: copyName.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) },
    });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await withStepUp(attempt, stepUp.prompt);
      if (!result.ok) {
        if (result.code === 'reason_required') setNeedsReason(true);
        setError(result.message);
        return;
      }
      onOpenChange(false);
      router.push(`/assets/${result.value!.asset.id}`);
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {stepUp.dialog}
      <Modal
        open={open}
        onOpenChange={reset}
        title="Make a copy"
        icon={CopyPlus}
        description={`A new entry with the same details as ${name}, opened once it is made.`}
      >
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`copy-name-${nodeId}`}>{isDomain ? 'Domain name' : 'Name'}</Label>
            <Input
              id={`copy-name-${nodeId}`}
              value={copyName}
              onChange={(e) => setCopyName(e.target.value)}
              placeholder={isDomain ? 'e.g. northwind-shop.example' : undefined}
              maxLength={200}
              required
              // The dialog exists to be typed into the moment it opens.
              autoFocus
            />
            <FieldHint>
              {isCredential
                ? 'The username, URL, type, notes, tags and the password come across — the password as its own copy, recorded in the audit log. A one-time code does not.'
                : 'Details, notes, tags, location and status come across. Passwords, keys, relationships, attachments and history stay with the original.'}
            </FieldHint>
          </div>
          {needsReason && (
            <div className="space-y-1.5">
              <Label htmlFor={`copy-reason-${nodeId}`}>Reason (recorded in the audit log)</Label>
              <Input
                id={`copy-reason-${nodeId}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ticket number and what you are doing"
                maxLength={500}
              />
            </div>
          )}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => reset(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || copyName.trim() === '' || (needsReason && reason.trim().length < 10)}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Make the copy
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
