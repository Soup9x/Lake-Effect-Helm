/**
 * Identity for server components.
 *
 * The API layer resolves identity from a NextRequest. A React Server Component
 * has no request object, so this is the equivalent for the page render path —
 * and it is the same shape, deliberately: the tenant is checked against the
 * user's actual memberships here, and then checked AGAIN by
 * helm.set_session_context() from the membership row, which is what actually
 * enforces it.
 *
 * The tenant selection differs in one way. The API takes `X-Helm-Tenant`
 * because an API client sends headers; a browser navigating between pages sends
 * cookies, so the switcher writes one. A cookie is a client-controlled value —
 * which is fine, because it is only ever a *request* for a tenant, and a
 * request for one the user does not belong to is refused here and refused again
 * by the database.
 */
import { cookies } from 'next/headers';
import { withoutTenantContext } from '../db/client';
import { getSessionUser } from './session';

export const TENANT_COOKIE = 'helm_tenant';

export interface TenantMembership {
  tenantId: string;
  tenantName: string;
  roleKey: string;
  roleName: string;
  orgScopeAll: boolean;
}

export interface ServerIdentity {
  actorId: string;
  actorType: 'user';
  email: string;
  name: string;
  tenantId: string;
  tenantName: string;
  roleKey: string;
  /** Every tenant this user may switch to. Drives the client switcher. */
  memberships: TenantMembership[];
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super('not authenticated');
    this.name = 'NotAuthenticatedError';
  }
}

export class NoMembershipError extends Error {
  constructor() {
    super('your account has no active tenant membership');
    this.name = 'NoMembershipError';
  }
}

interface MembershipRow {
  tenant_id: string;
  tenant_name: string;
  role_key: string;
  role_name: string;
  org_scope_all: boolean;
}

/**
 * Resolve the signed-in user and the tenant they are looking at.
 *
 * Throws rather than redirecting, so the layout decides what an unauthenticated
 * render looks like. A helper that redirected would make this untestable and
 * would hide the difference between "not signed in" (re-auth helps) and "no
 * membership" (it does not).
 */
export async function getServerIdentity(): Promise<ServerIdentity> {
  const user = await getSessionUser();
  if (!user) throw new NotAuthenticatedError();

  // app_role is global reference data with no RLS — the policies in 0200 name
  // its keys directly, so it has to be readable before any context exists. The
  // join is what turns "tier3" into "Tier 3 Engineer" in the switcher.
  const rows = await withoutTenantContext(
    (tx) => tx<MembershipRow[]>`
      SELECT m.tenant_id, m.tenant_name, m.role_key, r.name AS role_name, m.org_scope_all
      FROM helm.memberships_for_user(${user.id}::uuid) m
      JOIN app_role r ON r.key = m.role_key
      ORDER BY m.tenant_name
    `,
  );

  if (rows.length === 0) throw new NoMembershipError();

  const memberships: TenantMembership[] = rows.map((r) => ({
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    roleKey: r.role_key,
    roleName: r.role_name,
    orgScopeAll: r.org_scope_all,
  }));

  const requested = (await cookies()).get(TENANT_COOKIE)?.value;
  // An unrecognised cookie — a stale one from a revoked membership, or one
  // somebody typed — falls back to the first tenant rather than erroring. The
  // API is stricter because a wrong tenant in an API call is a bug worth
  // surfacing; in a browser it is a person whose access changed.
  const active =
    memberships.find((m) => m.tenantId === requested) ?? memberships[0]!;

  return {
    actorId: user.id,
    actorType: 'user',
    email: user.email,
    name: user.name ?? user.email,
    tenantId: active.tenantId,
    tenantName: active.tenantName,
    roleKey: active.roleKey,
    memberships,
  };
}

/** The shape withTenant() and the service layer expect. */
export function actorOf(identity: ServerIdentity): {
  tenantId: string;
  actorId: string;
  actorType: 'user';
} {
  return { tenantId: identity.tenantId, actorId: identity.actorId, actorType: 'user' };
}
