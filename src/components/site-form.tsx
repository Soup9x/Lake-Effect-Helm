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
import { changedFields, hasChanges } from '@/lib/ui/form-diff';
import { BLANK_SITE, type SiteValues } from '@/lib/sites/values';

export type { SiteValues } from '@/lib/sites/values';
import { apiFetch } from '@/lib/ui/api';

/** Lines typed into the public-IP box, without the blanks between them. */
const cleanIps = (lines: string[]) => lines.map((l) => l.trim()).filter(Boolean);

export interface SiteFormProps {
  organizationId: string;
  /** Present means edit. Absent means create. */
  site?: { id: string; values: SiteValues };
  /*
   * CONTROLLED OPEN, OPTIONAL. Passing open/onOpenChange lets a parent drive this
   * form and suppresses its own trigger — which is how the redesigned view
   * header's single green "+ New" opens it. Left out, nothing changes for the
   * existing call sites on the organisation page.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SiteForm({
  organizationId,
  site,
  open: controlledOpen,
  // Renamed: this file already has a local onOpenChange that does the discard.
  onOpenChange: onOpenChangeProp,
}: SiteFormProps) {
  const router = useRouter();
  const editing = site !== undefined;
  const initial = site?.values ?? BLANK_SITE;

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next);
    onOpenChangeProp?.(next);
  };
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
      const cleaned: SiteValues = { ...values, publicIps: cleanIps(values.publicIps) };
      let payload: Record<string, unknown>;
      if (editing) {
        payload = changedFields(initial, cleaned);
        // Country is required on the row; an emptied box means "leave it".
        if (payload.country === null) delete payload.country;
        // The list clears to empty, never to null.
        if (payload.publicIps === null) payload.publicIps = [];
      } else {
        payload = { organizationId, isPrimary: cleaned.isPrimary, publicIps: cleaned.publicIps };
        for (const [key, value] of Object.entries(cleaned)) {
          if (typeof value === 'string' && value.trim()) payload[key] = value.trim();
        }
      }

      const result = await apiFetch(editing ? `/api/sites/${site.id}` : '/api/sites', {
        method: editing ? 'PATCH' : 'POST',
        json: payload,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      setError(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const dirty = editing
    ? hasChanges(initial, { ...values, publicIps: cleanIps(values.publicIps) })
    : values.name.trim().length > 0;

  return (
    <>
      {/* Suppressed entirely when a parent drives the dialog: both triggers,
          the edit pencil and the add button, belong to the uncontrolled mode. */}
      {controlledOpen === undefined &&
        (editing ? (
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
        ))}

      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={editing ? `Edit ${initial.name}` : 'Add a site'}
        icon={MapPin}
        size="lg"
      >
        <form onSubmit={submit} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="site-name">Name</Label>
              <Input id="site-name" value={values.name} onChange={(e) => set('name', e.target.value)}
                placeholder="Buffalo HQ" required autoFocus maxLength={200} />
            </div>
            <div>
              <Label htmlFor="site-code">Code</Label>
              <Input id="site-code" value={values.code} onChange={(e) => set('code', e.target.value)}
                placeholder="BUF-HQ" maxLength={40} />
              <FieldHint>The short label people say on a call.</FieldHint>
            </div>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-ink">Address</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="site-address">Street</Label>
                <Input id="site-address" value={values.addressLine1}
                  onChange={(e) => set('addressLine1', e.target.value)} maxLength={200} />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="site-address2">Suite, floor, building</Label>
                <Input id="site-address2" value={values.addressLine2}
                  onChange={(e) => set('addressLine2', e.target.value)} maxLength={200} />
              </div>
              <div>
                <Label htmlFor="site-city">City</Label>
                <Input id="site-city" value={values.city} onChange={(e) => set('city', e.target.value)} maxLength={120} />
              </div>
              <div>
                <Label htmlFor="site-region">State / region</Label>
                <Input id="site-region" value={values.region} onChange={(e) => set('region', e.target.value)}
                  placeholder="NY" maxLength={120} />
              </div>
              <div>
                <Label htmlFor="site-postal">Postal code</Label>
                <Input id="site-postal" value={values.postalCode}
                  onChange={(e) => set('postalCode', e.target.value)} maxLength={32} />
              </div>
              <div>
                <Label htmlFor="site-country">Country</Label>
                <Input id="site-country" value={values.country}
                  onChange={(e) => set('country', e.target.value.toUpperCase())}
                  placeholder="US" maxLength={2} minLength={2} />
                <FieldHint>Two-letter code.</FieldHint>
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="site-timezone">Time zone</Label>
                <Input id="site-timezone" value={values.timezone}
                  onChange={(e) => set('timezone', e.target.value)} placeholder="America/New_York" maxLength={64} />
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-ink">Phones and network</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="site-phone">Main phone</Label>
                <Input id="site-phone" value={values.mainPhone}
                  onChange={(e) => set('mainPhone', e.target.value)} maxLength={40} />
              </div>
              <div>
                <Label htmlFor="site-after-hours">After-hours phone</Label>
                <Input id="site-after-hours" value={values.afterHoursPhone}
                  onChange={(e) => set('afterHoursPhone', e.target.value)} maxLength={40} />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="site-public-ips">Public IP addresses</Label>
                <Textarea id="site-public-ips" rows={2} spellCheck={false} className="font-mono"
                  value={values.publicIps.join('\n')}
                  onChange={(e) => set('publicIps', e.target.value.split('\n'))}
                  placeholder={'203.0.113.10\n198.51.100.8/29'} />
                <FieldHint>
                  One per line: the static WAN addresses or blocks this location is reached on — what firewall
                  rules, VPN peers and remote support point at. Internal networks are documented as Networks.
                </FieldHint>
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-ink">Getting in</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="site-access">Access</Label>
                <Textarea id="site-access" rows={3} value={values.accessNotes} maxLength={4000}
                  onChange={(e) => set('accessNotes', e.target.value)}
                  placeholder="Hours, key holders, who to call at the front desk." />
              </div>
              <div>
                <Label htmlFor="site-security">Physical security</Label>
                <Textarea id="site-security" rows={3} value={values.physicalSecurity} maxLength={4000}
                  onChange={(e) => set('physicalSecurity', e.target.value)}
                  placeholder="Alarm procedure, badge system, where the rack is." />
              </div>
            </div>
          </fieldset>

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
