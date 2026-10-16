'use client';

/**
 * What this organisation is to you: client, prospect, vendor, competitor,
 * internal, other.
 *
 * The column has existed since 0600, the list filters and badges on it, and
 * the API has always accepted it — but no form ever set it, so every
 * organisation was created as Client and stayed one. This is the control.
 *
 * SAVES ON CHANGE, with no Save button. One field, one PATCH, and the page
 * refreshes from the server so the badge in the header shows what the row
 * holds, not what the select hoped. A refused save puts the select back.
 *
 * Read-only for anyone without organization:write: the badge alone.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Badge } from './ui/badge';
import { Select } from './ui/field';
import { RELATIONSHIP_KEYS, RELATIONSHIPS, relationshipOf } from '@/lib/ui/organization-relationship';
import { apiFetch } from '@/lib/ui/api';

export function RelationshipPicker({
  organizationId,
  relationship,
  canWrite,
}: {
  organizationId: string;
  relationship: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const current = relationshipOf(relationship);
  const [value, setValue] = useState(current.key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canWrite) return <Badge tone={current.tone}>{current.label}</Badge>;

  async function change(next: string) {
    const previous = value;
    setValue(next as typeof value);
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch(`/api/organizations/${organizationId}`, {
        method: 'PATCH',
        json: { relationship: next },
      });
      if (!result.ok) {
        setValue(previous);
        setError(result.message);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="org-relationship" className="text-xs text-ink-faint">Type</label>
      <Select
        id="org-relationship"
        value={value}
        onChange={(e) => void change(e.target.value)}
        disabled={busy}
        className="h-8 w-auto py-0 text-sm"
        title={RELATIONSHIPS[value].hint}
      >
        {RELATIONSHIP_KEYS.map((key) => (
          <option key={key} value={key}>{RELATIONSHIPS[key].label}</option>
        ))}
      </Select>
      {busy && <Loader2 className="size-3.5 animate-spin text-ink-faint" aria-hidden />}
      {error && (
        <p role="alert" className="text-xs text-danger">{error}</p>
      )}
    </div>
  );
}
