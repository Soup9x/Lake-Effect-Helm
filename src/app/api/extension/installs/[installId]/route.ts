import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { renameMyBrowser, revokeMyBrowser } from '@/lib/extension/pairing';

const renameSchema = z.object({ label: z.string().trim().min(1).max(80) });

/**
 * PATCH /api/extension/installs/:installId — rename one of your browsers (1180).
 *
 * Live, removed or lapsed alike: the name is only a label. The token's name
 * follows, so the API tokens list reads the same.
 */
export const PATCH = tenantRoute(async ({ tx, params, request }) => {
  const id = z.guid().safeParse(params.installId);
  if (!id.success) throw ApiError.invalid('not a paired browser id');
  const body = await readJson(request, (raw) => {
    const result = renameSchema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid('a name of at most 80 characters', { issues: zodIssues(result.error) });
    }
    return result.data;
  });
  if (!(await renameMyBrowser(tx, id.data, body.label))) throw ApiError.notFound('no such paired browser');
  return { label: body.label };
});

/**
 * DELETE /api/extension/installs/:installId — unpair one of your browsers.
 *
 * Immediate: the pairing's token is revoked in the same statement, and its key
 * stops being returned to the request path, so the extension's next request is
 * refused. An id that is not yours answers exactly as one that does not exist.
 */
export const DELETE = tenantRoute(async ({ tx, params }) => {
  const id = z.guid().safeParse(params.installId);
  if (!id.success) throw ApiError.invalid('not a paired browser id');
  if (!(await revokeMyBrowser(tx, id.data))) throw ApiError.notFound('no such paired browser');
  return { revoked: true };
});

export const dynamic = 'force-dynamic';
