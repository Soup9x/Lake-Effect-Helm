'use client';

/**
 * "Contact for": the configurations that name this person as their contact,
 * editable from the person's side.
 *
 * The link lives on the configuration (device.contact_id, 0800), so adding one
 * here PATCHes that configuration's contact to this person and removing one
 * clears it — the same write the configuration's own form makes, through the
 * same route and checks. A configuration has one contact, so choosing one that
 * already names somebody else says so before it replaces them.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Server, X } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Select } from './ui/field';
import { apiFetch } from '@/lib/ui/api';

export interface ContactForOption {
  id: string;
  name: string;
  /** Who it names now, when that is somebody else. */
  currentContact: string | null;
}

export function ContactForCard({
  contactId,
  linked,
  options,
  canEdit,
}: {
  contactId: string;
  linked: readonly { id: string; name: string }[];
  /** The client's configurations not already linked to this person. */
  options: readonly ContactForOption[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chosen = options.find((o) => o.id === choice) ?? null;

  async function setContact(deviceId: string, value: string | null) {
    setBusy(deviceId);
    setError(null);
    const result = await apiFetch(`/api/devices/${deviceId}`, { method: 'PATCH', json: { contactId: value } });
    setBusy(null);
    if (!result.ok) { setError(result.message); return; }
    setChoice('');
    router.refresh();
  }

  if (!canEdit && linked.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="size-4 text-ink-faint" aria-hidden /> Contact for
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {linked.length === 0 ? (
          <p className="text-sm text-ink-faint">No configuration names this person as its contact yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {linked.map((c) => (
              <li key={c.id} className="flex items-center gap-1 rounded-md border border-border py-1 pl-2.5 pr-1 text-sm">
                <Link href={`/assets/${c.id}`} className="text-ink hover:underline">{c.name}</Link>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => void setContact(c.id, null)}
                    disabled={busy !== null}
                    title={`Stop naming this person as the contact for ${c.name}`}
                    aria-label={`Remove ${c.name}`}
                    className="flex size-6 items-center justify-center rounded text-ink-faint hover:bg-surface-sunken hover:text-ink"
                  >
                    {busy === c.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <X className="size-3.5" aria-hidden />}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && options.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Configuration"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="max-w-sm"
            >
              <option value="">Add a configuration…</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}{o.currentContact ? ` (now ${o.currentContact})` : ''}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => chosen && void setContact(chosen.id, contactId)}
              disabled={!chosen || busy !== null}
            >
              {busy === choice && choice ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
              Add
            </Button>
            {chosen?.currentContact && (
              <span className="text-xs text-sev-warning">
                Replaces {chosen.currentContact} as its contact — a configuration has one.
              </span>
            )}
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}
