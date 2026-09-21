import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/**
 * POST /api/document-folders — a new folder in a client's tree.
 *
 * Its own path rather than /api/documents/folders, so a static segment never
 * has to win against a [attachmentId] that could in principle be the word
 * "folders".
 *
 * A plain INSERT under RLS, like every other piece of client documentation. The
 * rules it has to satisfy are all in the database: the policy decides whether
 * this actor may write here at all, a unique index refuses a duplicate name
 * beside its siblings, a trigger refuses a cycle and a tree deeper than
 * sixteen, and the same trigger forces is_internal_only true under an
 * internal-only parent.
 */
const createSchema = z.object({
  organizationId: z.guid('organizationId must be a UUID'),
  /** NULL creates at the top level of the client's tree. */
  parentId: z.guid().nullable().default(null),
  name: z.string().trim().min(1).max(120),
  isInternalOnly: z.boolean().default(false),
});

export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid folder', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    let rows: { id: string; name: string; is_internal_only: boolean }[];
    try {
      rows = await tx<{ id: string; name: string; is_internal_only: boolean }[]>`
        INSERT INTO document_folder (
          tenant_id, organization_id, parent_id, name, is_internal_only, created_by, updated_by
        )
        VALUES (
          ${identity.tenantId}::uuid, ${body.organizationId}::uuid, ${body.parentId},
          ${body.name}, ${body.isInternalOnly},
          ${identity.actorId}::uuid, ${identity.actorId}::uuid
        )
        RETURNING id, name, is_internal_only
      `;
    } catch (cause) {
      throw translateFolderError(cause);
    }

    const row = rows[0];
    if (!row) throw ApiError.conflict('the folder could not be created');

    return {
      folder: { id: row.id, name: row.name, isInternalOnly: row.is_internal_only },
    };
  },
  { permissions: ['asset:write'] },
);

/** Shared with the [folderId] route, so both explain a constraint the same way. */
export function translateFolderError(cause: unknown): unknown {
  const code = (cause as { code?: string } | null)?.code;
  const constraint = (cause as { constraint_name?: string } | null)?.constraint_name;
  const message = String((cause as { message?: string } | null)?.message ?? '');

  if (code === '23505' && constraint === 'document_folder_sibling_name_uk') {
    return ApiError.conflict('a folder with that name is already here');
  }
  if (code === '23503' && constraint === 'document_folder_parent_fk') {
    return ApiError.invalid('no such parent folder in this client');
  }
  // The emptiness rule, raised by helm.document_folder_before_delete() with the
  // counts in it, and the FK behind it if the trigger could not see them.
  if (code === '23503') {
    return ApiError.conflict(
      message.includes('helm:')
        ? stripPrefix(message)
        : 'that folder still has contents; move or delete them first',
    );
  }
  if (code === '23514') {
    return ApiError.invalid(
      message.includes('helm:') ? stripPrefix(message) : 'that folder name is not allowed',
    );
  }
  if (code === '42501') return ApiError.forbidden('that is not permitted');
  return cause;
}

function stripPrefix(message: string): string {
  // Postgres puts the message on the first line and the CONTEXT after it.
  return (message.split('\n')[0] ?? message).replace(/^helm:\s*/, '');
}

export const dynamic = 'force-dynamic';
