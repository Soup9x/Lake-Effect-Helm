/**
 * The coverage arithmetic, which is small and worth pinning because every
 * number on the page comes out of it.
 *
 * The interesting cases are all about what "covered" means at the edges: a
 * column with no records, a client with none at all, a grid with no columns,
 * and totals that have to add up to the column above them.
 */
import { describe, expect, it } from 'vitest';
import {
  columnClientCoverage, columnTotals, coverageOf, gapsOf, type GridColumn, type GridRow,
} from '../../src/lib/coverage/grid';

const columns: GridColumn[] = [
  { key: 'device', label: 'Configurations', source: 'node', categorySlug: 'configurations' },
  { key: 'domain', label: 'Domain Tracker', source: 'node', categorySlug: 'domains' },
  { key: 'credential', label: 'Passwords', source: 'node', categorySlug: 'passwords' },
  { key: 'flex:abc', label: 'Microsoft 365', source: 'flexible', categorySlug: undefined },
];

const row = (counts: Record<string, number>): GridRow => ({
  organizationId: 'o1', organizationName: 'Acme', isMspInternal: false, counts,
});

describe('coverage of one client', () => {
  it('counts a column as covered on a single record', () => {
    // One record is the whole claim: "something of this kind is documented".
    // Any threshold above one would be an invented standard.
    expect(coverageOf(row({ device: 1 }), columns)).toEqual({
      covered: 1, total: 4, percent: 25,
    });
  });

  it('is 100% when every column has something', () => {
    expect(coverageOf(row({ device: 9, domain: 1, credential: 4, 'flex:abc': 2 }), columns))
      .toEqual({ covered: 4, total: 4, percent: 100 });
  });

  it('is zero for a client with nothing, not NaN', () => {
    expect(coverageOf(row({}), columns)).toEqual({ covered: 0, total: 4, percent: 0 });
  });

  it('is zero rather than a division by nothing when there are no columns', () => {
    // A tenant with no flexible types and — hypothetically — no node
    // categories. 0/0 is the one input that could put NaN% on the page.
    expect(coverageOf(row({ device: 3 }), [])).toEqual({ covered: 0, total: 0, percent: 0 });
  });

  it('treats an explicit zero exactly like an absent key', () => {
    // The query omits a column a client has no rows for, but a count of 0 can
    // also arrive; they have to mean the same thing or the badge disagrees
    // with the cells beside it.
    expect(coverageOf(row({ device: 0, domain: 2 }), columns).covered).toBe(1);
    expect(coverageOf(row({ domain: 2 }), columns).covered).toBe(1);
  });

  it('rounds rather than truncating, so 1 of 3 is 33% and 2 of 3 is 67%', () => {
    const three = columns.slice(0, 3);
    expect(coverageOf(row({ device: 1 }), three).percent).toBe(33);
    expect(coverageOf(row({ device: 1, domain: 1 }), three).percent).toBe(67);
  });
});

describe('what is missing', () => {
  it('names the empty columns in grid order', () => {
    // The order matters: the tooltip reads left to right like the table.
    expect(gapsOf(row({ domain: 1 }), columns).map((c) => c.label))
      .toEqual(['Configurations', 'Passwords', 'Microsoft 365']);
  });

  it('is empty for a fully covered client', () => {
    expect(gapsOf(row({ device: 1, domain: 1, credential: 1, 'flex:abc': 1 }), columns))
      .toEqual([]);
  });

  it('agrees with the coverage count, always', () => {
    // Two functions reading the same row must not disagree about it, and the
    // page shows both ("3/4" beside "1 missing").
    for (const counts of [{}, { device: 1 }, { device: 1, 'flex:abc': 7 }, { domain: 0 }]) {
      const coverage = coverageOf(row(counts), columns);
      expect(gapsOf(row(counts), columns).length).toBe(coverage.total - coverage.covered);
    }
  });
});

describe('the column footers', () => {
  const rows = [
    row({ device: 3, domain: 1 }),
    { ...row({ device: 2, 'flex:abc': 5 }), organizationId: 'o2', organizationName: 'Globex' },
    { ...row({}), organizationId: 'o3', organizationName: 'Initech' },
  ];

  it('totals the records on screen', () => {
    expect(columnTotals(rows, columns)).toEqual({
      device: 5, domain: 1, credential: 0, 'flex:abc': 5,
    });
  });

  it('counts how many clients on screen have each kind', () => {
    // The more useful half: "1 of 3 clients has a domain documented" is a gap,
    // where "1 domain" is a volume.
    expect(columnClientCoverage(rows, columns)).toEqual({
      device: 2, domain: 1, credential: 0, 'flex:abc': 1,
    });
  });

  it('gives every column a number, including the empty ones', () => {
    // An absent key would render as blank rather than 0, and a blank footer
    // cell reads as "not measured" instead of "none".
    const totals = columnTotals(rows, columns);
    for (const column of columns) {
      expect(totals, `${column.key} is missing from the footer`).toHaveProperty(column.key);
    }
  });

  it('is zero across the board for an empty page', () => {
    expect(columnTotals([], columns)).toEqual({
      device: 0, domain: 0, credential: 0, 'flex:abc': 0,
    });
  });
});
