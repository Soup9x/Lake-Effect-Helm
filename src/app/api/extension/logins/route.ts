import { z } from 'zod';
import { actorFor, readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { requireExtensionCaller, requireExtensionToken } from '@/lib/extension/http';
import { saveLogin } from '@/lib/extension/save';
import type { ExtensionSaved } from '@/lib/extension/types';

/**
 * POST /api/extension/logins — save a login from the browser extension: the
 * one the person just signed in with, or one typed into the popup's add form.
 *
 * A standard password, a username and a website, under a client (and one of
 * its sites) or in the person's own vault. Nothing else is settable here, and
 * the database refuses anything but a standard password from an extension
 * token whatever this route says (1180). The response names where it went.
 */
const schema = z.object({
  destination: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('personal') }),
    z.object({
      kind: z.literal('client'),
      organizationId: z.guid(),
      siteId: z.guid().nullable().optional(),
    }),
  ]),
  name: z.string().trim().min(1).max(200),
  username: z.string().trim().max(320).default(''),
  password: z.string().min(1).max(65_536),
  url: z.string().trim().max(2000).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  notes: z.string().trim().max(4000).optional(),
});

export const POST = tenantRoute(async ({ tx, request, identity, session, requestId }): Promise<ExtensionSaved> => {
  requireExtensionToken(identity);
  requireExtensionCaller(identity, session);
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw);
    // Paths only: an issue never carries its input, which here is a password.
    if (!result.success) throw ApiError.invalid('invalid login', { issues: zodIssues(result.error) });
    return result.data;
  });
  return saveLogin(tx, actorFor(identity, requestId), {
    destination: body.destination,
    name: body.name,
    username: body.username,
    password: body.password,
    url: body.url || null,
    tags: body.tags,
    notes: body.notes,
  });
}, { permissions: ['secret:write', 'asset:write'] });

export const dynamic = 'force-dynamic';
