'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MapPin, Plus, X } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { FieldHint, Input, Label } from './ui/field';

/**
 * Adding a location.
 *
 * "Primary" is a claim about the client rather than about this row, so the API
 * demotes whichever site currently holds it in the same transaction. The hint
 * says so: a technician who ticks it expecting a second head office should find
 * out here rather than from a list that quietly changed.
 */
export function NewSiteForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setName('');
    setCode('');
    setCity('');
    setRegion('');
    setIsPrimary(false);
    setError(null);
    setOpen(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/sites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          name: name.trim(),
          isPrimary,
          ...(code.trim() ? { code: code.trim() } : {}),
          ...(city.trim() ? { city: city.trim() } : {}),
          ...(region.trim() ? { region: region.trim() } : {}),
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? `The site could not be added (${response.status}).`);
        return;
      }
      close();
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
        <Plus />
        Add a site
      </Button>
    );
  }

  return (
    <Card className="mb-4">
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
              <MapPin className="size-4" />
              Add a site
            </h2>
            <Button type="button" variant="ghost" size="icon" onClick={close} aria-label="Cancel">
              <X />
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="site-name">Name</Label>
              <Input
                id="site-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Buffalo HQ"
                required
                autoFocus
                maxLength={200}
              />
            </div>
            <div>
              <Label htmlFor="site-code">Code</Label>
              <Input
                id="site-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="BUF-HQ"
                maxLength={40}
              />
              <FieldHint>The short label people say on a call.</FieldHint>
            </div>
            <div>
              <Label htmlFor="site-city">City</Label>
              <Input
                id="site-city"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                maxLength={120}
              />
            </div>
            <div>
              <Label htmlFor="site-region">Region</Label>
              <Input
                id="site-region"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="NY"
                maxLength={120}
              />
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={isPrimary}
                onChange={(e) => setIsPrimary(e.target.checked)}
                className="size-4 rounded border-border-strong"
              />
              Primary site
            </label>
            {isPrimary && (
              <FieldHint className="mt-1">
                Whichever site is primary today will stop being primary.
              </FieldHint>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? 'Adding…' : 'Add site'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
