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

/**
 * What a selection can be of. 'document' is a client's Documents list, which
 * holds uploaded files (attachment) and written documents (document_page) in
 * one list: a selection's ids are matched against both tables, which share no
 * ids, so one selection can hold both.
 */
export type BulkTarget = 'client' | 'node' | 'contact' | 'document' | 'site';

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
function normaliseSelection(ids: string[]): string[] {
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
function normaliseTags(raw: string[]): string[] {
  const cleaned = raw
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((t) => t.length > 0 && t.length <= 60);
  const unique = [...new Set(cleaned)];
  if (unique.length === 0) throw ApiError.invalid('give at least one tag');
  if (unique.length > 20) throw ApiError.invalid('at most 20 tags at a time');
  return unique;
}

/**
 * The tables a selection can address.
 *
 * A lookup keyed by a closed union, NOT a name from the request. The statements
 * below interpolate `name` and `live` into SQL because a table name cannot be a
 * bind parameter; that is only safe because the values can never be anything
 * but the literals here, and BulkTarget is what guarantees it.
 *
 * `live` narrows to the rows the list shows: not deleted, and for attachments
 * only the documents in the tree. `touch` is false for attachment, which has no
 * updated_at.
 */
interface BulkTable { name: string; live: string; touch: boolean }

const TABLES: Record<BulkTarget, BulkTable[]> = {
  client: [{ name: 'organization', live: 'TRUE', touch: true }],
  node: [{ name: 'asset_node', live: 'TRUE', touch: true }],
  // Archived since 0850, tagged since 1050.
  contact: [{ name: 'contact', live: 'deleted_at IS NULL', touch: true }],
  // Tagged since 1150, archived since 0560 and 0810.
  document: [
    { name: 'attachment', live: 'is_document AND deleted_at IS NULL', touch: false },
    { name: 'document_page', live: 'deleted_at IS NULL', touch: true },
  ],
  // Archived since 0940, tagged since 1150.
  site: [{ name: 'site', live: 'deleted_at IS NULL', touch: true }],
};

/** One UPDATE per table the target spans, every one under the caller's RLS. */
async function updateEach(
  tx: HelmTx,
  target: BulkTarget,
  statement: (table: BulkTable) => string,
  params: unknown[],
): Promise<{ id: string }[]> {
  const rows: { id: string }[] = [];
  for (const table of TABLES[target]) {
    rows.push(...(await tx.unsafe<{ id: string }[]>(statement(table), params as never[])));
  }
  return rows;
}

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

  return runSelection(
    () =>
      updateEach(
        tx,
        target,
        (table) => `UPDATE ${table.name} SET
           tags = (
             SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}'::text[])
             FROM unnest(tags || $2::text[]) AS t
           )${table.touch ? ',\n           updated_at = now()' : ''}
         WHERE id = ANY($1::uuid[]) AND ${table.live}
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

  return runSelection(
    () =>
      updateEach(
        tx,
        target,
        (table) => `UPDATE ${table.name} SET
           tags = (
             SELECT coalesce(array_agg(t ORDER BY t), '{}'::text[])
             FROM unnest(tags) AS t
             WHERE NOT (t = ANY($2::text[]))
           )${table.touch ? ',\n           updated_at = now()' : ''}
         WHERE id = ANY($1::uuid[]) AND ${table.live}
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

  return runSelection(
    () =>
      updateEach(
        tx,
        target,
        (table) => `UPDATE ${table.name} SET
           archived_at = CASE WHEN $2::boolean THEN now() ELSE NULL END${table.touch ? ',\n           updated_at = now()' : ''}${
             // An archived location is nobody's head office, as on its own
             // page: archiving clears the flag so the client can name another.
             target === 'site' ? ',\n           is_primary = CASE WHEN $2::boolean THEN false ELSE is_primary END' : ''}
         WHERE id = ANY($1::uuid[]) AND ${table.live}
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

export interface SelectedContact {
  id: string;
  organizationId: string;
}

/**
 * The contacts a selection names, grouped later by client for export, with the
 * same all-or-nothing reach check as nodes. Archived contacts are not exported,
 * as archived entries are not.
 */
export async function resolveContacts(tx: HelmTx, ids: string[]): Promise<SelectedContact[]> {
  const selection = normaliseSelection(ids);
  const rows = await tx<{ id: string; organization_id: string }[]>`
    SELECT id, organization_id FROM contact
    WHERE id = ANY(${selection}::uuid[]) AND deleted_at IS NULL AND archived_at IS NULL
  `;
  requireAll(selection, rows.map((r) => r.id), 'export');
  return rows.map((r) => ({ id: r.id, organizationId: r.organization_id }));
}

export async function resolveClients(tx: HelmTx, ids: string[]): Promise<string[]> {
  const selection = normaliseSelection(ids);

  const rows = await tx<{ id: string }[]>`
    SELECT id FROM organization
    WHERE id = ANY(${selection}::uuid[]) AND deleted_at IS NULL
  `;

  return requireAll(selection, rows.map((r) => r.id), 'export').affected;
}

export interface SelectedRow {
  id: string;
  organizationId: string;
}

/**
 * The documents a selection names — uploaded files and written documents
 * alike — for export, grouped later by client. Archived ones are not exported,
 * as archived entries are not.
 */
export async function resolveDocuments(tx: HelmTx, ids: string[]): Promise<SelectedRow[]> {
  const selection = normaliseSelection(ids);
  const rows = await tx<{ id: string; organization_id: string }[]>`
    SELECT id, organization_id FROM attachment
    WHERE id = ANY(${selection}::uuid[]) AND is_document AND deleted_at IS NULL AND archived_at IS NULL
    UNION ALL
    SELECT id, organization_id FROM document_page
    WHERE id = ANY(${selection}::uuid[]) AND deleted_at IS NULL AND archived_at IS NULL
  `;
  requireAll(selection, rows.map((r) => r.id), 'export');
  return rows.map((r) => ({ id: r.id, organizationId: r.organization_id }));
}

/** The locations a selection names, for export, with the same reach check. */
export async function resolveSites(tx: HelmTx, ids: string[]): Promise<SelectedRow[]> {
  const selection = normaliseSelection(ids);
  const rows = await tx<{ id: string; organization_id: string }[]>`
    SELECT id, organization_id FROM site
    WHERE id = ANY(${selection}::uuid[]) AND deleted_at IS NULL AND archived_at IS NULL
  `;
  requireAll(selection, rows.map((r) => r.id), 'export');
  return rows.map((r) => ({ id: r.id, organizationId: r.organization_id }));
}

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

/**
 * Permanent deletion of a selection, for the targets whose deletion is plain
 * SQL. Documents go through the document service, one at a time, because each
 * takes its stored file with it (see POST /api/bulk/delete).
 *
 * ARCHIVE FIRST STILL HOLDS, and here it is done for the person: every row is
 * archived in this transaction before it is deleted, so the database's rail
 * (helm.delete_credential refuses a live credential) and the per-row routes'
 * order are both kept. What stands in front of a live row instead is the bar's
 * confirmation, which names the count and needs "delete" typed.
 *
 *   node     credentials only, through helm.delete_credential(), which checks
 *            secret:delete and removes the password unless something else
 *            documents it. Other entries archive and stay archived — that is
 *            a data-retention rule, not a missing branch (see the assets route).
 *   contact  deleted_at, as DELETE /api/contacts/:id does.
 *   site     deleted_at, as DELETE /api/sites/:id does; what was recorded
 *            there keeps its record and shows no location.
 */
export async function bulkDelete(
  tx: HelmTx,
  target: 'node' | 'contact' | 'site',
  ids: string[],
  actorId: string,
): Promise<BulkOutcome> {
  const selection = normaliseSelection(ids);

  if (target === 'node') {
    const found = await tx<{ id: string; node_type: string }[]>`
      SELECT id, node_type::text FROM asset_node WHERE id = ANY(${selection}::uuid[])
    `;
    requireAll(selection, found.map((r) => r.id), 'delete');
    const other = found.filter((r) => r.node_type !== 'credential').length;
    if (other > 0) {
      throw ApiError.invalid(
        `${other} of the selected items ${other === 1 ? 'is not a password' : 'are not passwords'}. ` +
          'Only passwords can be deleted; archive the rest. Nothing was changed.',
      );
    }
    await runSelection(
      () => tx<{ id: string }[]>`
        UPDATE asset_node SET archived_at = coalesce(archived_at, now()), updated_at = now()
        WHERE id = ANY(${selection}::uuid[]) RETURNING id
      `,
      selection,
      'delete',
    );
    for (const id of selection) {
      await tx`SELECT helm.delete_credential(${id}::uuid)`;
    }
    return { requested: selection, affected: selection };
  }

  return runSelection(
    () =>
      target === 'contact'
        ? tx<{ id: string }[]>`
            UPDATE contact SET archived_at = coalesce(archived_at, now()), deleted_at = now(),
                   updated_at = now(), updated_by = ${actorId}::uuid
            WHERE id = ANY(${selection}::uuid[]) AND deleted_at IS NULL
            RETURNING id
          `
        : tx<{ id: string }[]>`
            UPDATE site SET archived_at = coalesce(archived_at, now()), is_primary = false,
                   deleted_at = now(), updated_at = now(), updated_by = ${actorId}::uuid
            WHERE id = ANY(${selection}::uuid[]) AND deleted_at IS NULL
            RETURNING id
          `,
    selection,
    'delete',
  );
}

/**
 * Deleting a selection of the signed-in person's own vault entries. There is no
 * archive for these (1030): a delete is a delete, as on the entry's page. The
 * owner policy matches nobody else's, so somebody else's id is a shortfall.
 */
export async function bulkDeleteVault(tx: HelmTx, ids: string[]): Promise<BulkOutcome> {
  const selection = normaliseSelection(ids);
  return runSelection(
    () => tx<{ id: string }[]>`
      DELETE FROM personal_credential WHERE id = ANY(${selection}::uuid[]) RETURNING id
    `,
    selection,
    'delete',
  );
}

/**
 * Archive the documents a selection names, ready for the document service to
 * delete them one by one, and say which table each id is in.
 */
export async function archiveDocumentsForDelete(
  tx: HelmTx,
  ids: string[],
): Promise<{ files: string[]; pages: string[] }> {
  const selection = normaliseSelection(ids);
  const files = await tx<{ id: string }[]>`
    UPDATE attachment SET archived_at = coalesce(archived_at, now())
    WHERE id = ANY(${selection}::uuid[]) AND is_document AND deleted_at IS NULL
    RETURNING id
  `;
  const pages = await tx<{ id: string }[]>`
    UPDATE document_page SET archived_at = coalesce(archived_at, now()), updated_at = now()
    WHERE id = ANY(${selection}::uuid[]) AND deleted_at IS NULL
    RETURNING id
  `;
  requireAll(selection, [...files, ...pages].map((r) => r.id), 'delete');
  return { files: files.map((r) => r.id), pages: pages.map((r) => r.id) };
}

/** The entity type a bulk audit row names. 'document' spans two tables; named for the list. */
export function auditEntity(target: BulkTarget): string {
  switch (target) {
    case 'client': return 'organization';
    case 'contact': return 'contact';
    case 'document': return 'document';
    case 'site': return 'site';
    default: return 'asset_node';
  }
}
