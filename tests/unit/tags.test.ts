import { describe, expect, it } from 'vitest';
import { parseTagDraft } from '../../src/lib/ui/tags';

describe('parseTagDraft', () => {
  it('splits on commas and trims', () => {
    expect(parseTagDraft('vip, managed ,  backup')).toEqual(['vip', 'managed', 'backup']);
  });

  it('drops empties rather than sending a blank tag', () => {
    // A trailing comma is what somebody types on the way to the next one.
    expect(parseTagDraft('vip,,  , managed,')).toEqual(['vip', 'managed']);
  });

  it('drops tags already on the record', () => {
    // Harmless server-side — the update is a set union — but the optimistic
    // list would show the chip twice until the refresh corrected it.
    expect(parseTagDraft('vip, managed', ['vip'])).toEqual(['managed']);
  });

  it('de-duplicates within one entry', () => {
    expect(parseTagDraft('vip, vip, VIP')).toEqual(['vip', 'VIP']);
  });

  it('returns nothing for an entry that adds nothing', () => {
    expect(parseTagDraft('   ')).toEqual([]);
    expect(parseTagDraft('vip', ['vip'])).toEqual([]);
  });
});
