/**
 * Local sign-in: the path that still works when Entra does not.
 *
 * This deliberately sits OUTSIDE Auth.js. Auth.js's Credentials provider forces
 * `strategy: 'jwt'`, and Helm chose database sessions on purpose (auth/config.ts)
 * because a JWT cannot be revoked before it expires and "this technician left,
 * cut their access now" is a routine MSP event. So local login writes the same
 * `auth_session` row the Entra adapter writes, and the route sets the same
 * cookie Auth.js reads.
 *
 * The consequence is the point: once established, a local session and an SSO
 * session are the same object. One session table, one cookie, one resolver, one
 * revocation story. Nothing downstream — not the API layer, not RLS, not the
 * audit log — can tell which door somebody came through, and nothing downstream
 * needs to.
 *
 * Runs on the `helm_auth` pool throughout. helm_app cannot execute any of the
 * functions below and cannot read a password hash by any path; that separation
 * is asserted by a guard in db/sql/0340_local_authentication.sql.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../db/client';
import {
  checkPasswordPolicy,
  hashPassword,
  isReused,
  needsRehash,
  verifyDummyPassword,
  verifyPassword,
  type PasswordPolicyContext,
} from './password';

/** Every way a sign-in can end. Mirrors auth_attempt.outcome. */
export type LoginOutcome =
  | 'success'
  | 'bad_password'
  | 'no_such_account'
  | 'locked'
  | 'rate_limited'
  | 'disabled';

