import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import {
  clearTenantDashboardDefault, readTenantDashboardDefault, setTenantDashboardDefault,
} from '@/lib/workspace/queries';
import { layoutSchema } from '@/lib/workspace/layout-schema';

/**
 * The dashboard a colleague starts with before arranging their own (1230).
 *
 * GATED ON tenant:write, like the sidebar default beside it: the existing
 * permission for tenant-wide configuration, which only super_admin holds. The
 * RLS policies on tenant_dashboard_default name the same permission, so the
 * route and the database cannot disagree about who may set everybody's
 * dashboard. GET is open to the tenant because every dashboard renders from it.
 */
export const GET = tenantRoute(async ({ tx }) => readTenantDashboardDefault(tx));

export const PUT = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = layoutSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('a layout of known widget keys', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });
    return setTenantDashboardDefault(
      tx, { widgets: body.widgets, wide: body.wide ?? [] }, identity.actorId,
    );
  },
  { permissions: ['tenant:write'] },
);

export const DELETE = tenantRoute(
  async ({ tx }) => {
    await clearTenantDashboardDefault(tx);
    return readTenantDashboardDefault(tx);
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
