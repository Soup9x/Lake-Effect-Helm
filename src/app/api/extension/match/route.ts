import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { requireExtensionCaller } from '@/lib/extension/http';
import { matchSite, suggestions } from '@/lib/extension/lookup';
import { siteOf } from '@/lib/extension/site';
import type { ExtensionLookup } from '@/lib/extension/types';

/**
 * POST /api/extension/match — the credentials for the tab the popup opened on.
 *
 * The body is the tab's URL as the browser reported it. POST rather than GET
 * so the address of whatever the technician was looking at stays out of
 * access logs. Metadata only: looking a site up is not opening a credential
 * and writes no audit row, exactly as 0210 decided for autofill.
 */
const schema = z.object({ url: z.string().max(4096) });

export const POST = tenantRoute(async ({ tx, request, identity, session }): Promise<ExtensionLookup> => {
  requireExtensionCaller(identity, session);
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw);
    if (!result.success) throw ApiError.invalid('the tab address');
    return result.data;
  });

  const site = siteOf(body.url);
  // A browser page, a file, an extension page: nothing to match, which is an
  // answer rather than an error.
  const entries = site ? await matchSite(tx, site) : [];

  // Nothing for this site: offer what the person is likely to want instead,
  // in the same round trip, since the popup would ask next anyway.
  return {
    host: site?.host ?? null,
    site: site?.registrableDomain ?? null,
    entries,
    ...(entries.length === 0 ? { suggestions: await suggestions(tx) } : {}),
  };
}, { permissions: ['asset:read'] });

export const dynamic = 'force-dynamic';
