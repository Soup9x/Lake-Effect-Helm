/**
 * The tenant-wide facts the settings page states: who the tenant is, which
 * keys protect it, and which identities the background jobs run as.
 */
import type { HelmTx } from '../db/client';

export interface KeyRow {
  generation: number;
  status: string;
  wrap_provider: string;
  kek_id: string;
  host_held_kek: boolean;
  development_key: boolean;
  activated_at: Date | null;
}

export interface WorkerRow {
  id: string; name: string; role_key: string;
  allowed_reveal_purposes: string[] | null; disabled_at: Date | null;
}



export interface TenantSummary {
  name: string;
  slug: string;
  /**
   * Mirrors the routes' `tenant:write` gate so a control is only offered to
   * somebody it would work for. Named for the GRANT rather than for one of its
   * uses: the rename form and the default sidebar are two cards reading one
   * permission.
   */
  can_write_tenant: boolean;
}

/** Every data key generation, with where its KEK lives. */
export function listKeyCustody(tx: HelmTx): Promise<KeyRow[]> {
  return tx<KeyRow[]>`SELECT * FROM helm.key_custody()`;
}

/** The system service accounts: what each may decrypt is fixed by trigger. */
export function listSystemWorkers(tx: HelmTx): Promise<WorkerRow[]> {
  return tx<WorkerRow[]>`
    SELECT id, name, role_key, allowed_reveal_purposes, disabled_at
    FROM service_account WHERE is_system ORDER BY name
  `;
}

/**
 * The current tenant. tenant_rls_select restricts this to one row, so there is
 * no predicate and adding one would imply the policy were optional.
 */
export async function readTenantSummary(tx: HelmTx, actorId: string): Promise<TenantSummary | null> {
  const [row] = await tx<TenantSummary[]>`
    SELECT t.name, t.slug,
           EXISTS (SELECT 1 FROM membership m
                   JOIN role_permission rp ON rp.role_key = m.role_key
                   WHERE m.user_id = ${actorId}::uuid
                     AND rp.permission_key = 'tenant:write') AS can_write_tenant
    FROM tenant t
  `;
  return row ?? null;
}
