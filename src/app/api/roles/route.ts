import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { createRole, listPermissions, listRoles, newRoleSchema } from '@/lib/roles/catalogue';

/** GET — the built-in and custom roles, and the permissions they are built from. */
export const GET = tenantRoute(
  async ({ tx }) => {
    const [roles, permissions] = await Promise.all([listRoles(tx), listPermissions(tx)]);
    return { roles, permissions };
  },
  { permissions: ['user:read'] },
);

/** POST — define a custom role. The database refuses anything beyond the caller's own reach. */
export const POST = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = newRoleSchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('a name, an access level, MSP staff or client, and permissions', { issues: zodIssues(result.error) });
      return result.data;
    });
    const key = await createRole(tx, body);
    return { key };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
