/**
 * Who to call, and why there is no `is_important` column.
 *
 * The RANK is the thing being tested, and it is presentation rather than a
 * fact about the row — which is exactly why it lives in TypeScript and gets a
 * unit test instead of an ORDER BY nobody would read. Decision 35.
 */
import { describe, expect, it } from 'vitest';
import {
  importantContacts, IMPORTANT_LIMIT, REASON_LABEL,
} from '../../src/lib/contacts/important';

const none = {
  isPrimary: false, isTechnical: false, isBilling: false,
  isEmergency: false, isAuthorised: false,
};

const person = (name: string, flags: Partial<typeof none> = {}) => ({
  ...none, ...flags, name,
});

describe('who to call', () => {
  it('orders by urgency, not by seniority', () => {
    const ranked = importantContacts([
      person('technical', { isTechnical: true }),
      person('primary', { isPrimary: true }),
      person('emergency', { isEmergency: true }),
      person('authorised', { isAuthorised: true }),
    ]);
    expect(ranked.map((r) => r.contact.name))
      .toEqual(['emergency', 'authorised', 'primary', 'technical']);
  });

  it('counts somebody once, as the more urgent of their flags', () => {
    // Several flags on one person is the normal case — the client's IT manager
    // is usually primary AND technical AND authorised — so a list that showed
    // them three times would be useless.
    const ranked = importantContacts([
      person('everything', {
        isPrimary: true, isTechnical: true, isEmergency: true, isAuthorised: true,
      }),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.reason).toBe('emergency');
  });

  it('leaves billing out, because an invoice query is not why this card exists', () => {
    expect(importantContacts([person('accounts', { isBilling: true })])).toEqual([]);
  });

  it('returns nothing when no flag is set, rather than inventing an order', () => {
    // A client whose contacts nobody has marked up has no important ones.
    // Ranking unflagged rows would be inventing the information this card is
    // for, and the widget says which empty it is instead.
    const ranked = importantContacts([person('a'), person('b'), person('c')]);
    expect(ranked).toEqual([]);
  });

  it('keeps the order it was given for equal ranks, so the card does not shuffle', () => {
    // The SQL already ordered by name. A sort that was not stable would let two
    // equally-ranked contacts swap places between page loads, which looks like
    // the data changed.
    const ranked = importantContacts([
      person('Ann', { isTechnical: true }),
      person('Bob', { isTechnical: true }),
      person('Cat', { isTechnical: true }),
    ]);
    expect(ranked.map((r) => r.contact.name)).toEqual(['Ann', 'Bob', 'Cat']);
  });

  it('caps the list, because a short list is the point', () => {
    const many = Array.from({ length: 10 }, (_, i) => person(`p${i}`, { isPrimary: true }));
    expect(importantContacts(many)).toHaveLength(IMPORTANT_LIMIT);
    expect(importantContacts(many, 2)).toHaveLength(2);
  });

  it('has a label for every reason it can produce', () => {
    // Otherwise a badge renders `undefined` for a reason that was added to the
    // ranker and not to the copy.
    const produced = new Set(
      importantContacts([
        person('e', { isEmergency: true }),
        person('a', { isAuthorised: true }),
        person('p', { isPrimary: true }),
        person('t', { isTechnical: true }),
      ]).map((r) => r.reason),
    );
    expect(produced.size).toBe(4);
    for (const reason of produced) {
      expect(REASON_LABEL[reason], `${reason} has no label`).toBeTruthy();
    }
    // And no label is orphaned either, which would mean copy for a reason the
    // ranker can never return.
    expect(Object.keys(REASON_LABEL).sort()).toEqual([...produced].sort());
  });
});
