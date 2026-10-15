/**
 * Which contacts matter, out of the flags that already exist.
 *
 * NO SIXTH BOOLEAN. `contact` carries `is_primary`, `is_technical`,
 * `is_billing`, `is_emergency` and `is_authorised`, and
 * `organization.primary_contact_id` is a sixth way to say "this one" — so an
 * `is_important` column would have had nothing to say about what distinguishes
 * it from `is_primary`, and two people would have filled them in differently
 * within a month. Decision 35.
 *
 * SO THE RANK IS THE DECISION, and it is here rather than in SQL for one
 * reason: it is presentation. Who you phone first when a client's domain
 * controller is down is a judgement about this widget, not a fact about the
 * row, and burying it in an ORDER BY would make it look like one. The SQL
 * selects; this decides.
 *
 * THE ORDER IS "WHO DO I CALL", NOT "WHO IS SENIOR". Emergency first, because
 * that flag exists for exactly the moment somebody is reading this card.
 * Authorised next: they are the person who can say yes to a password reset, and
 * an engineer stuck on a change needs them more than they need the billing
 * contact. Primary after that, then technical. Billing is not here at all — an
 * invoice query is not why anybody opens a client page at 2am — and `is_billing`
 * contacts still appear in the full contacts table below.
 */

export interface ContactFlags {
  isPrimary: boolean;
  isTechnical: boolean;
  isBilling: boolean;
  isEmergency: boolean;
  isAuthorised: boolean;
}

export interface RankedContact<T extends ContactFlags> {
  contact: T;
  /** Lower is more urgent. Only used for ordering. */
  rank: number;
  /** The one word this person is here for, for the badge. */
  reason: 'emergency' | 'authorised' | 'primary' | 'technical';
}

/** How many the card shows. A short list people read, not a second table. */
export const IMPORTANT_LIMIT = 4;

/**
 * Rank, order and cap. Returns an empty list when no flag is set anywhere,
 * which is a real answer: a client whose contacts nobody has marked up has no
 * important ones, and inventing an order over unflagged rows would be inventing
 * the information this card exists to carry.
 */
export function importantContacts<T extends ContactFlags>(
  contacts: readonly T[],
  limit = IMPORTANT_LIMIT,
): RankedContact<T>[] {
  const ranked: RankedContact<T>[] = [];

  for (const contact of contacts) {
    // First match wins, so somebody who is both emergency and primary appears
    // once, as the more urgent of the two.
    if (contact.isEmergency) ranked.push({ contact, rank: 0, reason: 'emergency' });
    else if (contact.isAuthorised) ranked.push({ contact, rank: 1, reason: 'authorised' });
    else if (contact.isPrimary) ranked.push({ contact, rank: 2, reason: 'primary' });
    else if (contact.isTechnical) ranked.push({ contact, rank: 3, reason: 'technical' });
  }

  // A stable sort, which matters: the SQL already ordered by name, so two
  // contacts of equal rank keep that order instead of an arbitrary one that
  // could change between page loads.
  return ranked.sort((a, b) => a.rank - b.rank).slice(0, limit);
}

export const REASON_LABEL: Record<RankedContact<ContactFlags>['reason'], string> = {
  emergency: 'Emergency',
  authorised: 'Can authorise',
  primary: 'Primary',
  technical: 'Technical',
};
