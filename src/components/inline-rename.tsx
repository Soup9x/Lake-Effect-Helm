'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, X } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';

/**
 * Rename something in place: a Rename button that becomes a one-field form.
 *
 * Used for a client and for the MSP itself. In both, the NAME changes and the
 * SLUG deliberately does not — a slug is what URLs, memberships, audit rows and
 * integration mappings resolve through, so a rebrand must not move it. Each
 * caller's `hint` says so in its own terms.
 *
 * One component where there were two (rename-organization, rename-tenant)
 * differing only in endpoint, label and hint text.
 */
export function InlineRename({
  currentName,
  endpoint,
  inputId,
  label,
  hint,
  slug,
}: {
  currentName: string;
  /** PATCHed with `{ name }`. */
  endpoint: string;
  inputId: string;
  /** For screen readers; the field has no visible label. */
  label: string;
  hint: ReactNode;
  /** Shown beside the current name when given. */
  slug?: string;
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
      const response = await fetch(endpoint, {
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
    const button = (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} className="gap-2">
        <Pencil />
        Rename
      </Button>
    );
    if (slug === undefined) return button;
    return (
      <div className="flex items-center gap-3">
        <div>
          <div className="text-ink">{currentName}</div>
          <div className="text-xs text-ink-faint">{slug}</div>
        </div>
        {button}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex items-start gap-2">
      <div className="min-w-56">
        <Label htmlFor={inputId} className="sr-only">
          {label}
        </Label>
        <Input
          id={inputId}
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
          <FieldHint className="mt-1">{hint}</FieldHint>
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
