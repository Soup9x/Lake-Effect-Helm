'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, X } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';

/**
 * Renaming an asset.
 *
 * Only the name. The kind is not editable — it is half of the composite key the
 * subtype row hangs off, so changing it would orphan that row rather than
 * convert it, leaving a device's columns attached to something that is no
 * longer a device. Documenting the same thing as a different kind is a new
 * asset and a link between them.
 */
export function RenameAsset({ nodeId, currentName }: { nodeId: string; currentName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/assets/${nodeId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? `The rename failed (${response.status}).`);
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} className="gap-2">
        <Pencil />
        Rename
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="flex items-start gap-2">
      <div className="min-w-56">
        <Label htmlFor="rename-asset" className="sr-only">
          Asset name
        </Label>
        <Input
          id="rename-asset"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
          maxLength={200}
        />
        {error ? (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        ) : (
          <FieldHint className="mt-1">Links, credentials and history stay attached.</FieldHint>
        )}
      </div>
      <Button type="submit" size="sm" variant="primary" disabled={busy || !name.trim()}>
        {busy && <Loader2 className="animate-spin" />}
        Save
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={() => {
          setName(currentName);
          setError(null);
          setOpen(false);
        }}
        aria-label="Cancel"
      >
        <X />
      </Button>
    </form>
  );
}
