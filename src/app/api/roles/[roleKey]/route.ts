import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { deleteRole, roleInputSchema, updateRole } from '@/lib/roles/catalogue';

const KEY = /^custom_[a-z0-9]{1,34}$/;

/** PUT — change a custom role's name, access level or permissions. Built-in roles are not editable. */
export const PUT = tenantRoute(
  async ({ tx, request, params }) => {
    const key = params.roleKey ?? '';
    if (!KEY.test(key)) throw ApiError.invalid('only custom roles can be changed');
    const body = await readJson(request, (raw) => {
      const result = roleInputSchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('a name, an access level and permissions', { issues: zodIssues(result.error) });
      return result.data;
    });
    await updateRole(tx, key, body);
    return { key };
  },
  { permissions: ['tenant:write'] },
);

/** DELETE — remove a custom role nobody holds. */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const key = params.roleKey ?? '';
    if (!KEY.test(key)) throw ApiError.invalid('only custom roles can be deleted');
    await deleteRole(tx, key);
    return { deleted: key };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
