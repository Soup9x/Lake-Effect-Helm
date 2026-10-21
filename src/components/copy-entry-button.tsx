'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CopyPlus, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';
import { Modal } from './ui/modal';
import { apiFetch } from '@/lib/ui/api';

/**
 * "Make a copy": a new entry from this one, under a name you choose, opened
 * straight away so the parts that differ can be changed.
 *
 * What comes across is helm.copy_asset()'s business (1020). What this dialog
 * has to say is what does NOT: no password, one-time code or private key, and
 * no relationships, attachments or history.
 */
export function CopyEntryButton({
  nodeId,
  name,
  nodeType,
}: {
  nodeId: string;
  name: string;
  nodeType: string;
}) {
  const router = useRouter();
  const isDomain = nodeType === 'domain';
  const isCredential = nodeType === 'credential';
  // A domain is called by its domain name, which must be unique, so there is
  // no sensible default to offer; anything else gets "(copy)".
  const initial = isDomain ? '' : `${name} (copy)`;
  const [open, setOpen] = useState(false);
  const [copyName, setCopyName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setCopyName(initial);
      setError(null);
    }
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ asset: { id: string } }>(`/api/assets/${nodeId}/copy`, {
        json: { name: copyName.trim() },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      router.push(`/assets/${result.value!.asset.id}`);
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <CopyPlus aria-hidden />
        Make a copy
      </Button>
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
                ? 'The username, URL, type, notes and tags come across. The password and any one-time code do not: set them on the copy.'
                : 'Details, notes, tags, location and status come across. Passwords, keys, relationships, attachments and history stay with the original.'}
            </FieldHint>
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => reset(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || copyName.trim() === ''}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Make the copy
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
