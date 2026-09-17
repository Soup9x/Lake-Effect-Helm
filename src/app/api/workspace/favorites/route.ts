import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { listFavorites, setFavorite } from '@/lib/workspace/queries';

/**
 * Pinning a client.
 *
 * No permission is declared, and that is correct rather than an oversight: a
 * favourite is a bookmark to a client the caller can ALREADY see. The INSERT
 * runs under user_favorite's policy, which names the acting user, and its
 * foreign key reaches organization through a composite key carrying tenant_id —
 * so pinning a client in another tenant, or one outside a client user's scope,
 * fails at the database rather than being caught here.
 *
 * It is also why this is not gated on `organization:read`: an API service token
 * has no personal list to write to, and the policy already says so.
 */
const schema = z.object({
  organizationId: z.guid('organizationId must be a UUID'),
  pinned: z.boolean(),
});

export const GET = tenantRoute(async ({ tx }) => ({ favorites: await listFavorites(tx) }));

export const PUT = tenantRoute(async ({ tx, request }) => {
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw);
    if (!result.success) throw ApiError.invalid('an organizationId and a pinned flag');
    return result.data;
  });

  try {
    await setFavorite(tx, body.organizationId, body.pinned);
  } catch (error) {
    // 23503: the organisation does not exist, or is not this tenant's. Both
    // answer the same way, so that pinning is not an existence oracle for
    // clients belonging to another MSP.
    if ((error as { code?: string }).code === '23503') throw ApiError.invalid('no such client');
    throw error;
  }

  return { organizationId: body.organizationId, pinned: body.pinned };
});

export const dynamic = 'force-dynamic';
