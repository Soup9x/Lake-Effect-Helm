import { publicRoute } from '@/lib/api/handler';
import { db } from '@/lib/db/client';

/**
 * Liveness and database reachability.
 *
 * Public, and deliberately says almost nothing: version numbers, migration
 * state and connection details are reconnaissance. "ok" plus a timestamp is
 * what a load balancer needs.
 */
export const GET = publicRoute(async () => {
  let database: 'ok' | 'unreachable' = 'unreachable';
  try {
    await db('app')`SELECT 1`;
    database = 'ok';
  } catch {
    database = 'unreachable';
  }

  return { status: database === 'ok' ? 'ok' : 'degraded', database, time: new Date().toISOString() };
});

export const dynamic = 'force-dynamic';
