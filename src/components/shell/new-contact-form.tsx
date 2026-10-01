'use client';

/**
 * Document a person at a client.
 *
 * NEW, because nothing in the product could create a contact. The table has been
 * in the schema since 0010 and the organisation page has always listed them, but
 * they arrived by SQL or not at all — which only became visible when the
 * redesigned Contacts grid put a "+ New" button over an empty list.
 *
 * Email is a plain bounded string rather than a validated address, matching the
 * endpoint: real directories contain "dana@acme.test (personal)" and "n/a", and
 * refusing the row for a malformed address loses the name and the phone number
 * with it.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, UserPlus } from 'lucide-react';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { FieldHint, Input, Label } from '../ui/field';

export function NewContactForm({
  organizationId,
  open,
  onOpenChange,
}: {
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [title, setTitle] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFirstName(''); setLastName(''); setTitle(''); setEmail(''); setPhone('');
    setIsPrimary(false); setError(null);
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          isPrimary,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError((body as { error?: { message?: string } } | null)?.error?.message ?? 'The contact could not be saved.');
        return;
      }
      onOpenChange(false);
      reset();
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { onOpenChange(next); if (!next) reset(); }}
      title="New contact"
      description="Who to call. Visible to anyone who can see this client."
      icon={UserPlus}
    >
      <form onSubmit={submit} className="space-y-4">
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

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="contact-email">Email</Label>
            <Input id="contact-email" value={email} maxLength={320} placeholder="Optional"
                   autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="contact-phone">Phone</Label>
            <Input id="contact-phone" value={phone} maxLength={40} placeholder="Optional"
                   onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={isPrimary} className="size-3.5 rounded border-border-strong"
                 onChange={(e) => setIsPrimary(e.target.checked)} />
          Primary contact for this client
        </label>
        <FieldHint>The person a technician calls first. One per client is the useful number.</FieldHint>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="cta" size="sm"
                  disabled={busy || !firstName.trim() || !lastName.trim()}>
            {busy && <Loader2 className="animate-spin" />}
            Save contact
          </Button>
        </div>
      </form>
    </Modal>
  );
}
