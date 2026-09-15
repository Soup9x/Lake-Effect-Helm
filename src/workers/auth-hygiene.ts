/**
 * Housekeeping for the local-authentication tables.
 *
 * auth_attempt is a throttling counter, not an audit record. The distinction
 * matters operationally as well as philosophically: audit rows are immutable,
 * hash-chained and partitioned so they can be kept forever, while this table is
 * a rolling window of "who has been failing to sign in lately". Keeping it
 * forever would turn a rate limiter into a permanent log of every address every
 * person ever signed in from — a privacy liability, and a table that grows
 * without bound while only the last fifteen minutes are ever read.
 *
 * Expired reset tokens go the same way. A redeemed or lapsed token is inert,
 * but a row holding its digest is still a row in a table worth stealing.
 *
 * What is NOT pruned here: anything in audit_log. A password change, a reset
 * issued by an administrator and a step-up verification are all audited
 * separately, and those records are permanent.
 */
import { db } from '../lib/db/client';
import type { Job, JobContext, JobResult } from './runtime';

/** How long a throttling row stays useful. The window itself is fifteen minutes. */
const KEEP_DAYS = 30;

export function pruneAuthAttemptsJob(): Job {
  return {
    name: 'auth.prune',
    // Hourly. The table is read on every sign-in but only ever for the last
    // fifteen minutes, so pruning is about size and retention, not latency.
    everyMs: 60 * 60 * 1000,
    lockKey: 0x48_45_4c_4d_07,
    run: pruneAuthAttempts,
  };
}

async function pruneAuthAttempts(ctx: JobContext): Promise<JobResult> {
  const [row] = await db('worker')<{ prune_auth_attempts: string }[]>`
    SELECT helm.prune_auth_attempts(${KEEP_DAYS})
  `;

  const deleted = Number(row?.prune_auth_attempts ?? 0);
  if (deleted === 0) return { idle: true };

  ctx.log.info('pruned sign-in attempts', { deleted, keepDays: KEEP_DAYS });
  return { counts: { deleted } };
}
