'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, UserPlus, X } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Select } from './ui/field';
import { ContactForm } from './shell/contact-form';
import { apiFetch } from '@/lib/ui/api';

interface Person { id: string; name: string; title: string | null }

/**
 * The people who work at a location, and assigning them to it.
 *
 * Assigning is contact.site_id, written through the contact's own PATCH, so
 * the contact page, this card and the database's guard (1020: a location of
 * the contact's own client) all describe the same fact. Nobody is deleted
 * from here: "Remove" takes the person off this location and leaves them on
 * the client.
 */
export function SitePeopleCard({
  siteId,
  organizationId,
  people,
  others,
  canWrite,
}: {
  siteId: string;
  organizationId: string;
  people: Person[];
  /** The client's other contacts, who can be assigned here. */
  others: Person[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function assign(contactId: string, here: boolean) {
    setBusy(contactId);
    setError(null);
    try {
      const result = await apiFetch(`/api/contacts/${contactId}`, {
        method: 'PATCH',
        json: { siteId: here ? siteId : null },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPicked('');
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>People here</CardTitle>
        {canWrite && (
          <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
            <UserPlus aria-hidden />
            New contact here
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {people.length === 0 ? (
          <p className="text-ink-faint">No contacts are recorded at this location.</p>
        ) : (
          <ul className="space-y-1.5">
            {people.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/contacts/${c.id}`} className="font-medium text-ink hover:underline">{c.name}</Link>
                {c.title && <span className="text-ink-muted">{c.title}</span>}
                {canWrite && (
                  <button
                    type="button"
                    className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ink-faint hover:bg-surface-sunken hover:text-ink"
                    onClick={() => void assign(c.id, false)}
                    disabled={busy !== null}
                    title={`Take ${c.name} off this location`}
                  >
                    {busy === c.id ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <X className="size-3" aria-hidden />}
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canWrite && others.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Select
              aria-label="Assign a contact to this location"
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              className="min-w-0 flex-1"
            >
              <option value="">Assign an existing contact…</option>
              {others.map((c) => (
                <option key={c.id} value={c.id}>{c.title ? `${c.name} — ${c.title}` : c.name}</option>
              ))}
            </Select>
            <Button
              variant="secondary"
              size="sm"
              disabled={picked === '' || busy !== null}
              onClick={() => void assign(picked, true)}
            >
              {busy === picked && picked !== '' && <Loader2 className="animate-spin" aria-hidden />}
              Assign
            </Button>
          </div>
        )}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </CardContent>

      {canWrite && (
        <ContactForm
          organizationId={organizationId}
          defaultSiteId={siteId}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
    </Card>
  );
}
