'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Loader2, Plus, X } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';

/**
 * Adding a client.
 *
 * The slug is derived from the name as you type, and stops deriving the moment
 * you edit it yourself. Slugs end up in URLs and in integration mappings, so
 * they outlive the name they came from — a client that rebrands keeps its slug
 * and every link to it keeps working. Deriving it silently on every later
 * keystroke would undo a deliberate choice.
 *
 * `router.refresh()` rather than local state: the list is a server component
 * reading through RLS, and re-fetching it is what proves the row is really
 * there and really visible to this actor. Optimistically appending a row would
 * show a client that a policy might not actually return.
 */
const STATUSES = [
  ['active', 'Active'],
  ['onboarding', 'Onboarding'],
  ['prospect', 'Prospect'],
  ['co_managed', 'Co-managed'],
  ['offboarding', 'Offboarding'],
  ['former', 'Former'],
] as const;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function NewOrganizationForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [status, setStatus] = useState('active');
  const [industry, setIndustry] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName('');
    setSlug('');
    setSlugTouched(false);
    setStatus('active');
    setIndustry('');
    setNotes('');
    setError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/organizations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          slug: slugTouched ? slug.trim() : slugify(name),
          status,
          ...(industry.trim() ? { industry: industry.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? `The client could not be created (${response.status}).`);
        return;
      }

      reset();
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
      <Button variant="primary" onClick={() => setOpen(true)} className="gap-2">
        <Plus />
        New client
      </Button>
    );
  }

  return (
    <Card className="mb-4">
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
              <Building2 className="size-4" />
              New client
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => {
                reset();
                setOpen(false);
              }}
              aria-label="Cancel"
            >
              <X />
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="org-name">Name</Label>
              <Input
                id="org-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Northwind Traders"
                required
                autoFocus
                maxLength={200}
              />
            </div>

            <div>
              <Label htmlFor="org-slug">Slug</Label>
              <Input
                id="org-slug"
                value={slugTouched ? slug : slugify(name)}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
                placeholder="northwind"
                pattern="[a-z0-9][a-z0-9\-]{1,62}"
                required
              />
              <FieldHint>
                Used in URLs and integration mappings. It outlives a rename, so keep it stable.
              </FieldHint>
            </div>

            <div>
              <Label htmlFor="org-status">Status</Label>
              <Select id="org-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUSES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="org-industry">Industry</Label>
              <Input
                id="org-industry"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="Optional"
                maxLength={120}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="org-notes">Notes</Label>
            <Textarea
              id="org-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="Optional. Anything the next person opening this would want to know."
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? 'Creating…' : 'Create client'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
