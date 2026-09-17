/**
 * The route handler wrapper.
 *
 * This is the single most important file in the API layer, and its job is to
 * make one failure mode impossible: a route that queries tenant data without
 * first establishing the RLS session context.
 *
 * The defence is structural rather than procedural. A handler written with
 * `tenantRoute()` is *given* a transaction that already has the context set; it
 * is never given a pool, a connection, or any way to reach one. Forgetting the
 * context is not a mistake you can make here — there is no code path that
 * reaches the database without it.
 *
 * Everything else the wrapper does — request ids, error mapping, audit
 * correlation — follows from having one place all requests pass through.
 */
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { withTenant, type DbRole, type HelmTx } from '../db/client';
import type { ResolvedSessionContext } from '../db/context';
import { SecretAccessDeniedError, StaleSecretVersionError } from '../secrets/errors';
import { HelmCryptoError } from '../crypto/errors';
import { ApiError, toErrorBody, type ErrorCode } from './errors';
import { resolveIdentity, type RequestIdentity } from '../auth/identity';
import { installSessionResolver } from '../auth/bootstrap';

export interface RouteContext {
  /** Tenant-scoped transaction. The only database handle a route ever sees. */
  tx: HelmTx;
  /** Role, rank, scope and permissions as the DATABASE resolved them. */
  session: ResolvedSessionContext;
  /** How this request authenticated. */
  identity: RequestIdentity;
  request: NextRequest;
  requestId: string;
  /** Path parameters, already awaited. */
  params: Record<string, string>;
}

export type RouteHandler<T> = (ctx: RouteContext) => Promise<T>;

export interface TenantRouteOptions {
  /**
   * Permissions the actor must hold. Checked before the handler body runs.
   *
   * This is a fast fail and a clear error message, NOT the security boundary —
   * that is RLS and the SECURITY DEFINER functions, which run regardless of
   * what is declared here. A route that forgets to declare a permission is
   * still safe; it just returns an uglier error.
   */
  permissions?: string[];
  /** Minimum role rank. Same caveat as `permissions`. */
  minRoleRank?: number;
  role?: DbRole;
}

/** Next.js 15+ passes params as a promise. */
type RouteArgs = { params?: Promise<Record<string, string>> };

/**
 * Wrap a handler that needs tenant data.
 *
 * Failure ordering matters and is deliberate: authenticate, then open the
 * context, then check declared permissions, then run. An unauthenticated caller
 * never reaches the database at all.
 */
export function tenantRoute<T>(
  handler: RouteHandler<T>,
  options: TenantRouteOptions = {},
): (request: NextRequest, args?: RouteArgs) => Promise<Response> {
  return async (request: NextRequest, args?: RouteArgs) => {
    const requestId = request.headers.get('x-request-id') ?? randomUUID();

    try {
      // Install the session resolver before resolving identity.
      //
      // Registration used to happen as a side effect of importing
      // auth/config.ts, which only runs when the /api/auth route module is
      // loaded — so a request that reached any other route first found no
      // resolver and failed with a bare 500. Idempotent and memoised, so this
      // costs one boolean check per request after the first.
      await installSessionResolver();

      const identity = await resolveIdentity(request);
      const params = args?.params ? await args.params : {};

      const result = await withTenant(
        {
          tenantId: identity.tenantId,
          actorId: identity.actorId,
          actorType: identity.actorType,
          requestId,
          ...(identity.ip ? { ip: identity.ip } : {}),
          ...(identity.userAgent ? { userAgent: identity.userAgent } : {}),
          ...(identity.apiTokenId ? { apiTokenId: identity.apiTokenId } : {}),
        },
        async (tx, session) => {
          assertPermitted(session, options);
          return handler({ tx, session, identity, request, requestId, params });
        },
        options.role ? { role: options.role } : {},
      );

      // A handler that built its own Response — a file download, a redirect —
      // gets it back untouched. Without this it is JSON-serialised, and a
      // Response has no enumerable own properties, so the caller receives the
      // two bytes `{}` and a 200. Silent, and exactly the shape of bug that
      // reaches production: the status is right and the body is empty.
      if (result instanceof Response) {
        result.headers.set('x-request-id', requestId);
        return result;
      }

      return json(result, 200, requestId);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}

/**
 * Wrap a handler that must NOT have a tenant context: health checks, login,
 * anything pre-authentication.
 *
 * Named to be conspicuous. It hands the handler no database access at all — a
 * public route that needs to read tenant data is a design error, not something
 * to unlock with a flag.
 */
export function publicRoute<T>(
  handler: (request: NextRequest, requestId: string) => Promise<T>,
): (request: NextRequest) => Promise<Response> {
  return async (request: NextRequest) => {
    const requestId = request.headers.get('x-request-id') ?? randomUUID();
    try {
      const result = await handler(request, requestId);
      // Same pass-through as tenantRoute: a handler that built its own Response
      // must not be JSON-serialised into an empty object.
      if (result instanceof Response) {
        result.headers.set('x-request-id', requestId);
        return result;
      }
      return json(result, 200, requestId);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}

/**
 * A Postgres `insufficient_privilege` (SQLSTATE 42501).
 *
 * Matched structurally rather than with an instanceof: postgres.js does not
 * export its error class, and a duck-typed check here is more robust than
 * reaching into the driver's internals for one that may be renamed.
 */
function isInsufficientPrivilege(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '42501'
  );
}

function assertPermitted(session: ResolvedSessionContext, options: TenantRouteOptions): void {
  if (options.minRoleRank !== undefined && session.roleRank < options.minRoleRank) {
    throw ApiError.forbidden('your role does not permit this operation');
  }
  for (const permission of options.permissions ?? []) {
    if (!session.permissions.includes(permission)) {
      throw ApiError.forbidden(`missing permission: ${permission}`);
    }
  }
}

export function json(body: unknown, status: number, requestId: string): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: body === undefined ? 204 : status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': requestId,
      // Belt and braces with next.config.ts: a revealed secret must never be
      // written to a browser or proxy cache.
      'cache-control': 'no-store, max-age=0',
    },
  });
}

