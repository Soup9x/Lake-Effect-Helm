/**
 * Turning an HTTP request into "who is this, in which tenant".
 *
 * Two authentication paths, deliberately kept separate because they have
 * different threat models:
 *
 *   SESSION  — a technician in a browser. Cookie-borne, CSRF-relevant,
 *              step-up-capable.
 *   TOKEN    — an RMM/PSA integration or the browser extension. Bearer,
 *              IP-restrictable, never step-up-capable.
 *
 * What this module does NOT do is decide what the identity may do. It answers
 * "who", and helm.set_session_context() then derives role, rank, scope and
 * permissions from the membership row. An identity resolver that also granted
 * authority would be a place to accidentally grant too much.
 */
import type { NextRequest } from 'next/server';
import { withoutTenantContext } from '../db/client';
import { ApiError } from '../api/errors';
import { bearerFrom, verifyToken, type TokenRejection } from './tokens';
import { getSessionUser } from './session';

export interface RequestIdentity {
  tenantId: string;
  actorId: string;
  actorType: 'user' | 'service_account';
  method: 'session' | 'api_token';
  apiTokenId?: string;
  /** Token scopes, when authenticated by token. Narrows the role's permissions. */
  scopes?: string[];
  ip?: string;
  userAgent?: string;
}

/** Header a browser client sends when the user belongs to more than one tenant. */
const TENANT_HEADER = 'x-helm-tenant';

export async function resolveIdentity(request: NextRequest): Promise<RequestIdentity> {
  const ip = clientIp(request);
  const userAgent = request.headers.get('user-agent') ?? undefined;

  const bearer = bearerFrom(request.headers);
  if (bearer) {
    return resolveTokenIdentity(bearer, ip, userAgent);
  }

  return resolveSessionIdentity(request, ip, userAgent);
}

async function resolveTokenIdentity(
  bearer: string,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<RequestIdentity> {
  // No tenant context yet — this call is what establishes one.
  const result = await withoutTenantContext((tx) => verifyToken(tx, bearer, ip ?? null));

  if (!result.ok) {
    logRejection(result.reason);
    // One flat 401 for every rejection, and a message that names no cause.
    // Even "invalid or expired" invites the reader to infer which, and
    // confirming that a token was real-but-expired is itself information.
    throw ApiError.unauthenticated('invalid API token');
  }

  const { identity } = result;

  // Accounting is best-effort: a failure to record usage must not fail an
  // otherwise valid request.
  void withoutTenantContext((tx) =>
    tx`SELECT helm.record_api_token_use(${identity.tokenId}::uuid, ${ip ?? null}::inet)`,
  ).catch((error: unknown) => {
    console.warn('failed to record API token use', error);
  });

  const actorId = identity.serviceAccountId ?? identity.userId;
  if (!actorId) {
    // The CHECK on api_token guarantees exactly one subject; reaching here means
    // the schema was changed without updating this.
    throw ApiError.unauthenticated('token has no subject');
  }

  return {
    tenantId: identity.tenantId,
    actorId,
    actorType: identity.serviceAccountId ? 'service_account' : 'user',
    method: 'api_token',
    apiTokenId: identity.tokenId,
    scopes: identity.scopes,
    ...(ip ? { ip } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

async function resolveSessionIdentity(
  request: NextRequest,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<RequestIdentity> {
  const user = await getSessionUser();
  if (!user) throw ApiError.unauthenticated();

  const requested = request.headers.get(TENANT_HEADER)?.trim();
  const memberships = await withoutTenantContext(
    (tx) => tx<{ tenant_id: string }[]>`
      SELECT tenant_id FROM helm.memberships_for_user(${user.id}::uuid)
    `,
  );

  if (memberships.length === 0) {
    // Authenticated but with no active membership anywhere: a former employee
    // whose account still exists. 403, not 401 — re-authenticating will not help.
    throw ApiError.forbidden('your account has no active tenant membership');
  }

  const tenantId = selectTenant(memberships.map((m) => m.tenant_id), requested);

  return {
    tenantId,
    actorId: user.id,
    actorType: 'user',
    method: 'session',
    ...(ip ? { ip } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

/**
 * Pick the tenant for this request.
 *
 * A requested tenant must be one the user actually belongs to. Checking here is
 * belt-and-braces — set_session_context() would refuse anyway — but it produces
 * a clear 403 rather than an opaque database exception.
 */
function selectTenant(available: string[], requested: string | undefined): string {
  if (requested) {
    if (!available.includes(requested)) {
      throw ApiError.forbidden('you do not have access to that tenant');
    }
    return requested;
  }

  if (available.length === 1) return available[0]!;

  // Ambiguous rather than guessed. Silently picking the first membership is how
  // a technician ends up writing documentation into the wrong MSP.
  throw ApiError.invalid(
    `you belong to ${available.length} tenants; specify one with the ${TENANT_HEADER} header`,
    { tenants: available },
  );
}

/**
 * The client address.
 *
 * X-Forwarded-For is client-controlled unless a trusted proxy overwrites it, so
 * this is only trustworthy behind one that does. HELM_TRUSTED_PROXY_HOPS says
 * how many trailing entries the infrastructure appends, and we count back from
 * the right — taking the leftmost entry, the common mistake, lets a caller
 * forge any address they like and defeats IP allowlisting entirely.
 */
export function clientIp(request: NextRequest): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = Number(process.env.HELM_TRUSTED_PROXY_HOPS ?? 1);
    const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
    const index = parts.length - hops;
    const candidate = index >= 0 ? parts[index] : parts[0];
    if (candidate) return candidate;
  }
  return request.headers.get('x-real-ip') ?? undefined;
}

function logRejection(reason: TokenRejection): void {
  // Server-side only. Useful for spotting a leaked token being probed; never
  // returned to the caller.
  console.warn(`api token rejected: ${reason}`);
}
