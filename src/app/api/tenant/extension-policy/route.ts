import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { readExtensionPolicy, writeExtensionPolicy } from '@/lib/extension/policy';

const schema = z.object({ requireLock: z.boolean() });

/**
 * GET /api/tenant/extension-policy — this MSP's browser extension rules (1300).
 * PUT — change them (user:write, from a signed-in Helm tab;
 * helm.set_extension_policy checks the permission again and writes the audit
 * row).
 *
 * Takes effect on every paired browser's next request.
 */
export const GET = tenantRoute(async ({ tx }) => ({ policy: await readExtensionPolicy(tx) }));

export const PUT = tenantRoute(
  async ({ tx, request, identity }) => {
    if (identity.method === 'api_token') {
      throw ApiError.forbidden('change the browser extension rules from a signed-in Helm tab');
    }
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid browser extension settings', { issues: zodIssues(result.error) });
      return result.data;
    });
    await writeExtensionPolicy(tx, body);
    return { policy: await readExtensionPolicy(tx) };
  },
  { permissions: ['user:write'] },
);

export const dynamic = 'force-dynamic';
