import { isIP } from 'node:net';
import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import {
  issueServiceAccountToken,
  listServiceAccountTokens,
  TOKEN_DEFAULT_DAYS,
  TOKEN_MAX_DAYS,
} from '@/lib/auth/service-accounts';

/**
 * A service account's tokens: list, and issue.
 *
 * The token is in the POST response exactly once. Scopes are checked against
 * the ACCOUNT'S role by helm.issue_service_account_token(), not against the
 * caller's permissions: an administrator issuing a token for a tier1 account
 * can give it no more than tier1 has, and no less than they choose.
 *
 * The IP allow-list is exact addresses, matching what tokens.ts enforces; a
 * CIDR would be accepted by the inet type and then never match a request.
 */
const PERMISSION_KEY = /^[a-z_]+:[a-z_:]+$/;

const issueSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.string().regex(PERMISSION_KEY).or(z.literal('*'))).min(1).max(64),
  expiresInDays: z.number().int().min(1).max(TOKEN_MAX_DAYS).default(TOKEN_DEFAULT_DAYS),
  ipAllowlist: z.array(z.string().trim().refine((v) => isIP(v) !== 0, 'not an IP address')).max(32).default([]),
});

export const GET = tenantRoute(
  async ({ tx, params }) => {
    const accountId = z.guid().safeParse(params.accountId);
    if (!accountId.success) throw ApiError.notFound('no such service account');
    return { tokens: await listServiceAccountTokens(tx, accountId.data) };
  },
  { permissions: ['user:read'] },
);

export const POST = tenantRoute(
  async ({ tx, request, params, identity }) => {
    if (identity.method === 'api_token') {
      throw ApiError.forbidden('a token cannot be issued by a request that authenticated with a token');
    }
    const accountId = z.guid().safeParse(params.accountId);
    if (!accountId.success) throw ApiError.notFound('no such service account');

    const body = await readJson(request, (raw) => {
      const result = issueSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid(
          `a name of at most 80 characters, at least one scope, an expiry of 1 to ${TOKEN_MAX_DAYS} days, and IP addresses if any`,
          { issues: zodIssues(result.error) },
        );
      }
      return result.data;
    });

    const scopes = [...new Set(body.scopes)];
    if (scopes.includes('*') && scopes.length > 1) {
      throw ApiError.invalid('"*" means every permission of the role; do not list others with it');
    }

    const issued = await issueServiceAccountToken(tx, {
      serviceAccountId: accountId.data,
      name: body.name,
      scopes,
      expiresInDays: body.expiresInDays,
      ipAllowlist: [...new Set(body.ipAllowlist)],
    });
    return { token: issued.token, id: issued.id, prefix: issued.prefix, expiresAt: issued.expiresAt, scopes };
  },
  { permissions: ['user:write'] },
);

export const dynamic = 'force-dynamic';
