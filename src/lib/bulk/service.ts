/**
 * Bulk operations over a selection.
 *
 * ONE RULE, AND EVERYTHING HERE FOLLOWS FROM IT: a bulk action may never do
 * something the same person could not have done one item at a time.
 *
 * That is not enforced by checking permissions in this file. It is enforced by
 * the fact that every statement below runs under the caller's RLS, so an
 * `UPDATE ... WHERE id = ANY($1)` simply does not match rows the policy refuses
 * — the row is invisible to the UPDATE in the same way it is invisible to a
 * SELECT. An application-side permission check would be a second, weaker copy
 * of a rule the database already enforces, and the two would eventually
 * disagree.
 *
 * What this file DOES add is the part RLS cannot: noticing. A policy that
 * silently matches eight of ten rows is a correct policy and a terrible
 * experience — the person ticked ten boxes, saw "archived", and two clients are
 * still live. So every operation compares what it was asked to touch against
 * what it actually touched, and a shortfall aborts the whole thing.
 *
 * ALL OR NOTHING, and that is a deliberate choice between two defensible ones.
 * Partial success with a report is the other. It loses because the report is
 * read once and the selection is gone: somebody who archives 40 clients and is
 * told 3 were skipped has no way back to which 3 without doing it again. A
 * refusal leaves the selection intact and the state unchanged, and the person
 * can narrow it and retry. The route runs inside the transaction `tenantRoute`
 * opened, so throwing rolls back every statement below.
 */
import type { HelmTx } from '../db/client';
import { ApiError } from '../api/errors';

export const MAX_SELECTION = 500;

export type BulkTarget = 'client' | 'node';

export interface BulkOutcome {
  /** Ids the caller asked for. */
  requested: string[];
  /** Ids actually affected. Equal to `requested` or the operation threw. */
  affected: string[];
}

/**
 * Compare what was asked against what was reached, and refuse the difference.
 *
 * The message does NOT distinguish "you may not touch this" from "there is no
 * such item", because the answer must not become a probe: a technician scoped
 * to two clients could otherwise paste ids and learn which ones exist in the
 * tenant. Both collapse to the same sentence, which is also the true one from
 * the caller's point of view — those items were not theirs to change.
 */
function requireAll(requested: string[], affected: string[], verb: string): BulkOutcome {
  if (affected.length === requested.length) return { requested, affected };

  const reached = new Set(affected);
  const refused = requested.filter((id) => !reached.has(id));

  throw ApiError.forbidden(
    `${refused.length} of ${requested.length} selected items are not yours to ${verb}. ` +
      'Nothing was changed.',
    { refused },
  );
}

/**
 * Run a selection UPDATE, converting the two ways RLS can refuse into one answer.
 *
 * A policy refuses in two shapes, and the caller must not have to know which:
 *
 *   - The row is INVISIBLE (the USING clause excludes it): the UPDATE matches
 *     nothing, quietly, and the shortfall check above is what notices.
 *   - The row is visible but the WRITE is refused (WITH CHECK fails, e.g. an
 *     actor who may read a client but holds no organization:write): Postgres
 *     raises 42501 and the raw message is "new row violates row-level security
 *     policy for table organization", which is not a sentence to put in front
 *     of a technician.
 *
 * Both mean the same thing — those items were not yours to change — so both
 * produce the same refusal. Neither reveals which of the two it was, because
 * the difference is exactly the information that would turn a bulk endpoint
 * into a probe for what exists elsewhere in the tenant.
 */
async function runSelection(
  run: () => Promise<{ id: string }[]>,
  requested: string[],
  verb: string,
): Promise<BulkOutcome> {
  let rows: { id: string }[];
  try {
    rows = await run();
  } catch (error) {
    if ((error as { code?: string }).code === '42501') {
      throw ApiError.forbidden(
        `Those items are not yours to ${verb}. Nothing was changed.`,
      );
    }
    throw error;
  }
  return requireAll(requested, rows.map((r) => r.id), verb);
}

