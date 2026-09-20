/**
 * The section-modal filter.
 *
 * The failures worth guarding are the quiet ones: a facet that keeps rows
 * carrying no value for it, a search that needs its words adjacent, and a
 * "next 30 days" window that hides what already expired.
 */
import { describe, expect, it } from 'vitest';
import { facetValues, filterBrowse, matchesBrowse, type Browsable } from '../../src/lib/ui/browse';

const row = (search: string, over: Partial<Browsable> = {}): Browsable => ({ search, ...over });

describe('matchesBrowse', () => {
  it('keeps everything when nothing is asked', () => {
    expect(matchesBrowse(row('acme firewall'), {})).toBe(true);
  });

  it('matches every term in any order', () => {
    // "acme firewall" must find "acme-fw-01 · firewall" — one contiguous match
    // would fail whenever the words are not adjacent, which is nearly always.
    expect(matchesBrowse(row('acme-fw-01 firewall device'), { text: 'firewall acme' })).toBe(true);
    expect(matchesBrowse(row('acme-fw-01 firewall device'), { text: 'acme switch' })).toBe(false);
  });

  it('is case-insensitive on the query side', () => {
    expect(matchesBrowse(row('acme-dc01'), { text: 'ACME' })).toBe(true);
  });

  it('ignores stray whitespace rather than matching nothing', () => {
    expect(matchesBrowse(row('acme'), { text: '   ' })).toBe(true);
    expect(matchesBrowse(row('acme firewall'), { text: '  acme   firewall ' })).toBe(true);
  });

  it('treats an empty facet as "any"', () => {
    expect(matchesBrowse(row('x', { facets: { type: 'device' } }), { facets: { type: '' } })).toBe(true);
    expect(matchesBrowse(row('x', { facets: { type: 'device' } }), { facets: {} })).toBe(true);
  });

  it('drops a row that carries no value for a facet being filtered on', () => {
    // Keeping it would make the filter a suggestion.
    expect(matchesBrowse(row('x'), { facets: { type: 'device' } })).toBe(false);
  });

  it('combines text and facets with AND', () => {
    const r = row('acme-dc01 server', { facets: { type: 'device', status: 'active' } });
    expect(matchesBrowse(r, { text: 'dc01', facets: { type: 'device' } })).toBe(true);
    expect(matchesBrowse(r, { text: 'dc01', facets: { type: 'network' } })).toBe(false);
    expect(matchesBrowse(r, { text: 'switch', facets: { type: 'device' } })).toBe(false);
  });

  it('applies the time window inclusively', () => {
    expect(matchesBrowse(row('cert', { days: 30 }), { withinDays: 30 })).toBe(true);
    expect(matchesBrowse(row('cert', { days: 31 }), { withinDays: 30 })).toBe(false);
  });

  it('keeps an OVERDUE item inside every window', () => {
    // "Next 30 days" that hid the certificate which expired last week would be
    // worse than useless.
    expect(matchesBrowse(row('cert', { days: -9 }), { withinDays: 30 })).toBe(true);
    expect(matchesBrowse(row('cert', { days: -9 }), { withinDays: 90 })).toBe(true);
  });

  it('drops a row with no expiry when a window is set', () => {
    expect(matchesBrowse(row('cert'), { withinDays: 30 })).toBe(false);
  });
});

describe('filterBrowse', () => {
  it('narrows and preserves order', () => {
    const rows = [row('alpha'), row('beta'), row('alphabet')];
    expect(filterBrowse(rows, { text: 'alpha' }).map((r) => r.search)).toEqual(['alpha', 'alphabet']);
  });

  it('returns everything for an empty query', () => {
    const rows = [row('a'), row('b')];
    expect(filterBrowse(rows, {})).toHaveLength(2);
  });
});

describe('facetValues', () => {
  it('lists only what is actually present, sorted', () => {
    // A Type list carrying every node_type in the schema, on a client with
    // three devices, is eleven choices that return nothing.
    const rows = [
      row('a', { facets: { type: 'network' } }),
      row('b', { facets: { type: 'device' } }),
      row('c', { facets: { type: 'device' } }),
      row('d'),
    ];
    expect(facetValues(rows, 'type')).toEqual(['device', 'network']);
  });

  it('is empty when no row carries the facet', () => {
    expect(facetValues([row('a'), row('b')], 'type')).toEqual([]);
  });
});
