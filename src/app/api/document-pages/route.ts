import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { bodySchema, createPage, EMPTY_BODY, readPage } from '@/lib/documents/pages';

/**
 * POST /api/document-pages — write a document (0810).
 *
 * A title and, optionally, a folder and a first body. The folder must be the
 * client's own (a three-column foreign key says so) and an internal-only
 * folder makes the page internal-only whatever was asked, by trigger. One
 * title per folder, as one filename per folder.
 */
const createSchema = z.object({
  organizationId: z.guid(),
  folderId: z.guid().nullable().default(null),
  title: z.string().trim().min(1).max(200),
  body: bodySchema.optional(),
  isInternalOnly: z.boolean().default(false),
});

export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('a title, and optionally a folder', { issues: zodIssues(result.error) });
      return result.data;
    });
    try {
      const id = await createPage(tx, identity.tenantId, identity.actorId, {
        organizationId: body.organizationId,
        folderId: body.folderId,
        title: body.title,
        body: body.body ?? EMPTY_BODY,
        isInternalOnly: body.isInternalOnly,
      });
      return { page: await readPage(tx, id) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23503') throw ApiError.invalid('no such client or folder');
      if (code === '23505') throw ApiError.conflict(`a document called "${body.title}" already exists in that folder`);
      throw error;
    }
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