/** Reject a selection before it reaches the database. */
export function normaliseSelection(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw ApiError.invalid('select at least one item');
  if (unique.length > MAX_SELECTION) {
    throw ApiError.invalid(`select at most ${MAX_SELECTION} items at a time`);
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

/**
 * Tags are free text, lowercased and de-duplicated.
 *
 * Free text rather than a tag table, because asset_node.tags has been a
 * `text[]` since 0050 and the offboarding export already reads it — a tag
 * entity with an id and a lifecycle would be a second model of the same thing,
 * and the migration to it would rewrite every existing tag. A tag here is a
 * label somebody types, not a record somebody owns.
 *
 * Lowercased on the way in so "Production" and "production" are one tag rather
 * than two that sort apart and filter separately.
 */
export function normaliseTags(raw: string[]): string[] {
  const cleaned = raw
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((t) => t.length > 0 && t.length <= 60);
  const unique = [...new Set(cleaned)];
  if (unique.length === 0) throw ApiError.invalid('give at least one tag');
  if (unique.length > 20) throw ApiError.invalid('at most 20 tags at a time');
  return unique;
}

/**
 * The two tables a selection can address.
 *
 * A lookup keyed by a closed union, NOT a name from the request. The statements
 * below interpolate `table.name` into SQL because a table name cannot be a bind
 * parameter; that is only safe because the value can never be anything but one
 * of the two literals here, and BulkTarget is what guarantees it.
 */
const TABLE: Record<BulkTarget, { name: string; archiveColumn: string; label: string }> = {
  client: { name: 'organization', archiveColumn: 'archived_at', label: 'client' },
  node: { name: 'asset_node', archiveColumn: 'archived_at', label: 'item' },
};

/**
 * Add tags to every selected row, keeping what is already there.
 *
 * The union is computed in SQL rather than read-modify-write in TypeScript: two
 * technicians tagging the same client in the same second would otherwise each
 * read the old array and write their own, and one of the two tags would vanish
 * with nothing reporting a problem.
 */
export async function bulkAddTags(
  tx: HelmTx,
  target: BulkTarget,
  ids: string[],
  tags: string[],
): Promise<BulkOutcome> {
  const selection = normaliseSelection(ids);
  const clean = normaliseTags(tags);
  const table = TABLE[target];

  return runSelection(
    () =>
      tx.unsafe<{ id: string }[]>(
        `UPDATE ${table.name} SET
           tags = (
             SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}'::text[])
             FROM unnest(tags || $2::text[]) AS t
           ),
           updated_at = now()
         WHERE id = ANY($1::uuid[])
         RETURNING id`,
        [selection, clean],
      ),
    selection,
    'tag',
  );
}

export async function bulkRemoveTags(
  tx: HelmTx,
  target: BulkTarget,
  ids: string[],
  tags: string[],
): Promise<BulkOutcome> {
  const selection = normaliseSelection(ids);
  const clean = normaliseTags(tags);
  const table = TABLE[target];

  return runSelection(
    () =>
      tx.unsafe<{ id: string }[]>(
        `UPDATE ${table.name} SET
           tags = (
             SELECT coalesce(array_agg(t ORDER BY t), '{}'::text[])
             FROM unnest(tags) AS t
             WHERE NOT (t = ANY($2::text[]))
           ),
           updated_at = now()
         WHERE id = ANY($1::uuid[])
         RETURNING id`,
        [selection, clean],
      ),
    selection,
    'tag',
  );
}

// ---------------------------------------------------------------------------
// Archiving
// ---------------------------------------------------------------------------

/**
 * Archive, or restore.
 *
 * NOT a delete, and the distinction is the whole point of the feature: the row
 * is untouched, every credential under it is still decryptable, the audit
 * history still resolves, and one call puts it back. `deleted_at` means the
 * record is on its way out of the system; `archived_at` means it is not on
 * anybody's screen today.
 *
 * Re-archiving something already archived is a no-op that still counts as
 * affected — the caller asked for a state and got it. Anything else makes a
 * double-click into a failure.
 */
export async function bulkSetArchived(
  tx: HelmTx,
  target: BulkTarget,
  ids: string[],
  archived: boolean,
): Promise<BulkOutcome> {
  const selection = normaliseSelection(ids);
  const table = TABLE[target];

  return runSelection(
    () =>
      tx.unsafe<{ id: string }[]>(
        `UPDATE ${table.name} SET
           ${table.archiveColumn} = CASE WHEN $2::boolean THEN now() ELSE NULL END,
           updated_at = now()
         WHERE id = ANY($1::uuid[])
         RETURNING id`,
        [selection, archived],
      ),
    selection,
    archived ? 'archive' : 'restore',
  );
}

// ---------------------------------------------------------------------------
// Reading a selection back
// ---------------------------------------------------------------------------

export interface SelectedNode {
  id: string;
  organizationId: string;
  name: string;
}

/**
 * Which organisations a set of nodes belongs to, and confirmation that every
 * one of them is reachable.
 *
 * Used by bulk export, which has to group a selection by client before it can
 * request anything — the export engine produces one bundle per organisation,
 * because a bundle IS a client's documentation.
 */
export async function resolveNodes(tx: HelmTx, ids: string[]): Promise<SelectedNode[]> {
  const selection = normaliseSelection(ids);

  const rows = await tx<{ id: string; organization_id: string; name: string }[]>`
    SELECT id, organization_id, name
    FROM asset_node
    WHERE id = ANY(${selection}::uuid[]) AND archived_at IS NULL
  `;

  requireAll(selection, rows.map((r) => r.id), 'export');
  return rows.map((r) => ({ id: r.id, organizationId: r.organization_id, name: r.name }));
}

export async function resolveClients(tx: HelmTx, ids: string[]): Promise<string[]> {
  const selection = normaliseSelection(ids);

  const rows = await tx<{ id: string }[]>`
    SELECT id FROM organization
    WHERE id = ANY(${selection}::uuid[]) AND deleted_at IS NULL
  `;

  return requireAll(selection, rows.map((r) => r.id), 'export').affected;
}
