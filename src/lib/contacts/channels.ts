/**
 * A contact's emails and phone numbers (0790).
 *
 * The lists are REPLACED, not patched. A form shows the whole list and saves
 * the whole list; diffing entries by id would let two people's edits
 * interleave into a list neither of them wrote. The old columns on `contact`
 * are rewritten by a trigger from whatever is saved here, so every reader of
 * contact.email and contact.phone sees the primary entries without change.
 */
import { z } from 'zod';
import type { HelmTx } from '../db/client';

/** 'alias' marks another address the same mailbox receives; the Microsoft 365 sync adds them (1060). */
export const EMAIL_LABELS = ['work', 'personal', 'alias', 'other'] as const;
export const PHONE_LABELS = ['work', 'mobile', 'home', 'fax', 'other'] as const;

export const emailEntrySchema = z.object({
  /*
   * Deliberately not z.email(): the create route says why — "dana@acme.test
   * (personal)" and "n/a" arrive in imports, and refusing the row loses the
   * person. What is stored can be corrected.
   */
  address: z.string().trim().min(1).max(320),
  label: z.enum(EMAIL_LABELS).default('work'),
  isPrimary: z.boolean().default(false),
});
export const phoneEntrySchema = z.object({
  number: z.string().trim().min(1).max(40),
  extension: z.string().trim().max(16).nullable().optional(),
  label: z.enum(PHONE_LABELS).default('work'),
  isPrimary: z.boolean().default(false),
});

export type EmailEntry = z.infer<typeof emailEntrySchema>;
export type PhoneEntry = z.infer<typeof phoneEntrySchema>;

export interface ContactChannels {
  emails: (EmailEntry & { id: string })[];
  phones: (PhoneEntry & { id: string; extension: string | null })[];
}

/** At most one primary; the first entry is primary when none is marked. */
export function normalisePrimary<T extends { isPrimary: boolean }>(entries: T[]): T[] {
  const first = entries.findIndex((e) => e.isPrimary);
  return entries.map((e, i) => ({ ...e, isPrimary: i === (first === -1 ? 0 : first) }));
}

export async function readChannels(tx: HelmTx, contactId: string): Promise<ContactChannels> {
  const [emails, phones] = await Promise.all([
    tx<{ id: string; address: string; label: EmailEntry['label']; is_primary: boolean }[]>`
      SELECT id, address::text AS address, label, is_primary FROM contact_email
      WHERE contact_id = ${contactId}::uuid ORDER BY is_primary DESC, position, created_at
    `,
    tx<{ id: string; number: string; extension: string | null; label: PhoneEntry['label']; is_primary: boolean }[]>`
      SELECT id, number, extension, label, is_primary FROM contact_phone
      WHERE contact_id = ${contactId}::uuid ORDER BY is_primary DESC, position, created_at
    `,
  ]);
  return {
    emails: emails.map((e) => ({ id: e.id, address: e.address, label: e.label, isPrimary: e.is_primary })),
    phones: phones.map((p) => ({
      id: p.id, number: p.number, extension: p.extension, label: p.label, isPrimary: p.is_primary,
    })),
  };
}

export async function replaceChannels(
  tx: HelmTx,
  tenantId: string,
  contactId: string,
  channels: { emails?: EmailEntry[] | undefined; phones?: PhoneEntry[] | undefined },
): Promise<void> {
  if (channels.emails !== undefined) {
    // Duplicates collapse (the unique key would refuse them) and the first
    // occurrence keeps its label.
    const seen = new Set<string>();
    const emails = normalisePrimary(
      channels.emails.filter((e) => {
        const key = e.address.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
    await tx`DELETE FROM contact_email WHERE contact_id = ${contactId}::uuid`;
    for (const [i, e] of emails.entries()) {
      await tx`
        INSERT INTO contact_email (tenant_id, contact_id, address, label, is_primary, position)
        VALUES (${tenantId}::uuid, ${contactId}::uuid, ${e.address}, ${e.label}, ${e.isPrimary}, ${i})
      `;
    }
  }
  if (channels.phones !== undefined) {
    const phones = normalisePrimary(channels.phones);
    await tx`DELETE FROM contact_phone WHERE contact_id = ${contactId}::uuid`;
    for (const [i, p] of phones.entries()) {
      await tx`
        INSERT INTO contact_phone (tenant_id, contact_id, number, extension, label, is_primary, position)
        VALUES (${tenantId}::uuid, ${contactId}::uuid, ${p.number}, ${p.extension?.trim() || null},
                ${p.label}, ${p.isPrimary}, ${i})
      `;
    }
  }
  // A contact with no entries at all keeps nothing in the old columns either.
  if (channels.emails !== undefined && channels.emails.length === 0) {
    await tx`UPDATE contact SET email = NULL WHERE id = ${contactId}::uuid`;
  }
  if (channels.phones !== undefined && channels.phones.length === 0) {
    await tx`UPDATE contact SET phone = NULL, mobile = NULL WHERE id = ${contactId}::uuid`;
  }
}
