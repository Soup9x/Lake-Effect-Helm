import { tenantRoute } from '@/lib/api/handler';

/**
 * POST /api/auth/session-policy/end-sessions — sign everybody else out.
 *
 * Every session of every person with a membership in this tenant ends, except
 * the caller's own; each of them signs in again on their next request.
 * tenant:write, checked here and again by helm.end_tenant_sessions(), which
 * also writes the audit row.
 */
export const POST = tenantRoute(
  async ({ tx }) => {
    const [row] = await tx<{ end_tenant_sessions: number }[]>`SELECT helm.end_tenant_sessions()`;
    return { ended: row?.end_tenant_sessions ?? 0 };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
