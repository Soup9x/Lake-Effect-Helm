/**
 * The session context every tenant-scoped query runs under.
 *
 * This is the TypeScript mirror of the GUCs described in
 * docs/architecture/01-security-model.md §3. The important property: the
 * application supplies only an *identity* and request metadata. Role, rank,
 * organisation scope and permissions are resolved by the database from the
 * membership row and returned here — a caller cannot assert them.
 */

export type ActorType = 'user' | 'service_account';

/** What the application asks for. */
export interface SessionContextRequest {
  tenantId: string;
  actorId: string;
  actorType?: ActorType;
  /** Correlates application logs with audit rows. Propagate it from the edge. */
  requestId?: string;
  ip?: string;
  userAgent?: string;
  /** Present when the actor authenticated with an API token. */
  apiTokenId?: string;
}

/** What the database says the actor actually is. Authoritative. */
export interface ResolvedSessionContext {
  tenantId: string;
  actorId: string;
  actorType: ActorType;
  actorLabel: string;
  roleKey: string;
  roleRank: number;
  /** '*' means every organisation in the tenant. */
  orgScope: string;
  permissions: readonly string[];
  stepUpVerified: boolean;
  requireStepUp: boolean;
}

/** Shape returned by helm.set_session_context(). */
interface RawResolvedContext {
  tenant_id: string;
  actor_id: string;
  actor_type: ActorType;
  actor_label: string | null;
  role_key: string;
  role_rank: number;
  org_scope: string;
  permissions: string[];
  step_up_verified: boolean;
  require_step_up: boolean;
}

export function parseResolvedContext(raw: RawResolvedContext): ResolvedSessionContext {
  return {
    tenantId: raw.tenant_id,
    actorId: raw.actor_id,
    actorType: raw.actor_type,
    actorLabel: raw.actor_label ?? 'unknown',
    roleKey: raw.role_key,
    roleRank: raw.role_rank,
    orgScope: raw.org_scope,
    permissions: Object.freeze([...raw.permissions]),
    stepUpVerified: raw.step_up_verified,
    requireStepUp: raw.require_step_up,
  };
}

export function hasPermission(ctx: ResolvedSessionContext, permission: string): boolean {
  return ctx.permissions.includes(permission);
}

export function isTenantWide(ctx: ResolvedSessionContext): boolean {
  return ctx.orgScope === '*';
}

/**
 * Whether an organisation is inside the actor's scope.
 *
 * Mirrors helm.org_in_scope() so the UI can grey out an action instead of
 * letting the user click it and receive a 403. It is NOT the security
 * boundary — that is the RLS policy, which runs regardless of what this says.
 */
export function orgInScope(ctx: ResolvedSessionContext, organizationId: string): boolean {
  if (ctx.orgScope === '') return false;
  if (ctx.orgScope === '*') return true;
  return ctx.orgScope.split(',').includes(organizationId);
}
