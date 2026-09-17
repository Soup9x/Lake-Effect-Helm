/**
 * Global search across all documentation.
 *
 * Thin by design. `helm.search()` does the matching and the ranking and,
 * crucially, reads `search_document` under the caller's RLS — so scoping is the
 * policy's job and cannot be forgotten here. A search endpoint that assembled
 * its own WHERE clause would be the single easiest place in the product to leak
 * one client's data to another.
 *
 * What the index contains, and does not: no secret material ever reaches
 * `search_document`. Credentials contribute label, username, type and URL;
 * flexible-asset fields are indexed only when explicitly allow-listed at schema
 * publish time. See db/sql/0120_search.sql and 0380_search_tags_and_archive.sql.
 */
import type { HelmTx } from '../db/client';

/**
 * Cap on the query string.
 *
 * Neither `websearch_to_tsquery` nor the LIKE patterns are injectable — one
 * parses rather than interpolates, the other is a bound parameter with its
 * wildcards escaped — but an enormous query still costs parse, trigram
 * extraction and rank time on a hot path, and nobody types 500 characters into
 * a search box on purpose.
 */
export const MAX_QUERY_LENGTH = 256;
export const MAX_PAGE_SIZE = 100;

/**
 * The headings results group under, in the order they are shown.
 *
 * Order is editorial rather than alphabetical: somebody searching mid-incident
 * is most often after a client or a credential, and a list that puts contacts
 * first makes them scroll for the thing they came for.
 */
export const RESULT_KINDS = [
  'client',
  'credential',
  'site',
  'document',
  'asset',
  'contact',
] as const;

export type ResultKind = (typeof RESULT_KINDS)[number];

export const KIND_LABELS: Record<ResultKind, { singular: string; plural: string }> = {
  client: { singular: 'Client', plural: 'Clients' },
  credential: { singular: 'Credential', plural: 'Credentials' },
  site: { singular: 'Site', plural: 'Sites' },
  document: { singular: 'Document', plural: 'Documents' },
  asset: { singular: 'Asset', plural: 'Assets' },
  contact: { singular: 'Contact', plural: 'Contacts' },
};

export function isResultKind(value: string): value is ResultKind {
  return (RESULT_KINDS as readonly string[]).includes(value);
}

export interface SearchRequest {
  query: string;
  organizationId?: string | undefined;
  kinds?: string[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface SearchHit {
  kind: ResultKind;
  entityType: string;
  entityId: string;
  organizationId: string;
  siteId: string | null;
  nodeId: string | null;
  title: string;
  subtitle: string | null;
  tags: string[];
  /**
   * Why this matched, 5 (the title, exactly) down to 1 (a word somewhere in the
   * prose). Returned rather than hidden because the interface uses it: an exact
   * hit is worth saying so, and a tier-1 hit is worth a headline explaining
   * where the match actually was.
   */
  matchTier: number;
  rank: number;
  /** Matched fragment with the query terms marked, for the results list. */
  headline: string | null;
  /** Where clicking the result goes. */
  href: string;
}

export interface SearchGroup {
  kind: ResultKind;
  label: string;
  hits: SearchHit[];
}

export interface SearchResponse {
  hits: SearchHit[];
  /** The same hits, bucketed and ordered for display. Empty groups are omitted. */
  groups: SearchGroup[];
  limit: number;
  offset: number;
  /** True when more results exist; we fetch one extra row to find out. */
  hasMore: boolean;
}

interface RawHit {
  kind: string;
  entity_type: string;
  entity_id: string;
  organization_id: string;
  site_id: string | null;
  node_id: string | null;
  title: string;
  subtitle: string | null;
  tags: string[];
  match_tier: number;
  rank: number;
  headline: string | null;
}

/**
 * Normalise a raw query.
 *
 * Trims, collapses whitespace and truncates. Deliberately does NOT strip
 * punctuation: `websearch_to_tsquery` gives quotes and `-` real meaning, and a
 * technician searching `"acme-fw-01"` should get what they asked for. Wildcard
 * characters are escaped in SQL rather than stripped here, so a query
 * containing `%` searches for a literal per cent sign.
 */
export function normaliseQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_LENGTH);
}

export async function search(tx: HelmTx, request: SearchRequest): Promise<SearchResponse> {
  const query = normaliseQuery(request.query);
  const limit = clamp(request.limit ?? 25, 1, MAX_PAGE_SIZE);
  const offset = Math.max(request.offset ?? 0, 0);

  if (query.length === 0) {
    return { hits: [], groups: [], limit, offset, hasMore: false };
  }

  const kinds = request.kinds?.filter(isResultKind) ?? null;

  // Fetch one extra row to answer "is there a next page" without a second
  // count query, which on a ranked search costs as much as the search.
  const rows = await tx<RawHit[]>`
    SELECT * FROM helm.search(
      ${query},
      ${request.organizationId ?? null}::uuid,
      ${kinds && kinds.length > 0 ? kinds : null}::text[],
      ${limit + 1},
      ${offset}
    )
  `;

  const hasMore = rows.length > limit;
  const hits = (hasMore ? rows.slice(0, limit) : rows).map(toHit);

  return { hits, groups: groupHits(hits), limit, offset, hasMore };
}

/**
 * Bucket hits under their headings, preserving the order the database returned.
 *
 * Grouping is done HERE and not with a SQL GROUP BY on purpose. The ranking has
 * to be global — one LIMIT over one ordered list — or a broad query would
 * return the twenty best clients and no credentials at all. So the database
 * ranks everything together, and the grouping is a presentation step over the
 * page it returned.
 */
export function groupHits(hits: SearchHit[]): SearchGroup[] {
  const buckets = new Map<ResultKind, SearchHit[]>();
  for (const hit of hits) {
    const bucket = buckets.get(hit.kind);
    if (bucket) bucket.push(hit);
    else buckets.set(hit.kind, [hit]);
  }

  return RESULT_KINDS.filter((kind) => buckets.has(kind)).map((kind) => ({
    kind,
    label: KIND_LABELS[kind].plural,
    hits: buckets.get(kind)!,
  }));
}

/**
 * Where a result goes when clicked.
 *
 * A site and an attachment have no page of their own, so both land on the
 * client that owns them — which is where somebody who searched for a site is
 * going anyway. Computed once here rather than in each component, so the two
 * places that render results cannot disagree about it.
 */
function hrefFor(row: RawHit): string {
  switch (row.kind) {
    case 'client':
      return `/organizations/${row.entity_id}`;
    case 'credential':
    case 'asset':
    case 'document':
      // An attachment hangs off the node it documents; a credential and an
      // asset ARE nodes. All three open the asset page when there is one.
      return row.node_id ? `/assets/${row.node_id}` : `/organizations/${row.organization_id}`;
    default:
      return `/organizations/${row.organization_id}`;
  }
}

function toHit(row: RawHit): SearchHit {
  return {
    // The CHECK constraint on search_document.kind means this cast is sound;
    // the fallback exists so a future kind added in SQL and not here degrades
    // to an ordinary result rather than crashing the page.
    kind: isResultKind(row.kind) ? row.kind : 'asset',
    entityType: row.entity_type,
    entityId: row.entity_id,
    organizationId: row.organization_id,
    siteId: row.site_id,
    nodeId: row.node_id,
    title: row.title,
    subtitle: row.subtitle,
    tags: row.tags ?? [],
    matchTier: row.match_tier,
    rank: row.rank,
    headline: row.headline,
    href: hrefFor(row),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
