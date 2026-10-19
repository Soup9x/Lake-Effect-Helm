/**
 * Roles as the People screen sees them: the built-in roles, this tenant's
 * custom roles (0830), and the permission catalogue they are built from.
 *
 * Reads run as helm_app under app_role's policy, which already limits them to
 * the built-in rows and this tenant's own. Writes go through
 * helm.create_custom_role / update_custom_role / delete_custom_role, which
 * insist on tenant:write and refuse anything the caller does not hold.
 */
import { z } from 'zod';
import type { HelmTx } from '../db/client';

export interface RoleSummary {
  key: string;
  name: string;
  description: string;
  rank: number;
  isTenantWide: boolean;
  isCustom: boolean;
  permissions: string[];
  /** People and service accounts holding it; a role in use cannot be deleted. */
  holders: number;
}

export interface PermissionInfo {
  key: string;
  category: string;
  description: string;
  mspOnly: boolean;
}

/**
 * The access levels a role can be given, named after the built-in role that
 * sits there. Rank is what row-level security and each credential's minimum
 * level compare against; the permissions decide everything else.
 */
export const ACCESS_LEVELS = [
  { rank: 100, label: 'Super Administrator level', mspStaff: true },
  { rank: 80, label: 'Tier 3 level', mspStaff: true },
  { rank: 60, label: 'Tier 2 level', mspStaff: true },
  { rank: 40, label: 'Tier 1 level', mspStaff: true },
  { rank: 30, label: 'Client Administrator level', mspStaff: false },
  { rank: 20, label: 'Client Read Only level', mspStaff: false },
] as const;

export async function listRoles(tx: HelmTx): Promise<RoleSummary[]> {
  const rows = await tx<{
    key: string; name: string; description: string; rank: number; is_tenant_wide: boolean;
    is_custom: boolean; permissions: string[]; holders: number;
  }[]>`
    SELECT r.key, r.name, r.description, r.rank, r.is_tenant_wide,
           r.tenant_id IS NOT NULL AS is_custom,
           coalesce((SELECT array_agg(rp.permission_key ORDER BY rp.permission_key)
                       FROM role_permission rp WHERE rp.role_key = r.key), '{}') AS permissions,
           ((SELECT count(*) FROM membership m WHERE m.role_key = r.key)
            + (SELECT count(*) FROM service_account s WHERE s.role_key = r.key))::int AS holders
    FROM app_role r
    WHERE r.key NOT LIKE 'system\\_%' AND r.key <> 'api_service'
    ORDER BY (r.tenant_id IS NOT NULL), r.is_tenant_wide DESC, r.rank DESC, r.name
  `;
  return rows.map((r) => ({
    key: r.key, name: r.name, description: r.description, rank: r.rank,
    isTenantWide: r.is_tenant_wide, isCustom: r.is_custom, permissions: r.permissions, holders: r.holders,
  }));
}

export async function listPermissions(tx: HelmTx): Promise<PermissionInfo[]> {
  const rows = await tx<{ key: string; category: string; description: string; msp_only: boolean }[]>`
    SELECT key, category, description, msp_only FROM permission ORDER BY category, key
  `;
  return rows.map((p) => ({ key: p.key, category: p.category, description: p.description, mspOnly: p.msp_only }));
}

/** The roles this caller may assign: rank, scope and every permission within their own (0830). */
export async function grantableRoles(tx: HelmTx) {
  const rows = await tx<{ key: string; name: string; rank: number; is_tenant_wide: boolean; is_custom: boolean }[]>`
    SELECT key, name, rank, is_tenant_wide, is_custom FROM helm.grantable_roles()
  `;
  return rows.map((r) => ({ key: r.key, name: r.name, rank: r.rank, isTenantWide: r.is_tenant_wide, isCustom: r.is_custom }));
}

const permissionKey = z.string().regex(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/, 'not a permission key');

export const roleInputSchema = z.object({
  name: z.string().trim().min(1, 'give the role a name').max(60),
  description: z.string().trim().max(400).default(''),
  rank: z.number().int().min(1).max(100),
  permissions: z.array(permissionKey).max(200),
});
export const newRoleSchema = roleInputSchema.extend({ mspStaff: z.boolean() });

export type RoleInput = z.infer<typeof roleInputSchema>;
export type NewRoleInput = z.infer<typeof newRoleSchema>;

export async function createRole(tx: HelmTx, input: NewRoleInput): Promise<string> {
  const [row] = await tx<{ key: string }[]>`
    SELECT helm.create_custom_role(
      ${input.name}, ${input.description}, ${input.rank}::int, ${input.mspStaff}, ${input.permissions}::text[]
    ) AS key
  `;
  return row!.key;
}

export async function updateRole(tx: HelmTx, key: string, input: RoleInput): Promise<void> {
  await tx`
    SELECT helm.update_custom_role(
      ${key}, ${input.name}, ${input.description}, ${input.rank}::int, ${input.permissions}::text[]
    )
  `;
}

export async function deleteRole(tx: HelmTx, key: string): Promise<void> {
  await tx`SELECT helm.delete_custom_role(${key})`;
}
