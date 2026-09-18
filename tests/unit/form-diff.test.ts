/**
 * What an edit sends.
 *
 * Every PATCH in this product leaves out what it is not given, so the shape of
 * the body IS the instruction: an absent key means "leave it", an explicit null
 * means "clear it". Getting that distinction wrong is silent — the save
 * succeeds and the field simply does not change — which is why it is tested
 * here rather than trusted to four form components.
 */
import { describe, expect, it } from 'vitest';
import { changedFields, hasChanges, normalise } from '../../src/lib/ui/form-diff';

describe('normalise', () => {
  it('treats an emptied box as a clear, not as a blank string', () => {
    // The API schemas accept null for "clear this"; '' would fail a min(1).
    expect(normalise('')).toBeNull();
    expect(normalise('   ')).toBeNull();
  });

  it('leaves booleans, numbers and arrays alone', () => {
    expect(normalise(false)).toBe(false);
    expect(normalise(0)).toBe(0);
    expect(normalise(['a'])).toEqual(['a']);
  });
});

describe('changedFields', () => {
  const initial = { name: 'DC01', city: 'Buffalo', isPrimary: false, tags: ['prod'] };

  it('sends nothing when nothing changed', () => {
    expect(changedFields(initial, { ...initial })).toEqual({});
    expect(hasChanges(initial, { ...initial })).toBe(false);
  });

  it('sends only the field that moved', () => {
    expect(changedFields(initial, { ...initial, city: 'Rochester' })).toEqual({
      city: 'Rochester',
    });
  });

  it('does not treat added whitespace as an edit', () => {
    // Otherwise a stray space makes the audit trail claim somebody renamed it.
    expect(changedFields(initial, { ...initial, name: ' DC01 ' })).toEqual({});
  });

  it('sends an explicit null when a field is emptied', () => {
    const changes = changedFields(initial, { ...initial, city: '' });
    expect(changes).toEqual({ city: null });
    // The key must be PRESENT and null — an absent key would mean "leave it",
    // and the city would quietly survive a deliberate deletion.
    expect('city' in changes).toBe(true);
  });

  it('sends false, which is a value and not an absence', () => {
    expect(changedFields({ ...initial, isPrimary: true }, initial)).toEqual({ isPrimary: false });
  });

  it('ignores a reordered tag list', () => {
    const before = { ...initial, tags: ['a', 'b'] };
    expect(changedFields(before, { ...before, tags: ['b', 'a'] })).toEqual({});
  });

  it('notices a tag added or removed', () => {
    const before = { ...initial, tags: ['a', 'b'] };
    expect(changedFields(before, { ...before, tags: ['a'] })).toEqual({ tags: ['a'] });
    expect(changedFields(before, { ...before, tags: ['a', 'b', 'c'] })).toEqual({
      tags: ['a', 'b', 'c'],
    });
  });
});
