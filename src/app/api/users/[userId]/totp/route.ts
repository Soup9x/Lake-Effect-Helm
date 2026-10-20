import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/**
 * DELETE /api/users/[userId]/totp — reset somebody's authenticator (0960).
 *
 * For a lost phone with the recovery codes lost too. The person's seed and
 * recovery codes go; their next local sign-in either works on the password
 * alone or, when policy requires a code, walks them through setting up a new
 * app. user:write, checked here and again by helm.reset_local_totp(), which
 * also confines it to members of this tenant and writes the audit row.
 */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const userId = z.guid().safeParse(params.userId);
    if (!userId.success) throw ApiError.invalid('userId must be a UUID');

    const [row] = await tx<{ reset_local_totp: boolean }[]>`
      SELECT helm.reset_local_totp(${userId.data}::uuid)
    `;
    if (!row?.reset_local_totp) throw ApiError.notFound('that person has no authenticator set up');
    return { reset: userId.data };
  },
  { permissions: ['user:write'] },
);

export const dynamic = 'force-dynamic';
