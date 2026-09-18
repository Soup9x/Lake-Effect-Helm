'use client';

/**
 * Adding and editing a location — one component, because it is one form.
 *
 * Create and edit differ by a verb and an endpoint here; every field is the
 * same. Splitting them would mean two places to add the next column to, and the
 * usual result of that is an edit form quietly missing a field the add form
 * grew six months earlier.
 *
 * `PATCH /api/sites/[siteId]` has existed since sites were built and had no
 * caller: a site could be created and then never corrected, which is the bug
 * this closes.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MapPin, Pencil, Plus } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label, Textarea } from './ui/field';
import { Modal } from './ui/modal';
import { changedFields, hasChanges, type FieldValue } from '@/lib/ui/form-diff';

export interface SiteValues extends Record<string, FieldValue> {
  name: string;
  code: string;
  city: string;
  region: string;
  addressLine1: string;
  mainPhone: string;
  isPrimary: boolean;
  notes: string;
}

const BLANK: SiteValues = {
  name: '',
  code: '',
  city: '',
  region: '',
  addressLine1: '',
  mainPhone: '',
  isPrimary: false,
  notes: '',
};

export interface SiteFormProps {
  organizationId: string;
  /** Present means edit. Absent means create. */
  site?: { id: string; values: SiteValues };
}

export function SiteForm({ organizationId, site }: SiteFormProps) {
  const router = useRouter();
  const editing = site !== undefined;
  const initial = site?.values ?? BLANK;

  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<SiteValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof SiteValues>(key: K, value: SiteValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // Every close — the X, the backdrop, Escape, Cancel — discards. The
      // form reopens from `initial`, so an abandoned edit leaves nothing
      // behind and an abandoned create starts blank again.
      setValues(initial);
      setError(null);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // On edit, only what changed. The PATCH leaves out what it is not given,
      // and sending the whole form would make every save read in the audit
      // trail as though the person had rewritten every field.
      const payload = editing
        ? changedFields(initial, values)
        : {
            organizationId,
            name: values.name.trim(),
            isPrimary: values.isPrimary,
            ...(values.code.trim() ? { code: values.code.trim() } : {}),
            ...(values.city.trim() ? { city: values.city.trim() } : {}),
            ...(values.region.trim() ? { region: values.region.trim() } : {}),
            ...(values.addressLine1.trim() ? { addressLine1: values.addressLine1.trim() } : {}),
            ...(values.mainPhone.trim() ? { mainPhone: values.mainPhone.trim() } : {}),
            ...(values.notes.trim() ? { notes: values.notes.trim() } : {}),
          };

      const response = await fetch(editing ? `/api/sites/${site.id}` : '/api/sites', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(
          body?.error?.message ??
            `The site could not be ${editing ? 'saved' : 'added'} (${response.status}).`,
        );
        return;
      }
      setOpen(false);
      setError(null);
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const dirty = editing ? hasChanges(initial, values) : values.name.trim().length > 0;

  return (
    <>
      {editing ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setOpen(true)}
          aria-label={`Edit ${initial.name}`}
          title="Edit this site"
        >
          <Pencil />
        </Button>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)} className="gap-2">
          <Plus />
          Add a site
        </Button>
      )}

      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={editing ? `Edit ${initial.name}` : 'Add a site'}
        icon={MapPin}
      >
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="site-name">Name</Label>
              <Input
                id="site-name"
                value={values.name}
                onChange={(e) => set('name', e.target.value)}
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
                value={values.code}
                onChange={(e) => set('code', e.target.value)}
                placeholder="BUF-HQ"
                maxLength={40}
              />
              <FieldHint>The short label people say on a call.</FieldHint>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="site-address">Address</Label>
              <Input
                id="site-address"
                value={values.addressLine1}
                onChange={(e) => set('addressLine1', e.target.value)}
                maxLength={200}
              />
            </div>
            <div>
              <Label htmlFor="site-city">City</Label>
              <Input
                id="site-city"
                value={values.city}
                onChange={(e) => set('city', e.target.value)}
                maxLength={120}
              />
            </div>
            <div>
              <Label htmlFor="site-region">Region</Label>
              <Input
                id="site-region"
                value={values.region}
                onChange={(e) => set('region', e.target.value)}
                placeholder="NY"
                maxLength={120}
              />
            </div>
            <div>
              <Label htmlFor="site-phone">Main phone</Label>
              <Input
                id="site-phone"
                value={values.mainPhone}
                onChange={(e) => set('mainPhone', e.target.value)}
                maxLength={40}
              />
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={values.isPrimary}
                onChange={(e) => set('isPrimary', e.target.checked)}
                className="size-4 rounded border-border-strong"
              />
              Primary site
            </label>
            {values.isPrimary && !initial.isPrimary && (
              <FieldHint className="mt-1">
                Whichever site is primary today will stop being primary.
              </FieldHint>
            )}
          </div>

          <div>
            <Label htmlFor="site-notes">Notes</Label>
            <Textarea
              id="site-notes"
              value={values.notes}
              onChange={(e) => set('notes', e.target.value)}
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
            <Button type="submit" variant="primary" disabled={busy || !dirty}>
              {busy && <Loader2 className="animate-spin" />}
              {editing ? 'Save changes' : busy ? 'Adding…' : 'Add site'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
