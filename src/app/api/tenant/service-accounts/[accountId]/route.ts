import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { setServiceAccountDisabled } from '@/lib/auth/service-accounts';

/**
 * PATCH /api/tenant/service-accounts/:accountId — disable or enable.
 *
 * Disabling takes effect on the account's next request: the token lookup
 * reports the subject disabled and the bearer path refuses. There is no
 * DELETE; the audit log names the account and a name that resolves to nothing
 * is a hole in the record.
 */
const schema = z.object({ disabled: z.boolean() });

export const PATCH = tenantRoute(
  async ({ tx, request, params }) => {
    const accountId = z.guid().safeParse(params.accountId);
    if (!accountId.success) throw ApiError.notFound('no such service account');
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('send { "disabled": true | false }');
      return result.data;
    });
    const changed = await setServiceAccountDisabled(tx, accountId.data, body.disabled);
    if (!changed) throw ApiError.notFound('no such service account');
    return { disabled: body.disabled };
  },
  { permissions: ['user:write'] },
);

export const dynamic = 'force-dynamic';
