import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { revokeMyToken } from '@/lib/auth/api-tokens';

/**
 * DELETE /api/account/tokens/:tokenId — revoke one of your own tokens.
 *
 * Takes effect on the next request the token makes: 0030 re-reads revoked_at
 * when it opens a session context, so there is no cache to wait out. An id that
 * is not yours answers "no such token", the same as one that does not exist;
 * confirming that a token id is real is not something this route should do.
 *
 * Revoking the token that authenticated the request is allowed. It is the
 * right move for a token found somewhere it should not be, and the caller has
 * no other way to make it from that session.
 */
export const DELETE = tenantRoute(async ({ tx, params }) => {
  const tokenId = z.guid().safeParse(params.tokenId);
  if (!tokenId.success) throw ApiError.notFound('no such token');

  const revoked = await revokeMyToken(tx, tokenId.data);
  if (!revoked) throw ApiError.notFound('no such token');
  return { revoked: true };
});

export const dynamic = 'force-dynamic';
