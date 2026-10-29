/**
 * "Make copies" on a selection of written documents: each copied as
 * "<title> (copy)" in the same folder, with its text, its internal-only flag
 * and its tags, as version 1.
 *
 * WRITTEN DOCUMENTS ONLY. An uploaded file's bytes are stored once, encrypted,
 * under one storage key that deleting the row removes; a second row naming the
 * same key would lose its file when the first was deleted. The bar offers Make
 * copies only when every row ticked is a written document.
 *
 * NOT COPIED: the version history, the files attached to the page and its
 * dependencies. The copy is a new document that starts from this text.
 *
 * Titles are unique within a folder, so a second copy is "(copy 2)", and so on.
 */
import { withTenant } from '../db/client';
import type { ActorRef } from '../secrets/service';
import { ApiError } from '../api/errors';

export interface PageCopy {
  id: string;
  sourceId: string;
  name: string;
}

export async function copyPages(actor: ActorRef, ids: readonly string[]): Promise<PageCopy[]> {
  const unique = [...new Set(ids)];
  return withTenant(actor, async (tx) => {
    const sources = await tx<{ id: string; organization_id: string; folder_id: string | null; title: string }[]>`
      SELECT id, organization_id, folder_id, title FROM document_page
      WHERE id = ANY(${unique}::uuid[]) AND deleted_at IS NULL AND archived_at IS NULL
    `;
    if (sources.length !== unique.length) {
      const missing = unique.length - sources.length;
      throw unique.length === 1
        ? ApiError.notFound('no such document, or it is an uploaded file — only written documents can be copied')
        : ApiError.notFound(
            `${missing} of these are not written documents, or are archived. Only written documents can be copied. Nothing was copied.`,
          );
    }

    const copies: PageCopy[] = [];
    for (const source of sources) {
      const taken = new Set(
        (await tx<{ title: string }[]>`
          SELECT lower(title) AS title FROM document_page
          WHERE organization_id = ${source.organization_id}::uuid
            AND folder_id IS NOT DISTINCT FROM ${source.folder_id}::uuid AND deleted_at IS NULL
        `).map((r) => r.title),
      );
      let title = `${source.title} (copy)`.slice(0, 200);
      for (let n = 2; taken.has(title.toLowerCase()); n += 1) {
        title = `${source.title} (copy ${n})`.slice(0, 200);
      }

      const [copy] = await tx<{ id: string }[]>`
        INSERT INTO document_page (
          tenant_id, organization_id, folder_id, title, body, body_text, is_internal_only, tags,
          created_by, updated_by
        )
        SELECT tenant_id, organization_id, folder_id, ${title}, body, body_text, is_internal_only, tags,
               ${actor.actorId}::uuid, ${actor.actorId}::uuid
        FROM document_page WHERE id = ${source.id}::uuid
        RETURNING id
      `;
      if (!copy) throw ApiError.forbidden('those documents are not yours to copy. Nothing was copied.');
      copies.push({ id: copy.id, sourceId: source.id, name: title });
    }

    await tx`
      SELECT helm.audit('bulk.copy', 'document', NULL::uuid, 'success'::audit_outcome,
                        NULL::uuid, NULL::uuid, NULL::text,
                        ${tx.json({ count: copies.length, copies: copies.map((c) => ({ id: c.id, sourceId: c.sourceId })) })}::jsonb)
    `;
    return copies;
  });
}
