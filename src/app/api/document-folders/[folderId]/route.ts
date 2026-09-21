import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { translateFolderError } from '../route';

/**
 * PATCH /api/document-folders/:id — rename, move, or reclassify.
 *
 * DELETE /api/document-folders/:id — only when it is empty.
 *
 * EMPTY-FIRST RATHER THAN A CASCADE, and the decision is in 0560 rather than
 * here: both foreign keys into the tree are ON DELETE RESTRICT, and a trigger
 * turns the resulting 23503 into a sentence naming how many subfolders and
 * documents are in the way. The alternative — cascade with a confirmation
 * dialog — would also destroy ARCHIVED documents inside, which is precisely
 * the outcome archiving exists to prevent, and it would do it behind a button
 * people click.
 *
 * Deleting an empty folder needs asset:write, not asset:delete: nothing is
 * destroyed, because there is nothing in it. Destroying a document needs
 * asset:delete, and that ladder is the same one 0500 set up for clients and
 * credentials.
 */
const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** `null` moves it to the top level; absent leaves it where it is. */
    parentId: z.guid().nullable().optional(),
    isInternalOnly: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

export const PATCH = tenantRoute(
  async ({ tx, request, params, identity }) => {
    const folderId = idOrThrow(params.folderId);

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid folder change', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    if (body.parentId === folderId) {
      throw ApiError.invalid('a folder cannot be its own parent');
    }

    let rows: { id: string; name: string; is_internal_only: boolean; parent_id: string | null }[];
    try {
      rows = await tx<
        { id: string; name: string; is_internal_only: boolean; parent_id: string | null }[]
      >`
        UPDATE document_folder SET
          name             = coalesce(${body.name ?? null}, name),
          parent_id        = ${body.parentId !== undefined ? body.parentId : tx`parent_id`},
          is_internal_only = coalesce(${body.isInternalOnly ?? null}, is_internal_only),
          updated_by       = ${identity.actorId}::uuid
        WHERE id = ${folderId}::uuid
        RETURNING id, name, is_internal_only, parent_id
      `;
    } catch (cause) {
      throw translateFolderError(cause);
    }

    const row = rows[0];
    if (!row) throw ApiError.notFound('no such folder');

    return {
      folder: {
        id: row.id,
        name: row.name,
        parentId: row.parent_id,
        isInternalOnly: row.is_internal_only,
      },
    };
  },
  { permissions: ['asset:write'] },
);

export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const folderId = idOrThrow(params.folderId);

    let rows: { id: string }[];
    try {
      rows = await tx<{ id: string }[]>`
        DELETE FROM document_folder WHERE id = ${folderId}::uuid RETURNING id
      `;
    } catch (cause) {
      throw translateFolderError(cause);
    }

    if (!rows[0]) throw ApiError.notFound('no such folder');
    return { deleted: true };
  },
  { permissions: ['asset:write'] },
);

function idOrThrow(raw: string | undefined): string {
  const parsed = z.guid().safeParse(raw);
  if (!parsed.success) throw ApiError.invalid('invalid folder id');
  return parsed.data;
}

export const dynamic = 'force-dynamic';
