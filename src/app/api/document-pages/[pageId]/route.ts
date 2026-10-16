import { z } from 'zod';
import { readJson, serviceRoute, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { bodySchema, readPage, updatePage } from '@/lib/documents/pages';
import { listPageAttachments } from '@/lib/clients/queries';
import { getDocumentService } from '@/lib/services';
import { DocumentError } from '@/lib/documents/service';

const idOrThrow = (raw: string | undefined): string => {
  const parsed = z.guid().safeParse(raw);
  if (!parsed.success) throw ApiError.invalid('invalid document id');
  return parsed.data;
};

/** GET — the page, its body and the files attached to it. */
export const GET = tenantRoute(
  async ({ tx, params }) => {
    const pageId = idOrThrow(params.pageId);
    const page = await readPage(tx, pageId);
    if (!page) throw ApiError.notFound('no such document');
    const attachments = await listPageAttachments(tx, pageId);
    return {
      page,
      attachments: attachments.map((a) => ({
        id: a.id, filename: a.filename, contentType: a.content_type, byteSize: Number(a.byte_size),
        archived: a.archived_at !== null, uploadedAt: a.uploaded_at.toISOString(), uploadedBy: a.uploaded_by_name,
      })),
    };
  },
  { permissions: ['asset:read'] },
);

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: bodySchema.optional(),
    folderId: z.guid().nullable().optional(),
    isInternalOnly: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

/** PATCH — the title, the body (a new version), the folder, the flag, the archive state. */
export const PATCH = tenantRoute(
  async ({ tx, request, params, identity }) => {
    const pageId = idOrThrow(params.pageId);
    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid document change', { issues: zodIssues(result.error) });
      return result.data;
    });
    try {
      if (!(await updatePage(tx, identity.actorId, pageId, body))) throw ApiError.notFound('no such document');
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23503') throw ApiError.invalid('no such folder');
      if (code === '23505') throw ApiError.conflict('a document with that title already exists in that folder');
      throw error;
    }
    return { page: await readPage(tx, pageId) };
  },
  { permissions: ['asset:write'] },
);

/** DELETE — permanently, and only after archiving; the database enforces both. */
export const DELETE = serviceRoute(
  async ({ params, actor }) => {
    const pageId = idOrThrow(params.pageId);
    try {
      await getDocumentService().removePage(actor, pageId);
    } catch (cause) {
      if (cause instanceof DocumentError) {
        if (cause.code === 'not_archived') throw ApiError.invalid(cause.message);
        if (cause.code === 'forbidden') throw ApiError.forbidden(cause.message);
        if (cause.code === 'not_found') throw ApiError.notFound(cause.message);
      }
      throw cause;
    }
    return { deleted: true };
  },
  { permissions: ['asset:delete'] },
);

export const dynamic = 'force-dynamic';