export interface LoginRequest {
  email: string;
  password: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export type LoginResult =
  | {
      ok: true;
      userId: string;
      sessionToken: string;
      expires: Date;
      /** The password was set by an administrator; make them replace it. */
      mustChange: boolean;
    }
  | {
      ok: false;
      outcome: Exclude<LoginOutcome, 'success'>;
      /** Present only for 'locked'. Shown to the person, never to a stranger. */
      retryAfter?: Date | undefined;
    };

interface ChallengeRow {
  found: boolean;
  user_id: string | null;
  password_phc: string | null;
  must_change: boolean;
  disabled: boolean;
  locked_until: Date | null;
  throttled: boolean;
  account_failures: number;
  address_failures: number;
}

/** Eight hours, matching the SSO session in auth/config.ts. */
const SESSION_MINUTES = 60 * 8;

/**
 * Attempt a local sign-in.
 *
 * The order of operations here is the security property, so it is worth stating
 * plainly:
 *
 *   1. Ask the database for the challenge AND the throttle state in one call,
 *      so there is no arrangement of this code that checks the password first
 *      and the rate limit afterwards.
 *   2. Refuse a throttled or locked attempt WITHOUT hashing. A spray then costs
 *      the attacker a round trip and costs Helm no Argon2 work, which is what
 *      stops the rate limiter from becoming the denial of service.
 *   3. On an unknown address, verify against a dummy hash anyway. Same wall
 *      clock, no enumeration oracle.
 *   4. Record every outcome, including the ones that never reached a password.
 *
 * The caller gets a session token to put in a cookie and nothing else. In
 * particular it never learns whether the address exists.
 */
export async function attemptLocalLogin(request: LoginRequest): Promise<LoginResult> {
  const sql = db('auth');
  const email = request.email.trim().toLowerCase();
  const ip = request.ip ?? null;

  const [challenge] = await sql<ChallengeRow[]>`
    SELECT * FROM helm.local_login_challenge(${email}, ${ip}::inet)
  `;

  // The function returns a row for every address, existent or not. Zero rows
  // means something is wrong with the deployment, not with the credentials.
  if (!challenge) {
    throw new Error('helm.local_login_challenge returned no row');
  }

  const userId = challenge.user_id;

  if (challenge.throttled) {
    await record(sql, email, userId, 'rate_limited', request);
    return { ok: false, outcome: 'rate_limited' };
  }

  if (challenge.locked_until && challenge.locked_until > new Date()) {
    await record(sql, email, userId, 'locked', request);
    return { ok: false, outcome: 'locked', retryAfter: challenge.locked_until };
  }

  // No account, or an account with no local password. Both must cost what a
  // real verification costs and say the same thing.
  if (!challenge.found || !challenge.password_phc) {
    await verifyDummyPassword(request.password);
    await record(sql, email, userId, 'no_such_account', request);
    return { ok: false, outcome: 'no_such_account' };
  }

  const correct = await verifyPassword(request.password, challenge.password_phc);

  if (!correct) {
    await record(sql, email, userId, 'bad_password', request);
    return { ok: false, outcome: 'bad_password' };
  }

  // Correct password, disabled account. Checked AFTER verification on purpose:
  // answering "that account is disabled" to a wrong password would confirm the
  // address exists to somebody who has not proved they own it.
  if (challenge.disabled) {
    await record(sql, email, userId, 'disabled', request);
    return { ok: false, outcome: 'disabled' };
  }

  if (!userId) {
    throw new Error('helm.local_login_challenge matched a credential with no user');
  }

  // The parameters in ARGON2_PARAMS have been raised since this hash was made,
  // and the plaintext is in hand exactly once — now. Failing to upgrade is not
  // a reason to fail the sign-in, so this is deliberately not awaited into the
  // success path's error handling.
  if (needsRehash(challenge.password_phc)) {
    void rehashQuietly(userId, request.password);
  }

  const sessionToken = randomBytes(32).toString('base64url');
  const [session] = await sql<{ create_local_session: Date }[]>`
    SELECT helm.create_local_session(${userId}::uuid, ${sessionToken}, ${SESSION_MINUTES})
  `;
  if (!session) throw new Error('helm.create_local_session returned no row');

  await record(sql, email, userId, 'success', request);

  return {
    ok: true,
    userId,
    sessionToken,
    expires: session.create_local_session,
    mustChange: challenge.must_change,
  };
}

async function record(
  sql: ReturnType<typeof db>,
  email: string,
  userId: string | null,
  outcome: LoginOutcome,
  request: LoginRequest,
): Promise<void> {
  await sql`
    SELECT helm.record_login_attempt(
      ${email}, ${userId}::uuid, ${outcome},
      ${request.ip ?? null}::inet, ${request.userAgent ?? null})
  `;
}

/**
 * Upgrade a hash to current parameters, in the background, swallowing failures.
 *
 * A failed upgrade must not fail the sign-in it is attached to: the person
 * supplied the right password and the old hash still verifies it. The next
 * successful sign-in tries again.
 */
async function rehashQuietly(userId: string, plaintext: string): Promise<void> {
  try {
    const phc = await hashPassword(plaintext);
    await db('auth')`
      SELECT helm.set_local_password(${userId}::uuid, ${phc}, false, NULL, 'parameter upgrade')
    `;
  } catch {
    // Deliberately silent. Logging the failure would be reasonable; logging it
    // HERE, next to a plaintext password in a closure, is how plaintext ends up
    // in a log line.
  }
}

// -----------------------------------------------------------------------------
// Setting a password
// -----------------------------------------------------------------------------

export interface SetPasswordRequest {
  userId: string;
  password: string;
  /** Force a change at next sign-in. True when an administrator set it. */
  mustChange?: boolean;
  /** Who set it, when that is not the owner. */
  setBy?: string | undefined;
  reason?: string | undefined;
  /** Name and email, so the policy can reject a password built from them. */
  context?: PasswordPolicyContext;
  /** Which pool to use. 'auth' during a reset, 'app' for a signed-in change. */
  connection?: 'auth' | 'app';
}

export type SetPasswordResult = { ok: true } | { ok: false; problems: string[] };

/**
 * Validate a candidate password and store it.
 *
 * Policy first, reuse second, hash last — reuse detection costs one Argon2
 * verification per stored history entry, so a password that fails the cheap
 * checks never pays for the expensive ones.
 */
export async function setLocalPassword(request: SetPasswordRequest): Promise<SetPasswordResult> {
  const policy = checkPasswordPolicy(request.password, request.context ?? {});
  if (!policy.ok) {
    return { ok: false, problems: policy.problems };
  }

  const sql = db(request.connection ?? 'auth');

  // The history is readable only on the auth connection. A signed-in person
  // changing their own password goes through the app pool, which cannot read
  // it — so reuse is checked only where it can be, and the SQL function
  // maintains the history either way.
  if ((request.connection ?? 'auth') === 'auth') {
    const [existing] = await sql<{ previous_phc: string[]; password_phc: string }[]>`
      SELECT password_phc, previous_phc FROM local_credential WHERE user_id = ${request.userId}::uuid
    `;

    if (existing) {
      const history = [existing.password_phc, ...existing.previous_phc];
      if (await isReused(request.password, history)) {
        return { ok: false, problems: ['must not be a password you have used recently'] };
      }
    }
  }

  const phc = await hashPassword(request.password);

  await sql`
    SELECT helm.set_local_password(
      ${request.userId}::uuid, ${phc}, ${request.mustChange ?? false},
      ${request.setBy ?? null}::uuid, ${request.reason ?? null})
  `;

  return { ok: true };
}

// -----------------------------------------------------------------------------
// Reset
// -----------------------------------------------------------------------------

/**
 * A reset token, and the two forms it takes.
 *
 * `token` is returned to the caller exactly once and never stored. `sha256` is
 * what the database holds — sha256 rather than Argon2 because the token is 32
 * bytes of CSPRNG output with nothing to brute-force, and a slow hash on the
 * redeem path would only be a lever to exhaust the server with.
 */
export interface IssuedReset {
  resetId: string;
  token: string;
  expiresAt: Date;
}

export interface IssueResetRequest {
  /** Address as typed. Resolved here; an address that does not exist is not an error. */
  email: string;
  origin: 'self' | 'admin';
  /** Required when origin is 'admin'. */
  issuedBy?: string | undefined;
  ttlMinutes?: number;
  ip?: string | undefined;
}

/**
 * Mint a single-use reset token.
 *
 * Returns null when the address has no account — and the CALLER MUST STILL
 * ANSWER THE SAME WAY it would have on success. "If an account exists for that
 * address, a reset has been sent" is not a politeness; a reset form that
 * distinguishes the two is a user-enumeration endpoint that needs no password
 * and no rate limit to be useful.
 *
 * An administrator-issued reset ('admin') is the one that matters during the
 * outage local accounts exist for: it is read down the phone, not emailed,
 * because the mailbox is usually in the same tenant that just went down.
 */
export async function issuePasswordReset(request: IssueResetRequest): Promise<IssuedReset | null> {
  if (request.origin === 'admin' && !request.issuedBy) {
    throw new Error('an administrator-issued reset must say who issued it');
  }

  const sql = db('auth');
  const email = request.email.trim().toLowerCase();

  const [user] = await sql<{ id: string }[]>`
    SELECT id FROM app_user WHERE email = ${email}::citext AND disabled_at IS NULL
  `;
  if (!user) return null;

  const token = randomBytes(32).toString('base64url');
  const digest = createHash('sha256').update(token).digest();
  const ttl = request.ttlMinutes ?? (request.origin === 'admin' ? 60 : 30);

  const [issued] = await sql<{ issue_password_reset: string }[]>`
    SELECT helm.issue_password_reset(
      ${user.id}::uuid, ${digest}, ${request.origin}, ${ttl},
      ${request.issuedBy ?? null}::uuid, ${request.ip ?? null}::inet)
  `;
  if (!issued) throw new Error('helm.issue_password_reset returned no row');

  return {
    resetId: issued.issue_password_reset,
    token,
    expiresAt: new Date(Date.now() + ttl * 60_000),
  };
}

export type RedeemResult =
  | { ok: true; userId: string; email: string; name: string | null }
  | { ok: false; problems: string[] };

/**
 * Redeem a reset token and set the new password.
 *
 * ORDER MATTERS, and the obvious order is wrong. Consuming the token first and
 * validating the password afterwards means somebody who mistypes their new
 * password has burned the code — and, because redemption also deletes every
 * session on the account, has been signed out of the one they were holding. A
 * person locked out with a spent reset code, during the outage local accounts
 * exist for, is the precise failure this feature is supposed to prevent.
 *
 * So: peek at the token to learn whose it is, validate the password fully
 * against policy and history, and only then redeem. A rejected password leaves
 * the token live and the account exactly as it was.
 *
 * This does not weaken the single-use guarantee, which lives in the database
 * and not here: redemption is an UPDATE with `used_at IS NULL` in its
 * predicate, so two simultaneous redemptions produce one winner. A token peeked
 * and then spent by somebody else in between simply fails at the redeem, which
 * is the correct outcome.
 *
 * Redeeming kills every existing session for that user. A password reset means
 * "somebody may have had this account"; leaving a live session open would make
 * the reset cosmetic.
 */
export async function redeemPasswordReset(
  token: string,
  newPassword: string,
  ip?: string,
): Promise<RedeemResult> {
  const sql = db('auth');
  const digest = createHash('sha256').update(token).digest();

  const [peeked] = await sql<{ peek_password_reset: string | null }[]>`
    SELECT helm.peek_password_reset(${digest})
  `;
  const userId = peeked?.peek_password_reset ?? null;

  if (!userId) {
    await recordResetRefusal(sql, ip);
    // One message for expired, already used, and never existed. Distinguishing
    // them tells the holder of a leaked token which of the three it is.
    return { ok: false, problems: ['that reset link is no longer valid'] };
  }

  const [user] = await sql<{ email: string; name: string | null }[]>`
    SELECT email, name FROM app_user WHERE id = ${userId}::uuid
  `;

  // Everything that can reject the new password happens here, while the token
  // is still live and the account is untouched.
  const policy = checkPasswordPolicy(newPassword, {
    email: user?.email ?? '',
    name: user?.name ?? '',
  });
  if (!policy.ok) {
    return { ok: false, problems: policy.problems };
  }

  const [existing] = await sql<{ password_phc: string; previous_phc: string[] }[]>`
    SELECT password_phc, previous_phc FROM local_credential WHERE user_id = ${userId}::uuid
  `;
  if (existing) {
    const history = [existing.password_phc, ...existing.previous_phc];
    if (await isReused(newPassword, history)) {
      return { ok: false, problems: ['must not be a password you have used recently'] };
    }
  }

  // Hash before redeeming, so the ~260ms of Argon2 is not spent inside the
  // window between the token being consumed and the password being written.
  const phc = await hashPassword(newPassword);

  const [redeemed] = await sql<{ redeem_password_reset: string | null }[]>`
    SELECT helm.redeem_password_reset(${digest})
  `;

  // Lost the race: somebody redeemed this token between the peek and here.
  if (!redeemed?.redeem_password_reset) {
    await recordResetRefusal(sql, ip);
    return { ok: false, problems: ['that reset link is no longer valid'] };
  }

  await sql`
    SELECT helm.set_local_password(
      ${userId}::uuid, ${phc}, false, NULL, 'password reset')
  `;

  await sql`
    SELECT helm.record_login_attempt(
      ${user?.email ?? ''}, ${userId}::uuid, 'reset_redeemed', ${ip ?? null}::inet, NULL)
  `;

  return { ok: true, userId, email: user?.email ?? '', name: user?.name ?? null };
}

async function recordResetRefusal(sql: ReturnType<typeof db>, ip?: string): Promise<void> {
  await sql`
    SELECT helm.record_login_attempt(
      ${''}, NULL::uuid, 'reset_refused', ${ip ?? null}::inet, NULL)
  `;
}

/**
 * Compare a token against a stored digest without a timing signal.
 *
 * The lookup in redeemPasswordReset is an indexed equality on the digest, which
 * is already constant in the useful sense — the index tells an attacker nothing
 * about how many leading bytes matched. This exists for callers that have both
 * values in hand and would otherwise reach for `===`.
 */
export function tokenMatches(token: string, storedSha256: Buffer): boolean {
  const digest = createHash('sha256').update(token).digest();
  if (digest.length !== storedSha256.length) return false;
  return timingSafeEqual(digest, storedSha256);
}
