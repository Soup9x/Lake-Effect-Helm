import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { revokeServiceAccountToken } from '@/lib/auth/service-accounts';

/** DELETE /api/tenant/service-accounts/:accountId/tokens/:tokenId — revoke. */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const tokenId = z.guid().safeParse(params.tokenId);
    if (!tokenId.success) throw ApiError.notFound('no such token');
    const revoked = await revokeServiceAccountToken(tx, tokenId.data);
    if (!revoked) throw ApiError.notFound('no such token');
    return { revoked: true };
  },
  { permissions: ['user:write'] },
);

export const dynamic = 'force-dynamic';
