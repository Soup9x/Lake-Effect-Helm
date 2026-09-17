'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, X } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';

/**
 * Renaming your own MSP.
 *
 * The name changes; the slug does not, and the hint says so. A slug is what
 * memberships and audit rows resolve through — it is the tenant's identity,
 * where the name is only what people read. A rebrand should not invalidate a
 * year of audit history.
 */
export function RenameTenant({
  currentName,
  slug,
}: {
  currentName: string;
  slug: string;
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
      const response = await fetch('/api/tenant', {
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
      <div className="flex items-center gap-3">
        <div>
          <div className="text-ink">{currentName}</div>
          <div className="text-xs text-ink-faint">{slug}</div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)} className="gap-2">
          <Pencil />
          Rename
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex items-start gap-2">
      <div className="min-w-64">
        <Label htmlFor="rename-tenant" className="sr-only">
          MSP name
        </Label>
        <Input
          id="rename-tenant"
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
          <FieldHint className="mt-1">
            The identifier <code className="font-mono">{slug}</code> stays as it is — memberships
            and audit history resolve through it.
          </FieldHint>
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
