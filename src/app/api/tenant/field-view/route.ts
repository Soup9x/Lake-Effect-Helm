import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { fieldViewPolicySchema, readFieldViewPolicy, writeFieldViewPolicy } from '@/lib/field/policy';

/**
 * GET /api/tenant/field-view — this MSP's Field view (phone) settings (1250).
 * PUT — change them (tenant:write; helm.set_field_view_policy checks it again
 * and writes the audit row).
 *
 * The idle and absolute limits apply to every phone session from its next
 * request, enforced by the sign-in role.
 */
export const GET = tenantRoute(async ({ tx }) => ({ policy: await readFieldViewPolicy(tx) }));

export const PUT = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = fieldViewPolicySchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid Field view settings', { issues: zodIssues(result.error) });
      return result.data;
    });
    await writeFieldViewPolicy(tx, body);
    return { policy: await readFieldViewPolicy(tx) };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
