import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getDocumentService } from '@/lib/services';
import { DocumentError } from '@/lib/documents/service';
import { checkUpload, maxUploadBytes } from '@/lib/documents/limits';

/**
 * PATCH /api/documents/:id — rename, move, reclassify, archive or restore.
 *
 * One route for all five because they are one UPDATE, and because the
 * interesting rules are not here: RLS decides whether the row is reachable, a
 * unique index decides whether the new name is free, and a trigger decides what
 * is_internal_only ends up as — a document moved into an internal-only folder
 * becomes internal whatever this request asked for.
 *
 * ARCHIVING IS A WRITE, NOT A DELETE, which is why it is a field here rather
 * than a verb of its own. `archived` false restores. The row is whole either
 * way; only its presence in default views and in the search index changes.
 */
const patchSchema = z
  .object({
    filename: z.string().trim().min(1).max(200).optional(),
    /** `null` moves to the top level of the tree; absent leaves it alone. */
    folderId: z.guid().nullable().optional(),
    isInternalOnly: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

export const PATCH = tenantRoute(
  async ({ tx, request, params }) => {
    const attachmentId = idOrThrow(params.attachmentId);

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid document change', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    if (body.filename !== undefined) {
      // The same rules a new upload passes. A rename is how somebody would
      // otherwise get an .exe into a tree that refused one at the door.
      const check = checkUpload({
        filename: body.filename,
        // Not re-validating the size of a file that is already stored.
        byteSize: 1,
        maxBytes: maxUploadBytes(),
      });
      if (!check.ok) {
        throw ApiError.invalid(check.refusal.message, {
          issues: [{ path: 'filename', message: check.refusal.code }],
        });
      }
      body.filename = check.filename;
    }

    let rows: { id: string; filename: string; is_internal_only: boolean; archived_at: Date | null }[];
    try {
      rows = await tx<
        { id: string; filename: string; is_internal_only: boolean; archived_at: Date | null }[]
      >`
        UPDATE attachment SET
          filename         = coalesce(${body.filename ?? null}, filename),
          folder_id        = ${body.folderId !== undefined ? body.folderId : tx`folder_id`},
          is_internal_only = coalesce(${body.isInternalOnly ?? null}, is_internal_only),
          archived_at      = ${
            body.archived === undefined
              ? tx`archived_at`
              : body.archived
                ? tx`coalesce(archived_at, now())`
                : null
          }
        WHERE id = ${attachmentId}::uuid
          AND is_document
          AND deleted_at IS NULL
        RETURNING id, filename, is_internal_only, archived_at
      `;
    } catch (cause) {
      throw translateConstraint(cause);
    }

    // RLS makes "not yours" and "not there" the same answer, deliberately: a
    // distinguishable "exists but you may not" tells a co-managed client which
    // documents the MSP keeps from them.
    const row = rows[0];
    if (!row) throw ApiError.notFound('no such document');

    return {
      document: {
        id: row.id,
        filename: row.filename,
        isInternalOnly: row.is_internal_only,
        archivedAt: row.archived_at,
      },
    };
  },
  { permissions: ['asset:write'] },
);

/**
 * DELETE /api/documents/:id — permanently, and only after archiving.
 *
 * Both halves are enforced by helm.delete_document(), not here: the archive
 * rail and the asset:delete check live in the database so a script, a future
 * endpoint or a psql session cannot walk past them. The permission declared
 * below is a clearer error message, not the boundary.
 */
export const DELETE = tenantRoute(
  async ({ params, identity }) => {
    const attachmentId = idOrThrow(params.attachmentId);

    try {
      await getDocumentService().remove(
        { tenantId: identity.tenantId, actorId: identity.actorId, actorType: identity.actorType },
        attachmentId,
      );
    } catch (cause) {
      throw translateDelete(cause);
    }

    return { deleted: true };
  },
  { permissions: ['asset:delete'] },
);

function idOrThrow(raw: string | undefined): string {
  const parsed = z.guid().safeParse(raw);
  if (!parsed.success) throw ApiError.invalid('invalid document id');
  return parsed.data;
}

function translateConstraint(cause: unknown): unknown {
  const code = (cause as { code?: string } | null)?.code;
  const constraint = (cause as { constraint_name?: string } | null)?.constraint_name;

  if (code === '23505' && constraint === 'attachment_document_name_uk') {
    return ApiError.conflict(
      'a document with that name is already in this folder. Documents are not ' +
        'versioned: pick another name, or archive the existing file first.',
    );
  }
  if (code === '23503') return ApiError.invalid('no such folder in this client');
  if (code === '23514') return ApiError.invalid('that change is not allowed for a document');
  return cause;
}

/**
 * helm.delete_document() RETURNS its refusals rather than raising them, so the
 * audit row recording the attempt survives — see 0560. The service turns each
 * one into a DocumentError carrying the reason, and this maps the reason to a
 * status. A refusal is already on the record by the time it arrives here.
 */
function translateDelete(cause: unknown): unknown {
  if (cause instanceof DocumentError) {
    if (cause.code === 'not_found') return ApiError.notFound('no such document');
    if (cause.code === 'not_archived') return ApiError.conflict(cause.message);
    if (cause.code === 'forbidden') return ApiError.forbidden(cause.message);
  }
  return cause;
}

export const dynamic = 'force-dynamic';