/**
 * Map a thrown value to a response.
 *
 * Domain errors from the secret engine carry meaning the client needs — most
 * importantly whether a step-up prompt would help. Everything else collapses to
 * a bare 500 carrying only the request id, which is enough to find the real
 * error in the server log and nothing more.
 */
export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) {
    return json(toErrorBody(error, requestId), error.status, requestId);
  }

  if (error instanceof SecretAccessDeniedError) {
    const api = mapSecretDenial(error);
    return json(toErrorBody(api, requestId), api.status, requestId);
  }

  if (error instanceof StaleSecretVersionError) {
    return json(
      toErrorBody(
        ApiError.conflict('this secret changed while you were working on it; reload and retry'),
        requestId,
      ),
      409,
      requestId,
    );
  }

  // A refusal raised by the database — a policy that matched nothing, or a
  // SECURITY DEFINER function that checked a permission and said no — is a 403,
  // not a fault. Without this every such guard surfaced as a bare 500 with a
  // stack trace in the log, which reads as "Helm is broken" rather than "you
  // may not do that". Routes that want a more specific message still translate
  // it themselves inside the handler; this is the floor, not the ceiling.
  if (isInsufficientPrivilege(error)) {
    return json(
      toErrorBody(
        ApiError.forbidden(
          (error as { message?: string }).message?.replace(/^helm: /, '') ??
            'your role does not permit this operation',
        ),
        requestId,
      ),
      403,
      requestId,
    );
  }

  if (error instanceof HelmCryptoError) {
    // Decryption failures are operational faults, not client mistakes. The code
    // is safe to expose (it names a class of failure, not any material) and
    // tells an operator where to look.
    console.error(`[${requestId}] crypto failure`, { code: error.code, cause: error.cause });
    return json(
      toErrorBody(new ApiError('internal', 'the secret could not be decrypted'), requestId),
      500,
      requestId,
    );
  }

  console.error(`[${requestId}] unhandled error`, error);
  return json(
    toErrorBody(new ApiError('internal', 'internal error'), requestId),
    500,
    requestId,
  );
}

/**
 * Secret refusals carry the audit event id, which is deliberate: when a
 * technician says "it says I can't see this", support answers with one audit
 * lookup instead of a log trawl.
 *
 * The `not_found` case must stay indistinguishable from a genuinely missing
 * secret — see errors.ts.
 */
function mapSecretDenial(error: SecretAccessDeniedError): ApiError {
  const details = { auditEventUid: error.auditEventUid };

  switch (error.reason) {
    case 'not_found':
      return ApiError.notFound();
    case 'step_up_required':
      return new ApiError(
        'step_up_required',
        're-authentication is required to view this credential',
        details,
      );
    case 'reason_required':
      return new ApiError(
        'reason_required',
        'a justification of at least 10 characters is required to view this credential',
        details,
      );
    case 'insufficient_role_rank':
    case 'missing_permission':
    case 'export_not_permitted':
      return new ApiError('forbidden', 'your role does not permit viewing this credential', details);
    case 'purpose_not_permitted_for_actor':
    case 'not_an_integration_credential':
    case 'not_in_an_approved_export':
      // Only a machine identity can hit these: its reveal purposes are pinned,
      // and for 'integration' and 'export' the scope is re-derived from the
      // database. A human seeing one means a service account token is being
      // replayed somewhere it does not belong, which is worth saying plainly to
      // whoever is holding it.
      return new ApiError(
        'forbidden',
        'this credential is outside what this machine identity may decrypt',
        details,
      );
    case 'autofill_not_permitted_for_sensitivity':
      return new ApiError(
        'forbidden',
        'this credential is too sensitive to be auto-filled; open it in Helm instead',
        details,
      );
    case 'no_such_version':
      return ApiError.notFound('no such version of this credential');
    case 'key_destroyed':
      return new ApiError(
        'internal',
        'the encryption key for this credential has been destroyed; it cannot be recovered',
        details,
      );
    default: {
      // Exhaustiveness: a new denial reason added to the SQL API without a
      // mapping here fails the build rather than silently becoming a 500.
      const exhaustive: never = error.reason;
      return new ApiError('forbidden', `access denied: ${String(exhaustive)}`, details);
    }
  }
}

/** Parse and validate a JSON body, or throw a 400 that says what was wrong. */
export async function readJson<T>(
  request: NextRequest,
  parse: (value: unknown) => T,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw ApiError.invalid('request body is not valid JSON');
  }
  return parse(raw);
}

export type { ErrorCode };
