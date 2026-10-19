/**
 * A contact's tags — the five flags 0010 gave every person — as words.
 *
 * One list, in one order, for the places that show them: the subtext under a
 * name in the Contacts list, the badges on the contact's page and the words the
 * list's filter matches. The edit form keeps its own copy with descriptions,
 * and uses these labels.
 */
export interface ContactFlags {
  is_primary: boolean;
  is_technical: boolean;
  is_billing: boolean;
  is_emergency: boolean;
  is_authorised: boolean;
}

export const CONTACT_TAGS: readonly (readonly [keyof ContactFlags, string])[] = [
  ['is_primary', 'Primary contact'],
  ['is_technical', 'Technical'],
  ['is_billing', 'Billing'],
  ['is_emergency', 'Emergency'],
  ['is_authorised', 'Authorised'],
];

/** The tags a contact carries, in the list's order. */
export function contactTags(row: ContactFlags): string[] {
  return CONTACT_TAGS.filter(([key]) => row[key]).map(([, label]) => label);
}
