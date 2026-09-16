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
import { dedicatedClient } from './client';

let authInstance: ReturnType<typeof drizzle> | null = null;

/**
 * Drizzle on its OWN `helm_auth` connection, never the shared pool.
 *
 * Sharing was a real bug, not a theoretical one. Drizzle's postgres-js driver
 * installs its own type handling on whichever connection it initialises, and
 * postgres.js settles that per connection on first use — so whichever of
 * Drizzle and the tagged-template queries ran first decided how the OTHER read
 * its data. With Drizzle first, `timestamptz` reached raw queries as a string:
 * sign-in returned 500, and the account lockout compared a string to a Date and
 * silently failed open. See dedicatedClient() in ./client for the full note.
 *
 * Lazy so that importing the auth config does not open a connection at module
 * load — which would make every test and every build step that touches this
 * file require a live database. `next build` collects route configuration by
 * importing every route module, so this laziness is what keeps the image build
 * from needing database credentials.
 */
export function authDrizzle(): ReturnType<typeof drizzle> {
  authInstance ??= drizzle(dedicatedClient('auth'));
  return authInstance;
}

/** Reset between tests. */
export function resetDrizzle(): void {
  authInstance = null;
}
