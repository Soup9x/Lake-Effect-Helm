/**
 * Global search across all documentation.
 *
 * Thin by design. `helm.search()` does the ranking and, crucially, reads
 * `search_document` under the caller's RLS — so scoping is the policy's job and
 * cannot be forgotten here. A search endpoint that assembled its own WHERE
 * clause would be the single easiest place in the product to leak one client's
 * data to another.
 *
 * What the index contains, and does not: no secret material ever reaches
 * `search_document`. Credentials contribute label, username, type and URL;
 * flexible-asset fields are indexed only when explicitly allow-listed at schema
 * publish time. See db/sql/0120_search.sql.
 */
import type { HelmTx } from '../db/client';

/**
 * Cap on the query string.
 *
 * `websearch_to_tsquery` is safe against injection — it parses rather than
 * interpolates — but an enormous query still costs parse and rank time on a hot
 * path, and nobody types 500 characters into a search box on purpose.
 */
export const MAX_QUERY_LENGTH = 256;
export const MAX_PAGE_SIZE = 100;

export interface SearchRequest {
  query: string;
  organizationId?: string | undefined;
  entityTypes?: string[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface SearchHit {
  entityType: string;
  entityId: string;
  organizationId: string;
  title: string;
  subtitle: string | null;
  nodeId: string | null;
  rank: number;
  /** Matched fragment with the query terms marked, for the results list. */
  headline: string | null;
}

export interface SearchResponse {
  hits: SearchHit[];
  limit: number;
  offset: number;
  /** True when more results exist; we fetch one extra row to find out. */
  hasMore: boolean;
}

interface RawHit {
  entity_type: string;
  entity_id: string;
  organization_id: string;
  title: string;
  subtitle: string | null;
  node_id: string | null;
  rank: number;
  headline: string | null;
}

/**
 * Entity types a client may filter on.
 *
 * An allow-list rather than passing the parameter straight through: the column
 * is free text, and letting a caller filter on an arbitrary value turns the
 * filter into a probe for which entity types exist.
 */
export const SEARCHABLE_ENTITY_TYPES = ['asset_node', 'contact'] as const;
export type SearchableEntityType = (typeof SEARCHABLE_ENTITY_TYPES)[number];

export function isSearchableEntityType(value: string): value is SearchableEntityType {
  return (SEARCHABLE_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * Normalise a raw query.
 *
 * Trims, collapses whitespace and truncates. Deliberately does NOT strip
 * punctuation: `websearch_to_tsquery` gives quotes and `-` real meaning, and a
 * technician searching `"acme-fw-01"` or `firewall -decommissioned` should get
 * what they asked for.
 */
export function normaliseQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_LENGTH);
}

export async function search(tx: HelmTx, request: SearchRequest): Promise<SearchResponse> {
  const query = normaliseQuery(request.query);
  const limit = clamp(request.limit ?? 25, 1, MAX_PAGE_SIZE);
  const offset = Math.max(request.offset ?? 0, 0);

  if (query.length === 0) {
    return { hits: [], limit, offset, hasMore: false };
  }

  const types = request.entityTypes?.filter(isSearchableEntityType) ?? null;

  // Fetch one extra row to answer "is there a next page" without a second
  // count query, which on a ranked full-text search costs as much as the search.
  const rows = await tx<RawHit[]>`
    SELECT * FROM helm.search(
      ${query},
      ${request.organizationId ?? null}::uuid,
      ${types && types.length > 0 ? types : null}::text[],
      ${limit + 1},
      ${offset}
    )
  `;

  const hasMore = rows.length > limit;
  const hits = (hasMore ? rows.slice(0, limit) : rows).map(toHit);

  return { hits, limit, offset, hasMore };
}

function toHit(row: RawHit): SearchHit {
  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    organizationId: row.organization_id,
    title: row.title,
    subtitle: row.subtitle,
    nodeId: row.node_id,
    rank: row.rank,
    headline: row.headline,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
