'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';

/**
 * Your display name.
 *
 * The one field on this page that is genuinely yours to change. It is what
 * appears against your name in an audit row, so it is worth being able to fix
 * when a directory import has produced "SMITH, J (Contractor)".
 */
export function ProfileForm({ currentName }: { currentName: string | null }) {
  const router = useRouter();
  const [name, setName] = useState(currentName ?? '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const response = await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        // An empty box clears the name rather than storing "". The database
        // stores NULL, and the interface falls back to the email address.
        body: JSON.stringify({ name: name.trim() === '' ? null : name.trim() }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? `Could not save (${response.status}).`);
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-sm space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="display-name">Display name</Label>
        <Input
          id="display-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDone(false);
          }}
          maxLength={120}
          placeholder="How your name should appear"
        />
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : (
          <FieldHint>Shown beside your actions in the audit log.</FieldHint>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy && <Loader2 aria-hidden className="animate-spin" />}
          Save
        </Button>
        {done && (
          <span className="flex items-center gap-1.5 text-xs text-ok">
            <CheckCircle2 aria-hidden className="size-3.5" />
            Saved.
          </span>
        )}
      </div>
    </form>
  );
}
