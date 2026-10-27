import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { revokeMyBrowser } from '@/lib/extension/pairing';

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
