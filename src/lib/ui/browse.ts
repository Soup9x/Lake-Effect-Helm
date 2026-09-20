/**
 * Which rows a section modal shows.
 *
 * Extracted from the component because this is the part with decisions in it,
 * and because this repository has no DOM test setup: the parts of a filter
 * worth asserting are what it keeps and what it drops, not the markup around
 * the input.
 *
 * Every rule here is "narrow, never widen". A search term and two facets
 * combine with AND, an absent facet means "any", and a row that carries no
 * value for a facet being filtered on is dropped rather than kept — showing an
 * untyped row under "Type: device" would quietly make the filter a suggestion.
 */

export interface BrowsableFacets {
  [key: string]: string | undefined;
}

export interface Browsable {
  /** Everything matchable, already lowercased. */
  search: string;
  facets?: BrowsableFacets;
  /** Days until expiry, for the time-window control. Negative is overdue. */
  days?: number;
}

export interface BrowseQuery {
  /** Free text. Whitespace-separated terms, all of which must appear. */
  text?: string;
  /** Facet key to required value. A missing or empty value means "any". */
  facets?: BrowsableFacets;
  /** Upper bound in days, for expirations. Overdue items always qualify. */
  withinDays?: number | undefined;
}

export function matchesBrowse(row: Browsable, query: BrowseQuery): boolean {
  const terms = (query.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  // Every term, in any order and anywhere in the haystack. One contiguous match
  // would fail on "acme firewall" whenever the two words are not adjacent,
  // which is nearly always — the same reason helm.search() splits its patterns.
  if (!terms.every((term) => row.search.includes(term))) return false;

  for (const [key, want] of Object.entries(query.facets ?? {})) {
    if (!want) continue;
    if (row.facets?.[key] !== want) return false;
  }

  if (query.withinDays !== undefined) {
    if (row.days === undefined) return false;
    // Something already overdue is inside every window. "Next 30 days" that
    // hid the certificate which expired last week would be worse than useless.
    if (row.days > query.withinDays) return false;
  }

  return true;
}

export function filterBrowse<T extends Browsable>(rows: readonly T[], query: BrowseQuery): T[] {
  return rows.filter((row) => matchesBrowse(row, query));
}

/**
 * The distinct values present, for a facet's dropdown.
 *
 * Built from the rows rather than from an enum so the control only ever offers
 * something that will match. A "Type" list carrying every node_type in the
 * schema, on a client with three devices, is eleven choices that return nothing.
 */
export function facetValues(rows: readonly Browsable[], key: string): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row.facets?.[key];
    if (value) seen.add(value);
  }
  return [...seen].sort();
}
