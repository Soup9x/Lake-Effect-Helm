import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { revokeBrowser } from '@/lib/extension/pairing';

/**
 * DELETE /api/extension/admin/installs/:installId — revoke anybody's paired
 * browser, from Administration → Browser extensions.
 *
 * user:write, from a session (1121). As immediate as the person removing it
 * themselves: the token goes in the same statement, so the extension's next
 * request is refused.
 */
export const DELETE = tenantRoute(async ({ tx, params, identity }) => {
  if (identity.method === 'api_token') {
    throw ApiError.forbidden('revoke a browser from a signed-in Helm tab');
  }
  const id = z.guid().safeParse(params.installId);
  if (!id.success) throw ApiError.invalid('not a paired browser id');
  if (!(await revokeBrowser(tx, id.data))) throw ApiError.notFound('no such paired browser');
  return { revoked: true };
}, { permissions: ['user:write'] });

export const dynamic = 'force-dynamic';
