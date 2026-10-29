import { z } from 'zod';
import { readJson, serviceRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { withTenant } from '@/lib/db/client';
import {
  MAX_SELECTION, archiveDocumentsForDelete, auditEntity, bulkDelete, bulkDeleteVault,
} from '@/lib/bulk/service';
import { requirePerson } from '@/lib/personal/http';
import { getDocumentService } from '@/lib/services';
import { DocumentError } from '@/lib/documents/service';

const schema = z.object({
  /** 'vault' is the signed-in person's own passwords (1030). */
  target: z.enum(['node', 'contact', 'document', 'site', 'vault']),
  ids: z.array(z.guid()).min(1).max(MAX_SELECTION),
});

/**
 * POST /api/bulk/delete — permanently delete a selection.
 *
 * WHAT EACH LIST CAN DELETE, and who may, the same as one row at a time:
 *
 *   node      passwords only, secret:delete (helm.delete_credential decides)
 *   document  uploaded files and written documents, asset:delete
 *   contact   asset:write, as their creation is
 *   site      asset:write, as their creation is
 *   vault     the person's own entries, nobody else's (the owner policy)
 *
 * Live rows are archived first in the same request, so the archive-first rail
 * in the database is kept rather than walked past; see bulkDelete. The bar
 * asks for the count to be confirmed and "delete" typed before it calls this.
 *
 * WHOLE OR NOTHING, except documents. A document's stored file goes with it,
 * through the document service, one transaction each — a file removed from
 * storage cannot be put back by a rollback. So the selection is archived (and
 * its reach checked) as one unit first, and then each is deleted; one that
 * fails is left archived, restorable, and named in the answer.
 */
export const POST = serviceRoute(async ({ actor, session, identity, request }) => {
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid('invalid bulk delete request', { issues: zodIssues(result.error) });
    }
    return result.data;
  });
  const can = (permission: string) => session.permissions.includes(permission);

  if (body.target === 'vault') {
    requirePerson(identity);
    // No audit row naming the entries: the vault's rule is that an
    // administrator reading the log learns that, not what (1030).
    const outcome = await withTenant(actor, async (tx) => {
      const deleted = await bulkDeleteVault(tx, body.ids);
      await tx`
        SELECT helm.audit('personal_vault.bulk_deleted', 'personal_credential', NULL::uuid,
                          'success'::audit_outcome, NULL::uuid, NULL::uuid, NULL::text,
                          ${tx.json({ count: deleted.affected.length })}::jsonb)
      `;
      return deleted;
    });
    return { affected: outcome.affected.length };
  }

  if (body.target === 'node' && !can('secret:delete')) {
    throw ApiError.forbidden('deleting passwords needs the secret:delete permission. Nothing was changed.');
  }
  if (body.target === 'document' && !can('asset:delete')) {
    throw ApiError.forbidden('deleting documents needs the asset:delete permission. Nothing was changed.');
  }
  if ((body.target === 'contact' || body.target === 'site') && !can('asset:write')) {
    throw ApiError.forbidden('you may not delete these. Nothing was changed.');
  }

  if (body.target === 'document') {
    const { files, pages } = await withTenant(actor, (tx) => archiveDocumentsForDelete(tx, body.ids));
    const documents = getDocumentService();
    const failed: string[] = [];
    let deleted = 0;
    for (const [id, remove] of [
      ...files.map((id) => [id, () => documents.remove(actor, id)] as const),
      ...pages.map((id) => [id, () => documents.removePage(actor, id)] as const),
    ]) {
      try {
        await remove();
        deleted += 1;
      } catch (cause) {
        if (!(cause instanceof DocumentError)) throw cause;
        failed.push(id);
      }
    }
    await withTenant(actor, (tx) => tx`
      SELECT helm.audit('bulk.delete', 'document', NULL::uuid,
                        ${failed.length === 0 ? 'success' : 'failure'}::audit_outcome,
                        NULL::uuid, NULL::uuid, NULL::text,
                        ${tx.json({ count: deleted, failed })}::jsonb)
    `);
    if (failed.length > 0) {
      throw ApiError.conflict(
        `Deleted ${deleted} of ${files.length + pages.length}. ${failed.length} could not be deleted and ` +
          `${failed.length === 1 ? 'is' : 'are'} left archived — tick "Include archived" to find ${failed.length === 1 ? 'it' : 'them'}.`,
        { failed },
      );
    }
    return { affected: deleted };
  }

  const target = body.target;
  const outcome = await withTenant(actor, async (tx) => {
    let deleted;
    try {
      deleted = await bulkDelete(tx, target, body.ids, identity.actorId);
    } catch (error) {
      if ((error as { code?: string }).code === '42501') {
        throw ApiError.forbidden('Those items are not yours to delete. Nothing was changed.');
      }
      throw error;
    }
    await tx`
      SELECT helm.audit('bulk.delete', ${auditEntity(target)}, NULL::uuid, 'success'::audit_outcome,
                        NULL::uuid, NULL::uuid, NULL::text,
                        ${tx.json({ count: deleted.affected.length, ids: deleted.affected })}::jsonb)
    `;
    return deleted;
  });
  return { affected: outcome.affected.length };
});

export const dynamic = 'force-dynamic';
