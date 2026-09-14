/**
 * Database access.
 *
 * Four roles, four pools. The separation is the point: a bug in the request
 * path cannot reach the auth token store, and nothing in the request path can
 * write a key. See docs/architecture/01-security-model.md §6.
 *
 * The only supported way to touch tenant data is withTenant(), which opens a
 * transaction, establishes the RLS session context inside it, and guarantees
 * the context dies with the transaction.
 */
import postgres from 'postgres';
import {
  parseResolvedContext,
  type ResolvedSessionContext,
  type SessionContextRequest,
} from './context';

/**
 * postgres.js parameterises Sql by a map of custom type parsers. Helm registers
 * none, so the default empty map applies — spelled `{}` because that is
 * literally postgres.js's default type argument, and anything "tidier"
 * (Record<string, never>, Record<string, unknown>) fails to unify with it.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type NoCustomTypes = {};

export type HelmSql = postgres.Sql<NoCustomTypes>;
export type HelmTx = postgres.TransactionSql<NoCustomTypes>;

export type DbRole = 'app' | 'auth' | 'keyAdmin' | 'auditor';

const ROLE_ENV: Record<DbRole, string> = {
  app: 'DATABASE_URL',
  auth: 'DATABASE_URL_AUTH',
  keyAdmin: 'DATABASE_URL_KEY_ADMIN',
  auditor: 'DATABASE_URL_AUDITOR',
};

const pools = new Map<DbRole, HelmSql>();

function baseOptions(): postgres.Options<NoCustomTypes> {
  return {
    max: Number(process.env.DATABASE_POOL_MAX ?? 20),
    idle_timeout: 30,
    connect_timeout: 10,
    connection: {
      // Every request holds a connection for the duration of its transaction
      // (SET LOCAL requires it), so one runaway query starves the pool.
      // Delivered as a startup parameter so it applies to every session.
      statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 15_000),
      // Shows up in pg_stat_activity and the server log; worth having when
      // four roles connect to the same database.
      application_name: 'lake-effect-helm',
    },
    onnotice: () => {},
  };
}

export function db(role: DbRole = 'app'): HelmSql {
  const existing = pools.get(role);
  if (existing) return existing;

  const url = process.env[ROLE_ENV[role]];
  if (!url) {
    throw new Error(
      `${ROLE_ENV[role]} is not set. Helm uses a separate database role per ` +
      `subsystem; see .env.example.`,
    );
  }
  const pool = postgres(url, baseOptions());
  pools.set(role, pool);
  return pool;
}

/** Register a pool directly. Used by tests and by unusual deployments. */
export function registerPool(role: DbRole, pool: HelmSql): void {
  pools.set(role, pool);
}

export async function closeAllPools(): Promise<void> {
  const closing = [...pools.values()].map((p) => p.end({ timeout: 5 }));
  pools.clear();
  await Promise.all(closing);
}

/**
 * Run work inside a tenant-scoped transaction.
 *
 * Everything that reads or writes tenant data goes through here. Three
 * properties, each of which a hand-rolled version tends to lose:
 *
 *  1. The context is established INSIDE the transaction, so `SET LOCAL`
 *     actually survives to the queries that need it, and evaporates at COMMIT.
 *     helm.set_session_context() refuses to run outside a transaction, which
 *     turns "forgot to open one" into an immediate error rather than a
 *     connection that silently sees nothing.
 *
 *  2. The context cannot leak to the next request on a recycled connection,
 *     because transaction-local settings are discarded on COMMIT or ROLLBACK.
 *
 *  3. The RESOLVED context is handed to the callback. Code downstream reads the
 *     actor's real role and permissions rather than whatever the caller
 *     believed them to be.
 */
export async function withTenant<T>(
  request: SessionContextRequest,
  fn: (tx: HelmTx, ctx: ResolvedSessionContext) => Promise<T>,
  options: { role?: DbRole } = {},
): Promise<T> {
  const pool = db(options.role ?? 'app');

  return pool.begin(async (tx) => {
    const [row] = await tx<{ ctx: Parameters<typeof parseResolvedContext>[0] }[]>`
      SELECT helm.set_session_context(
        ${request.tenantId}::uuid,
        ${request.actorId}::uuid,
        ${request.actorType ?? 'user'}::actor_type,
        ${request.requestId ?? null},
        ${request.ip ?? null}::inet,
        ${request.userAgent ?? null},
        ${request.apiTokenId ?? null}::uuid
      ) AS ctx
    `;

    if (!row) {
      // set_session_context either returns a row or raises; a missing row means
      // something replaced the function.
      throw new Error('helm.set_session_context returned no context');
    }

    return fn(tx as HelmTx, parseResolvedContext(row.ctx));
  }) as Promise<T>;
}

/**
 * Escape hatch for work that legitimately has no tenant: login, provisioning,
 * cross-tenant platform administration.
 *
 * Named to be conspicuous in review. Anything reading tenant data through this
 * sees nothing, because every policy fails closed without a context — which is
 * the intended outcome, not a bug to work around by adding a bypass.
 */
export async function withoutTenantContext<T>(
  fn: (tx: HelmTx) => Promise<T>,
  options: { role?: DbRole } = {},
): Promise<T> {
  const pool = db(options.role ?? 'app');
  return pool.begin(async (tx) => fn(tx as HelmTx)) as Promise<T>;
}
