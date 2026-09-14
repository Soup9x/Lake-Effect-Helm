/**
 * Drizzle instances over the postgres.js pools.
 *
 * Only the AUTH path uses Drizzle's query builder, because the Auth.js adapter
 * requires it. Everything tenant-scoped goes through `withTenant()` and tagged
 * SQL instead — not out of preference, but because the RLS session context has
 * to be established inside the same transaction, and an ORM that hands out a
 * connection from a pool on demand makes that easy to get wrong.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { db } from './client';

let authInstance: ReturnType<typeof drizzle> | null = null;

/**
 * Drizzle over the `helm_auth` pool.
 *
 * Lazy so that importing the auth config does not open a connection at module
 * load — which would make every test and every build step that touches this
 * file require a live database.
 */
export function authDrizzle(): ReturnType<typeof drizzle> {
  authInstance ??= drizzle(db('auth'));
  return authInstance;
}

/** Reset between tests. */
export function resetDrizzle(): void {
  authInstance = null;
}
