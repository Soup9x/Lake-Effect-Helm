import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { requireExtensionCaller } from '@/lib/extension/http';
import { search } from '@/lib/extension/lookup';
import type { ExtensionEntry } from '@/lib/extension/types';

/**
 * POST /api/extension/search — client credentials and the person's own vault,
 * by name, username, client or URL, as the person types: from one character,
 * with near misses on a name or client for three or more. For a site the
 * lookup did not match, and for a shared sign-in page such as Microsoft 365's,
 * where the person knows which client they want and the address cannot say.
 */
const schema = z.object({ q: z.string().trim().min(1).max(100) });

export const POST = tenantRoute(async ({ tx, request, identity, session }): Promise<{ entries: ExtensionEntry[] }> => {
  requireExtensionCaller(identity, session);
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw);
    if (!result.success) throw ApiError.invalid('a search of 1 to 100 characters');
    return result.data;
  });
  return { entries: await search(tx, body.q) };
}, { permissions: ['asset:read'] });

export const dynamic = 'force-dynamic';
