'use client';

/**
 * A contact, new or corrected, with every email and number they have.
 *
 * ONE FORM FOR BOTH. Creating and editing a person ask for the same things;
 * the difference is whether there is an id to PATCH, and whether the fields
 * start empty or from GET /api/contacts/:id, which the edit mode fetches when
 * it opens rather than carrying the whole contact in every grid row.
 *
 * LISTS, NOT A FIELD EACH. A person has a work address and a personal one, a
 * desk line with an extension and a mobile; 0790 stores as many as there are,
 * each labelled, one of each kind marked primary. The whole list is saved
 * each time; the first entry is primary unless another is marked.
 *
 * The address is not validated as an address, for the reason the route gives:
 * what somebody typed is better kept and corrected than refused with the
 * name and the phone number.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Trash2, UserPlus, UserPen } from 'lucide-react';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { FieldHint, Input, Label, Select } from '../ui/field';
import { apiFetch } from '@/lib/ui/api';
import { EMAIL_LABELS, PHONE_LABELS } from '@/lib/contacts/channels';

interface EmailDraft { address: string; label: string; isPrimary: boolean }
interface PhoneDraft { number: string; extension: string; label: string; isPrimary: boolean }

interface ContactView {
  firstName: string; lastName: string; title: string | null;
  isPrimary: boolean; isTechnical: boolean; isBilling: boolean; isEmergency: boolean; isAuthorised: boolean;
  emails: { address: string; label: string; isPrimary: boolean }[];
  phones: { number: string; extension: string | null; label: string; isPrimary: boolean }[];
}

const FLAGS = [
  ['isPrimary', 'Primary contact', 'The person a technician calls first.'],
  ['isTechnical', 'Technical', 'Understands the systems; the one to talk to about a change.'],
  ['isBilling', 'Billing', 'Invoices and renewals go here.'],
  ['isEmergency', 'Emergency', 'May be called out of hours.'],
  ['isAuthorised', 'Authorised', 'May approve changes and password resets.'],
] as const;
type FlagKey = (typeof FLAGS)[number][0];

export function ContactForm({
  organizationId,
  contactId,
  open,
  onOpenChange,
}: {
  organizationId: string;
  /** Set to edit that contact; absent to create one. */
  contactId?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const editing = contactId !== undefined;
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [title, setTitle] = useState('');
  const [flags, setFlags] = useState<Record<FlagKey, boolean>>({
    isPrimary: false, isTechnical: false, isBilling: false, isEmergency: false, isAuthorised: false,
  });
  const [emails, setEmails] = useState<EmailDraft[]>([]);
  const [phones, setPhones] = useState<PhoneDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFirstName(''); setLastName(''); setTitle('');
    setFlags({ isPrimary: false, isTechnical: false, isBilling: false, isEmergency: false, isAuthorised: false });
    setEmails([]); setPhones([]); setError(null);
  };

  // Edit mode: the current contact, fetched when the dialog opens.
  useEffect(() => {
    if (!open || !editing) return;
    let cancelled = false;
    setLoading(true);
    void apiFetch<{ contact: ContactView }>(`/api/contacts/${contactId}`, { method: 'GET' }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) { setError(result.message); return; }
      const c = result.value!.contact;
      setFirstName(c.firstName); setLastName(c.lastName); setTitle(c.title ?? '');
      setFlags({
        isPrimary: c.isPrimary, isTechnical: c.isTechnical, isBilling: c.isBilling,
        isEmergency: c.isEmergency, isAuthorised: c.isAuthorised,
      });
      setEmails(c.emails.map((e) => ({ address: e.address, label: e.label, isPrimary: e.isPrimary })));
      setPhones(c.phones.map((p) => ({ number: p.number, extension: p.extension ?? '', label: p.label, isPrimary: p.isPrimary })));
    });
    return () => { cancelled = true; };
  }, [open, editing, contactId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        title: title.trim() === '' ? null : title.trim(),
        ...flags,
        emails: emails.filter((e) => e.address.trim() !== '').map((e) => ({ ...e, address: e.address.trim() })),
        phones: phones.filter((p) => p.number.trim() !== '').map((p) => ({
          number: p.number.trim(), extension: p.extension.trim() === '' ? null : p.extension.trim(),
          label: p.label, isPrimary: p.isPrimary,
        })),
      };
      const result = editing
        ? await apiFetch(`/api/contacts/${contactId}`, { method: 'PATCH', json: payload })
        : await apiFetch('/api/contacts', { json: { organizationId, ...payload, title: payload.title ?? undefined } });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onOpenChange(false);
      reset();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const markPrimary = <T extends { isPrimary: boolean }>(list: T[], index: number) =>
    list.map((e, i) => ({ ...e, isPrimary: i === index }));

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { onOpenChange(next); if (!next) reset(); }}
      title={editing ? 'Edit contact' : 'New contact'}
      description="Who to call. Visible to anyone who can see this client."
      icon={editing ? UserPen : UserPlus}
      size="lg"
    >
      <form onSubmit={submit} className="space-y-4">
        {loading && <p className="text-sm text-ink-faint">Loading…</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="contact-first">First name</Label>
            <Input id="contact-first" value={firstName} maxLength={120}
                   onChange={(e) => setFirstName(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="contact-last">Last name</Label>
            <Input id="contact-last" value={lastName} maxLength={120}
                   onChange={(e) => setLastName(e.target.value)} required />
          </div>
        </div>

        <div>
          <Label htmlFor="contact-title">Job title</Label>
          <Input id="contact-title" value={title} maxLength={160} placeholder="Optional"
                 onChange={(e) => setTitle(e.target.value)} />
        </div>

        {/* ------------------------------------------------------------ emails */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">Email addresses</legend>
          {emails.map((entry, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`Email ${i + 1}`}
                value={entry.address}
                maxLength={320}
                autoComplete="off"
                placeholder="name@example.com"
                className="min-w-48 flex-1"
                onChange={(e) => setEmails((l) => l.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)))}
              />
              <Select
                aria-label={`Email ${i + 1} label`}
                value={entry.label}
                className="w-28"
                onChange={(e) => setEmails((l) => l.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              >
                {EMAIL_LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </Select>
              <label className="flex items-center gap-1 text-xs text-ink-muted">
                <input type="radio" name="primary-email" checked={entry.isPrimary}
                       onChange={() => setEmails((l) => markPrimary(l, i))} />
                Primary
              </label>
              <button type="button" className="rounded p-1 text-ink-faint hover:text-danger"
                      onClick={() => setEmails((l) => l.filter((_, j) => j !== i))}>
                <Trash2 className="size-3.5" aria-hidden />
                <span className="sr-only">Remove email {i + 1}</span>
              </button>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" disabled={emails.length >= 20}
                  onClick={() => setEmails((l) => [...l, { address: '', label: l.length === 0 ? 'work' : 'personal', isPrimary: l.length === 0 }])}>
            <Plus className="size-3.5" aria-hidden /> Add an email
          </Button>
        </fieldset>

        {/* ------------------------------------------------------------ phones */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">Phone numbers</legend>
          {phones.map((entry, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`Phone ${i + 1}`}
                value={entry.number}
                maxLength={40}
                placeholder="+1 555 0100"
                className="min-w-40 flex-1"
                onChange={(e) => setPhones((l) => l.map((x, j) => (j === i ? { ...x, number: e.target.value } : x)))}
              />
              <Input
                aria-label={`Phone ${i + 1} extension`}
                value={entry.extension}
                maxLength={16}
                placeholder="ext"
                className="w-20"
                onChange={(e) => setPhones((l) => l.map((x, j) => (j === i ? { ...x, extension: e.target.value } : x)))}
              />
              <Select
                aria-label={`Phone ${i + 1} label`}
                value={entry.label}
                className="w-28"
                onChange={(e) => setPhones((l) => l.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              >
                {PHONE_LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </Select>
              <label className="flex items-center gap-1 text-xs text-ink-muted">
                <input type="radio" name="primary-phone" checked={entry.isPrimary}
                       onChange={() => setPhones((l) => markPrimary(l, i))} />
                Primary
              </label>
              <button type="button" className="rounded p-1 text-ink-faint hover:text-danger"
                      onClick={() => setPhones((l) => l.filter((_, j) => j !== i))}>
                <Trash2 className="size-3.5" aria-hidden />
                <span className="sr-only">Remove phone {i + 1}</span>
              </button>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" disabled={phones.length >= 20}
                  onClick={() => setPhones((l) => [...l, { number: '', extension: '', label: l.length === 0 ? 'work' : 'mobile', isPrimary: l.length === 0 }])}>
            <Plus className="size-3.5" aria-hidden /> Add a number
          </Button>
        </fieldset>

        {/* ------------------------------------------------------------- flags */}
        <div className="grid gap-1 sm:grid-cols-2">
          {FLAGS.map(([key, label, hint]) => (
            <label key={key} className="flex items-start gap-2 text-sm text-ink" title={hint}>
              <input type="checkbox" checked={flags[key]} className="mt-1 size-3.5 rounded border-border-strong"
                     onChange={(e) => setFlags((f) => ({ ...f, [key]: e.target.checked }))} />
              <span>{label}<span className="block text-xs text-ink-faint">{hint}</span></span>
            </label>
          ))}
        </div>
        <FieldHint>The primary address and number are what the lists and exports show.</FieldHint>

        {error && <p role="alert" className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="cta" size="sm"
                  disabled={busy || loading || !firstName.trim() || !lastName.trim()}>
            {busy && <Loader2 className="animate-spin" />}
            {editing ? 'Save changes' : 'Save contact'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
