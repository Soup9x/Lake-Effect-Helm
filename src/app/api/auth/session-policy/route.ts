import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { readSessionPolicy, sessionPolicySchema } from '@/lib/auth/session-policy-settings';

/**
 * GET /api/auth/session-policy — this tenant's sign-in and session limits.
 * PUT — change them (tenant:write, the bar every sign-in setting sits behind;
 * helm.set_session_policy checks it again and writes the audit row).
 *
 * A change applies to every session from its next request: a tighter idle
 * timeout ends sessions already idle that long, and a new absolute limit ends
 * sessions already older. "Sign everybody else out" is the separate route for
 * when that is not soon enough.
 */
export const GET = tenantRoute(async ({ tx }) => ({ policy: await readSessionPolicy(tx) }));

export const PUT = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = sessionPolicySchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid session policy', { issues: zodIssues(result.error) });
      }
      return result.data;
    });

    await tx`
      SELECT helm.set_session_policy(
        ${body.idleMinutes}::integer, ${body.absoluteHours}::integer, ${body.stepUpMinutes}::integer,
        ${body.lockoutThreshold}::integer, ${body.lockoutMaxMinutes}::integer,
        ${body.requireLocalTotp}::boolean)
    `;
    return { policy: await readSessionPolicy(tx) };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
