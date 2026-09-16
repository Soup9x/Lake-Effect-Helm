'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, X } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';

/**
 * Renaming a client.
 *
 * The name changes; the slug deliberately does not. A slug appears in URLs and
 * in the integration mappings that correlate this client with an RMM or PSA, so
 * changing it as a side effect of a rebrand would break links and silently
 * orphan sync state. Changing it is possible through the API and is a separate,
 * deliberate act.
 */
export function RenameOrganization({
  organizationId,
  currentName,
}: {
  organizationId: string;
  currentName: string;
}) {
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
      const response = await fetch(`/api/organizations/${organizationId}`, {
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
        <Label htmlFor="rename-org" className="sr-only">
          Client name
        </Label>
        <Input
          id="rename-org"
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
          <FieldHint className="mt-1">The slug and every existing link stay as they are.</FieldHint>
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
