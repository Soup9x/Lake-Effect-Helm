import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { requireExtensionCaller, requireExtensionToken } from '@/lib/extension/http';
import { checkLogin } from '@/lib/extension/save';
import { siteOf } from '@/lib/extension/site';
import type { ExtensionLoginCheck } from '@/lib/extension/types';

/**
 * POST /api/extension/check — after the person signs in to a site: does Helm
 * have this login, and with this password?
 *
 * The body carries the page's URL, as the browser reported it to the
 * extension's background, and what was typed. The password is compared and
 * dropped: never stored, logged or returned (src/lib/extension/save.ts).
 * Nothing is revealed, so nothing is audited, as with a lookup.
 */
const schema = z.object({
  url: z.string().max(4096),
  username: z.string().trim().max(320),
  password: z.string().min(1).max(65_536),
});

export const POST = tenantRoute(async ({ tx, request, identity, session }): Promise<ExtensionLoginCheck> => {
  requireExtensionToken(identity);
  requireExtensionCaller(identity, session);
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw);
    if (!result.success) throw ApiError.invalid('a page address, a username and a password');
    return result.data;
  });
  const site = siteOf(body.url);
  if (!site) throw ApiError.invalid('a web page address');
  return checkLogin(tx, identity.tenantId, site, body.username, body.password, session.permissions);
}, { permissions: ['asset:read'] });

export const dynamic = 'force-dynamic';
