import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import {
  createServiceAccount,
  listGrantableRoles,
  listServiceAccounts,
} from '@/lib/auth/service-accounts';

/**
 * Service accounts: machine identities that outlive the person who set them up.
 *
 * GET lists them with the roles the caller may grant. POST creates one. The
 * authority rules — user:write, nobody grants above their own rank, scope
 * stays inside the creator's — are in helm.create_service_account() (0760);
 * what the route adds is a clear 400 for a malformed body.
 */
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullable().optional(),
    roleKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    orgScopeAll: z.boolean().default(false),
    orgScope: z.array(z.guid()).max(200).default([]),
  })
  .refine((v) => v.orgScopeAll !== (v.orgScope.length > 0), {
    message: 'give either tenant-wide scope or at least one organisation, not both and not neither',
    path: ['orgScope'],
  });

export const GET = tenantRoute(
  async ({ tx }) => {
    const [accounts, roles] = await Promise.all([listServiceAccounts(tx), listGrantableRoles(tx)]);
    return { accounts, roles };
  },
  { permissions: ['user:read'] },
);

export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    if (identity.method === 'api_token') {
      throw ApiError.forbidden('a service account cannot be created by a request that authenticated with a token');
    }
    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('a name, a role, and tenant-wide scope or a list of organisations', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });

    const id = await createServiceAccount(tx, body);
    const account = (await listServiceAccounts(tx)).find((a) => a.id === id);
    return { account };
  },
  { permissions: ['user:write'] },
);

export const dynamic = 'force-dynamic';
