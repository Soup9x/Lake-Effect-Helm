import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import {
  issueMyToken,
  listMyTokens,
  TOKEN_DEFAULT_DAYS,
  TOKEN_MAX_DAYS,
} from '@/lib/auth/api-tokens';

/**
 * Your personal API tokens.
 *
 * GET lists them — prefix, scopes, expiry, last use — and never the token,
 * which does not exist anywhere after the POST that issued it returned.
 *
 * POST issues one. The token is in the response exactly once; the row holds
 * its SHA-256. Everything that makes a token safe to issue is decided in
 * helm.issue_my_api_token(): a person, from a session, scopes the issuer holds
 * at that moment, an expiry within a year. The checks repeated here produce a
 * clearer 4xx before the database is asked, and nothing more — a route that
 * forgot them would still be refused.
 */
const PERMISSION_KEY = /^[a-z_]+:[a-z_:]+$/;

const issueSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** `['*']` for everything the role allows, or a list of permission keys. */
  scopes: z.array(z.string().regex(PERMISSION_KEY).or(z.literal('*'))).min(1).max(64),
  expiresInDays: z.number().int().min(1).max(TOKEN_MAX_DAYS).default(TOKEN_DEFAULT_DAYS),
});

export const GET = tenantRoute(async ({ tx }) => ({ tokens: await listMyTokens(tx) }));

export const POST = tenantRoute(async ({ tx, request, identity, session }) => {
  // Rule 1 of 0750, said at the door. The database refuses as well; this is
  // the version with a sentence that explains itself.
  if (identity.method === 'api_token') {
    throw ApiError.forbidden('a personal token cannot be issued by a request that authenticated with a token');
  }

  const body = await readJson(request, (raw) => {
    const result = issueSchema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid(
        `a name of at most 80 characters, at least one scope, and an expiry of 1 to ${TOKEN_MAX_DAYS} days`,
        { issues: zodIssues(result.error) },
      );
    }
    return result.data;
  });

  // Rule 2: a token narrows. `*` is the whole role; anything else must be a
  // permission the DATABASE resolved for this actor, not one the client named.
  const scopes = [...new Set(body.scopes)];
  if (scopes.includes('*') && scopes.length > 1) {
    throw ApiError.invalid('"*" means every permission; do not list others with it');
  }
  const notHeld = scopes.filter((s) => s !== '*' && !session.permissions.includes(s));
  if (notHeld.length > 0) {
    throw ApiError.invalid(`you do not hold ${notHeld.join(', ')}, so a token cannot carry it`, {
      scopes: notHeld,
    });
  }

  const issued = await issueMyToken(tx, { name: body.name, scopes, expiresInDays: body.expiresInDays });
  return { token: issued.token, id: issued.id, prefix: issued.prefix, expiresAt: issued.expiresAt, scopes };
});

export const dynamic = 'force-dynamic';
