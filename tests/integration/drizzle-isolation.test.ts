/**
 * Drizzle must not share a connection with the tagged-template queries.
 *
 * Drizzle's postgres-js driver installs its own type handling on whichever
 * connection it initialises, and postgres.js settles that per connection on
 * FIRST USE. Share one client between Drizzle and raw queries and whichever
 * runs first decides how the other one reads its data.
 *
 * When Drizzle won that race, `timestamptz` arrived at raw queries as a string.
 * Two consequences, and the second is the one that matters:
 *
 *   * Sign-in returned 500 on `expires.toISOString()`. Loud, obvious, fixed in
 *     minutes.
 *   * `attemptLocalLogin` compares `locked_until > new Date()` to decide
 *     whether an account is still locked. A string is never greater than a
 *     Date, so that is always false: the account lockout FAILED OPEN, silently,
 *     with nothing in any log.
 *
 * It only happened when something touched the Auth.js adapter before the first
 * local sign-in — which is the ordinary case in any deployment using SSO, and
 * never the case in a test that substitutes the session resolver. That is
 * exactly why this file asserts the ordering explicitly rather than relying on
 * whatever order another suite happens to produce.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUser } from '../../db/schema/identity';
import { authDrizzle, resetDrizzle } from '../../src/lib/db/drizzle';
import { db } from '../../src/lib/db/client';
import { connectPools, disconnectPools, PG, resetDatabase } from './harness';

beforeAll(async () => {
  resetDatabase();
  connectPools();

  // The harness registers pools directly, so no DATABASE_URL_* exists for
  // dedicatedClient() to read. Give it a real one pointing at the same cluster
  // as helm_auth, so this exercises the production code path rather than a
  // substitute. A socket-based dev cluster cannot be expressed as a URL, and
  // there dedicatedClient() falls back to the PG* variables the harness uses.
  if (!PG.host.startsWith('/')) {
    process.env.DATABASE_URL_AUTH = `postgresql://helm_auth@${PG.host}:${PG.port}/${PG.database}`;
  }

  resetDrizzle();
}, 120_000);

afterAll(async () => {
  await disconnectPools();
});

describe('Drizzle and the raw auth pool', () => {
  it('does not hand Drizzle the shared pool', () => {
    // Identity, not behaviour: if these are ever the same object again, every
    // assertion below becomes order-dependent and this file starts passing or
    // failing based on which suite ran first.
    const shared = db('auth');
    const drizzleClient = (authDrizzle() as unknown as { session?: { client?: unknown } }).session?.client;

    expect(drizzleClient).toBeDefined();
    expect(drizzleClient).not.toBe(shared);
  });

  it('leaves timestamptz as a Date on raw queries, even Drizzle-first', async () => {
    // The failing order: Drizzle initialises its connection before any raw
    // query runs. Under the old shared-client arrangement this is what turned
    // every subsequent timestamptz into a string.
    await authDrizzle().select().from(appUser).limit(1);

    const [row] = await db('auth')<{ t: unknown }[]>`SELECT now() AS t`;
    expect(row!.t).toBeInstanceOf(Date);
  });

  it('keeps the lockout comparison meaningful', async () => {
    await authDrizzle().select().from(appUser).limit(1);

    const [row] = await db('auth')<{ locked_until: Date }[]>`
      SELECT now() + interval '10 minutes' AS locked_until
    `;

    // This is the exact expression attemptLocalLogin uses to decide whether an
    // account is still locked. With a string it is always false and the lockout
    // stops existing.
    expect(row!.locked_until > new Date()).toBe(true);
  });

  it('still parses timestamptz when a raw query goes first', async () => {
    // The order that always worked. Asserted anyway, so a future change that
    // fixes one direction by breaking the other is caught.
    const [before] = await db('auth')<{ t: unknown }[]>`SELECT now() AS t`;
    expect(before!.t).toBeInstanceOf(Date);

    await authDrizzle().select().from(appUser).limit(1);

    const [after] = await db('auth')<{ t: unknown }[]>`SELECT now() AS t`;
    expect(after!.t).toBeInstanceOf(Date);
  });
});
