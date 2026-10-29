import { z } from 'zod';
import { actorFor, readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { requireExtensionCaller, requireExtensionToken } from '@/lib/extension/http';
import { updateLogin } from '@/lib/extension/save';
import { siteOf } from '@/lib/extension/site';
import type { ExtensionSaved } from '@/lib/extension/types';

/**
 * POST /api/extension/logins/update — the person signed in to a site with a
 * password other than the one Helm has, and said to update it.
 *
 * The login must be one Helm matches to that site, and a standard one: the
 * extension cannot be pointed at any other credential. A client login gets a
 * new version, audited with the site as its reason, and keeps the old one in
 * its history; a personal entry's password is replaced.
 */
const schema = z.object({
  url: z.string().max(4096),
  kind: z.enum(['client', 'personal']),
  id: z.guid(),
  password: z.string().min(1).max(65_536),
});

export const POST = tenantRoute(async ({ tx, request, identity, session, requestId }): Promise<ExtensionSaved> => {
  requireExtensionToken(identity);
  requireExtensionCaller(identity, session);
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw);
    if (!result.success) throw ApiError.invalid('invalid update', { issues: zodIssues(result.error) });
    return result.data;
  });
  const site = siteOf(body.url);
  if (!site) throw ApiError.invalid('a web page address');
  return updateLogin(tx, actorFor(identity, requestId), site, { kind: body.kind, id: body.id }, body.password);
}, { permissions: ['secret:write'] });

export const dynamic = 'force-dynamic';
