/**
 * Enforcing the session policy (0890) when a session is resolved.
 *
 * Runs on the helm_auth pool, beside the Auth.js adapter that has just read the
 * session, because that is the one role that may touch auth_session. The
 * policy is the strictest across the person's tenants
 * (helm.session_policy_for_user), so a person in two tenants is held to the
 * shorter of two idle timeouts.
 *
 * IDLE is measured from auth_session.last_seen_at, which this moves forward —
 * at most once a minute, so a page that makes ten requests costs one write.
 * ABSOLUTE is measured from created_at, which nothing moves. A session past
 * either is deleted here, so the next request is signed out rather than merely
 * refused, and the person's session list does not show a session nobody holds.
 */
import { db } from '../db/client';

/** How often a live session's last_seen_at is written, at most. */
const TOUCH_EVERY_SECONDS = 60;

export type SessionVerdict = 'live' | 'idle' | 'expired' | 'missing';

export async function enforceSessionPolicy(sessionToken: string): Promise<SessionVerdict> {
  const sql = db('auth');
  const [row] = await sql<{
    idle: boolean; expired: boolean; stale: boolean;
  }[]>`
    SELECT now() - s.last_seen_at > make_interval(mins => p.idle_minutes) AS idle,
           (p.absolute_hours IS NOT NULL
              AND now() - s.created_at > make_interval(hours => p.absolute_hours)) AS expired,
           now() - s.last_seen_at > make_interval(secs => ${TOUCH_EVERY_SECONDS}) AS stale
    FROM auth_session s
    CROSS JOIN LATERAL helm.session_policy_for_user(s.user_id) p
    WHERE s.session_token = ${sessionToken}
  `;
  if (!row) return 'missing';

  if (row.idle || row.expired) {
    await sql`DELETE FROM auth_session WHERE session_token = ${sessionToken}`;
    return row.expired ? 'expired' : 'idle';
  }
  if (row.stale) {
    await sql`UPDATE auth_session SET last_seen_at = now() WHERE session_token = ${sessionToken}`;
  }
  return 'live';
}
