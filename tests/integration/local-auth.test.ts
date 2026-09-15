/**
 * Local sign-in, against the live cluster.
 *
 * These accounts exist so an MSP can reach its clients' credentials when Entra
 * is down, which makes the local login form the single most attractive target
 * in the product: it is the one door that stays open during the outage, and it
 * accepts a guessable secret. So most of what follows is about what it refuses.
 *
 * The properties under test, in the order they matter:
 *
 *   * A wrong password and an address that does not exist are indistinguishable
 *     — in the response AND on the clock.
 *   * Brute force runs into a lockout that an attacker cannot make permanent.
 *   * A reset token works once, kills every existing session, and does not say
 *     why it failed when it fails.
 *   * A local session is the same object an SSO session is, so revocation works
 *     the same way for both.
 *   * No role but helm_auth can read a password hash.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  attemptLocalLogin,
  issuePasswordReset,
  redeemPasswordReset,
  setLocalPassword,
} from '../../src/lib/auth/local';
import { hash as argon2Hash } from '@node-rs/argon2';
import { db } from '../../src/lib/db/client';
import {
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
} from './harness';

const GOOD = 'seventeen purple lanterns';
const ALSO_GOOD = 'nineteen copper doorframes';
const EMAIL = 'admin@northwind.test';

const auth = () => db('auth');

/**
 * One superuser handle for the file. superuserSql() opens a NEW connection on
 * every call and closeAllPools() does not know about them, so calling it per
 * assertion leaks a connection per assertion and eventually exhausts the
 * cluster's slots.
 */
let su: ReturnType<typeof superuserSql>;

/** Wipe every trace of local auth state between tests, as the superuser. */
async function clearLocalAuth(): Promise<void> {
  await su`DELETE FROM auth_attempt`;
  await su`DELETE FROM password_reset`;
  await su`DELETE FROM local_credential`;
  await su`DELETE FROM auth_session`;
  await su`UPDATE app_user SET disabled_at = NULL WHERE id = ${IDS.admin1}::uuid`;
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  su = superuserSql();
});

afterAll(async () => {
  await su.end({ timeout: 5 });
  await disconnectPools();
});

beforeEach(async () => {
  await clearLocalAuth();
});

describe('setting a local password', () => {
  it('stores an argon2id PHC string and nothing resembling the plaintext', async () => {
    const result = await setLocalPassword({ userId: IDS.admin1, password: GOOD });
    expect(result.ok).toBe(true);

    const [row] = await auth()<{ password_phc: string; algorithm: string }[]>`
      SELECT password_phc, algorithm FROM local_credential WHERE user_id = ${IDS.admin1}::uuid
    `;

    expect(row!.algorithm).toBe('argon2id');
    expect(row!.password_phc).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(row!.password_phc).not.toContain(GOOD);
  });

  it('refuses a password that fails policy, and writes nothing', async () => {
    const result = await setLocalPassword({ userId: IDS.admin1, password: 'password123' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.length).toBeGreaterThan(0);

    const [row] = await auth()`SELECT 1 FROM local_credential WHERE user_id = ${IDS.admin1}::uuid`;
    expect(row).toBeUndefined();
  });

  it('refuses a password built out of the account it protects', async () => {
    const result = await setLocalPassword({
      userId: IDS.admin1,
      password: 'northwind administrator',
      context: { email: EMAIL, name: 'Northwind Admin' },
    });
    expect(result.ok).toBe(false);
  });

  it('keeps a bounded history and refuses reuse', async () => {
    await setLocalPassword({ userId: IDS.admin1, password: GOOD });
    await setLocalPassword({ userId: IDS.admin1, password: ALSO_GOOD });

    const reused = await setLocalPassword({ userId: IDS.admin1, password: GOOD });
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.problems[0]).toMatch(/used recently/);

    // Five entries, no more: an unbounded history would make every password
    // change cost an unbounded number of Argon2 verifications.
    for (const candidate of ['alpha windmill cascade', 'bravo windmill cascade',
                             'charlie windmill cascade', 'delta windmill cascade',
                             'echo windmill cascade', 'foxtrot windmill cascade']) {
      await setLocalPassword({ userId: IDS.admin1, password: candidate });
    }

    const [row] = await auth()<{ n: number }[]>`
      SELECT cardinality(previous_phc) AS n FROM local_credential WHERE user_id = ${IDS.admin1}::uuid
    `;
    expect(row!.n).toBe(5);
  });
});

describe('signing in', () => {
  beforeEach(async () => {
    await setLocalPassword({ userId: IDS.admin1, password: GOOD });
  });

  it('accepts the right password and writes a real auth_session row', async () => {
    const result = await attemptLocalLogin({ email: EMAIL, password: GOOD, ip: '198.51.100.7' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The whole design rests on this: a local session is the same row an SSO
    // session is, so revoking one revokes the other the same way.
    const [session] = await auth()<{ user_id: string; expires: Date }[]>`
      SELECT user_id, expires FROM auth_session WHERE session_token = ${result.sessionToken}
    `;
    expect(session!.user_id).toBe(IDS.admin1);
    expect(session!.expires.getTime()).toBeGreaterThan(Date.now());

    const [user] = await auth()<{ last_login_at: Date | null }[]>`
      SELECT last_login_at FROM app_user WHERE id = ${IDS.admin1}::uuid
    `;
    expect(user!.last_login_at).not.toBeNull();
  });

  it('rejects the wrong password without creating a session', async () => {
    const result = await attemptLocalLogin({ email: EMAIL, password: 'not the password' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe('bad_password');

    const rows = await auth()`SELECT 1 FROM auth_session`;
    expect(rows.length).toBe(0);
  });

  it('answers an unknown address the same way, and takes the same time', async () => {
    const startKnown = performance.now();
    const known = await attemptLocalLogin({ email: EMAIL, password: 'wrong guess entirely' });
    const knownMs = performance.now() - startKnown;

    const startUnknown = performance.now();
    const unknown = await attemptLocalLogin({
      email: 'nobody-at-all@northwind.test',
      password: 'wrong guess entirely',
    });
    const unknownMs = performance.now() - startUnknown;

    expect(known.ok).toBe(false);
    expect(unknown.ok).toBe(false);

    // The timing is the assertion. Without the dummy verify, the unknown path
    // returns in about a millisecond and the known path in about 260 — an
    // enumeration oracle readable with a stopwatch over the internet.
    expect(unknownMs).toBeGreaterThan(knownMs / 3);
  });

  it('does not admit a user who has no local password at all', async () => {
    // tech1 is an SSO-only account. It must behave exactly like a nonexistent
    // one, or the form reports which colleagues have break-glass access.
    const result = await attemptLocalLogin({ email: 'tech1@northwind.test', password: GOOD });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome).toBe('no_such_account');
  });

  it('refuses a disabled account that supplies the right password', async () => {
    await su`UPDATE app_user SET disabled_at = now() WHERE id = ${IDS.admin1}::uuid`;

    const result = await attemptLocalLogin({ email: EMAIL, password: GOOD });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome).toBe('disabled');

    const rows = await auth()`SELECT 1 FROM auth_session`;
    expect(rows.length).toBe(0);
  });

  it('records every outcome in the ledger, including the ones that never hashed', async () => {
    await attemptLocalLogin({ email: EMAIL, password: GOOD, ip: '198.51.100.7' });
    await attemptLocalLogin({ email: EMAIL, password: 'wrong', ip: '198.51.100.7' });
    await attemptLocalLogin({ email: 'ghost@northwind.test', password: 'wrong', ip: '198.51.100.8' });

    const rows = await auth()<{ outcome: string; ip: string | null }[]>`
      SELECT outcome, host(ip) AS ip FROM auth_attempt ORDER BY id
    `;
    expect(rows.map((r) => r.outcome)).toEqual(['success', 'bad_password', 'no_such_account']);
    expect(rows[2]!.ip).toBe('198.51.100.8');
  });
});

describe('lockout', () => {
  beforeEach(async () => {
    await setLocalPassword({ userId: IDS.admin1, password: GOOD });
  });

  it('locks the account after five wrong passwords, and refuses the right one', async () => {
    for (let i = 0; i < 5; i += 1) {
      await attemptLocalLogin({ email: EMAIL, password: `wrong guess ${i}`, ip: '203.0.113.5' });
    }

    const [row] = await auth()<{ failed_attempts: number; locked_until: Date | null }[]>`
      SELECT failed_attempts, locked_until FROM local_credential WHERE user_id = ${IDS.admin1}::uuid
    `;
    expect(row!.failed_attempts).toBe(5);
    expect(row!.locked_until).not.toBeNull();

    // The correct password is refused while the lock holds. Anything else makes
    // the lockout theatre.
    const blocked = await attemptLocalLogin({ email: EMAIL, password: GOOD, ip: '203.0.113.5' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.outcome).toBe('locked');
  });

  it('cannot be held open indefinitely by an attacker who keeps knocking', async () => {
    for (let i = 0; i < 5; i += 1) {
      await attemptLocalLogin({ email: EMAIL, password: `wrong guess ${i}`, ip: '203.0.113.5' });
    }

    const [first] = await auth()<{ locked_until: Date }[]>`
      SELECT locked_until FROM local_credential WHERE user_id = ${IDS.admin1}::uuid
    `;

    // Twenty more attempts while already locked. If a refusal Helm issued fed
    // the counter that produced it, this would push the unlock time out and
    // the attacker would have a denial of service against the break-glass
    // account — which is worse than the brute force it was defending against.
    for (let i = 0; i < 20; i += 1) {
      await attemptLocalLogin({ email: EMAIL, password: 'knock', ip: '203.0.113.5' });
    }

    const [after] = await auth()<{ locked_until: Date; failed_attempts: number }[]>`
      SELECT locked_until, failed_attempts FROM local_credential WHERE user_id = ${IDS.admin1}::uuid
    `;
    expect(after!.locked_until.getTime()).toBe(first!.locked_until.getTime());
    expect(after!.failed_attempts).toBe(5);
  });

  it('never locks for longer than fifteen minutes', async () => {
    // Drive the backoff to its ceiling: 5 → 1 min, doubling, capped at 15.
    //
    // The ledger is cleared each round so the per-account rate limit (ten
    // genuine failures in fifteen minutes) does not fire first and mask the
    // backoff; failed_attempts is what the backoff reads, and that is left
    // alone. The lock is cleared so the next attempt reaches a password check
    // rather than bouncing off the lock it just set.
    for (let i = 0; i < 12; i += 1) {
      await su`DELETE FROM auth_attempt`;
      await su`
        UPDATE local_credential SET locked_until = NULL WHERE user_id = ${IDS.admin1}::uuid
      `;
      await attemptLocalLogin({ email: EMAIL, password: `wrong guess ${i}` });
    }

    const [row] = await auth()<{ attempts: number; seconds: string | null }[]>`
      SELECT failed_attempts AS attempts,
             extract(epoch FROM (locked_until - now())) AS seconds
      FROM local_credential WHERE user_id = ${IDS.admin1}::uuid
    `;
    expect(row!.attempts).toBe(12);
    expect(Number(row!.seconds)).toBeGreaterThan(0);
    expect(Number(row!.seconds)).toBeLessThanOrEqual(15 * 60 + 1);
  });

  it('stops answering an account after ten genuine failures in the window', async () => {
    // The lockout and the rate limit are different mechanisms with different
    // jobs: the lockout imposes a wait after five, the rate limit stops
    // answering at all after ten. Clear the lock each round so this measures
    // the second one rather than the first.
    for (let i = 0; i < 10; i += 1) {
      await su`
        UPDATE local_credential SET locked_until = NULL WHERE user_id = ${IDS.admin1}::uuid
      `;
      await attemptLocalLogin({ email: EMAIL, password: `wrong guess ${i}` });
    }

    await su`UPDATE local_credential SET locked_until = NULL WHERE user_id = ${IDS.admin1}::uuid`;
    const refused = await attemptLocalLogin({ email: EMAIL, password: GOOD });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.outcome).toBe('rate_limited');
  });

  it('clears the counter on a successful sign-in', async () => {
    for (let i = 0; i < 3; i += 1) {
      await attemptLocalLogin({ email: EMAIL, password: `wrong guess ${i}` });
    }
    await attemptLocalLogin({ email: EMAIL, password: GOOD });

    const [row] = await auth()<{ failed_attempts: number; locked_until: Date | null }[]>`
      SELECT failed_attempts, locked_until FROM local_credential WHERE user_id = ${IDS.admin1}::uuid
    `;
    expect(row!.failed_attempts).toBe(0);
    expect(row!.locked_until).toBeNull();
  });

  it('throttles a spray across many accounts from one address', async () => {
    // Thirty failures from one host against thirty different addresses. No
    // per-account counter ever reaches its limit; the address counter is what
    // sees this at all.
    for (let i = 0; i < 30; i += 1) {
      await attemptLocalLogin({
        email: `victim-${i}@northwind.test`,
        password: 'spray',
        ip: '203.0.113.99',
      });
    }

    const sprayed = await attemptLocalLogin({
      email: 'victim-30@northwind.test',
      password: 'spray',
      ip: '203.0.113.99',
    });
    expect(sprayed.ok).toBe(false);
    if (!sprayed.ok) expect(sprayed.outcome).toBe('rate_limited');

    // A different address is unaffected: the limit is per source, not global.
    const elsewhere = await attemptLocalLogin({
      email: EMAIL,
      password: GOOD,
      ip: '198.51.100.7',
    });
    expect(elsewhere.ok).toBe(true);
  });

  it('refuses a throttled attempt without spending Argon2 time on it', async () => {
    for (let i = 0; i < 30; i += 1) {
      await attemptLocalLogin({
        email: `victim-${i}@northwind.test`,
        password: 'spray',
        ip: '203.0.113.98',
      });
    }

    const start = performance.now();
    await attemptLocalLogin({ email: EMAIL, password: GOOD, ip: '203.0.113.98' });
    const elapsed = performance.now() - start;

    // Well under one Argon2 verification (~260ms). If the refusal hashed first,
    // the rate limiter would be a lever for exhausting the server rather than
    // a defence against one.
    expect(elapsed).toBeLessThan(100);
  });

  it('lets an administrator clear a lockout without changing the password', async () => {
    for (let i = 0; i < 5; i += 1) {
      await attemptLocalLogin({ email: EMAIL, password: `wrong guess ${i}` });
    }

    // admin2 is in the other tenant; the reach across tenants must be refused
    // before the useful case is allowed. The assertion is on the whole
    // transaction: a statement that raises aborts it, so begin() rethrows at
    // commit even when an inner expectation passed.
    await expect(
      su.begin(async (tx) => {
        await tx`SELECT helm.set_session_context(${IDS.tenant2}::uuid, ${IDS.admin2}::uuid)`;
        await tx`SELECT helm.clear_local_lockout(${IDS.admin1}::uuid, 'not mine to clear')`;
      }),
    ).rejects.toThrow(/not a member of this tenant/);

    await su.begin(async (tx) => {
      await tx`SELECT helm.set_session_context(${IDS.tenant1}::uuid, ${IDS.admin1}::uuid)`;
      await tx`SELECT helm.clear_local_lockout(${IDS.admin1}::uuid, 'fat-fingered it five times')`;
    });

    const result = await attemptLocalLogin({ email: EMAIL, password: GOOD });
    expect(result.ok).toBe(true);
  });

  it('refuses to let a technician without user:write clear a lockout', async () => {
    await expect(
      su.begin(async (tx) => {
        await tx`SELECT helm.set_session_context(${IDS.tenant1}::uuid, ${IDS.tech1}::uuid)`;
        await tx`SELECT helm.clear_local_lockout(${IDS.admin1}::uuid, 'let me in')`;
      }),
    ).rejects.toThrow(/user:write/);
  });
});

describe('password reset', () => {
  beforeEach(async () => {
    await setLocalPassword({ userId: IDS.admin1, password: GOOD });
  });

  it('issues a token whose plaintext is nowhere in the database', async () => {
    const issued = await issuePasswordReset({
      email: EMAIL,
      origin: 'admin',
      issuedBy: IDS.admin1,
    });
    expect(issued).not.toBeNull();

    const [row] = await auth()<{ token_sha256: Buffer; origin: string }[]>`
      SELECT token_sha256, origin FROM password_reset WHERE id = ${issued!.resetId}::uuid
    `;
    expect(row!.origin).toBe('admin');
    expect(row!.token_sha256.equals(createHash('sha256').update(issued!.token).digest())).toBe(true);

    // The token itself must not be recoverable from a database dump.
    const [leak] = await auth()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM password_reset WHERE encode(token_sha256, 'escape') LIKE
        ${'%' + issued!.token.slice(0, 12) + '%'}
    `;
    expect(leak!.n).toBe(0);
  });

  it('returns null for an unknown address rather than an error', async () => {
    // The caller has to answer identically either way; making this a throw
    // would push callers into try/catch shapes that leak the difference.
    const issued = await issuePasswordReset({ email: 'ghost@northwind.test', origin: 'self' });
    expect(issued).toBeNull();
  });

  it('redeems once and only once', async () => {
    const issued = await issuePasswordReset({ email: EMAIL, origin: 'self' });

    const first = await redeemPasswordReset(issued!.token, ALSO_GOOD);
    expect(first.ok).toBe(true);

    const second = await redeemPasswordReset(issued!.token, 'third passphrase entirely');
    expect(second.ok).toBe(false);

    // The new password works, the second attempt changed nothing.
    expect((await attemptLocalLogin({ email: EMAIL, password: ALSO_GOOD })).ok).toBe(true);
  });

  it('invalidates the previous token when a second is issued', async () => {
    const first = await issuePasswordReset({ email: EMAIL, origin: 'self' });
    const second = await issuePasswordReset({ email: EMAIL, origin: 'self' });

    // "Request five resets and use the first one" must not work.
    expect((await redeemPasswordReset(first!.token, ALSO_GOOD)).ok).toBe(false);
    expect((await redeemPasswordReset(second!.token, ALSO_GOOD)).ok).toBe(true);
  });

  it('refuses an expired token', async () => {
    const issued = await issuePasswordReset({ email: EMAIL, origin: 'self' });
    // Backdate both: the row carries CHECK (expires_at > created_at), so an
    // expiry in the past needs an issue time further in the past.
    await su`
      UPDATE password_reset
      SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
      WHERE id = ${issued!.resetId}::uuid
    `;

    expect((await redeemPasswordReset(issued!.token, ALSO_GOOD)).ok).toBe(false);
  });

  it('says the same thing for expired, spent and never-existed', async () => {
    const issued = await issuePasswordReset({ email: EMAIL, origin: 'self' });
    await redeemPasswordReset(issued!.token, ALSO_GOOD);

    const spent = await redeemPasswordReset(issued!.token, 'another passphrase here');
    const fabricated = await redeemPasswordReset(
      randomBytes(32).toString('base64url'),
      'another passphrase here',
    );

    expect(spent.ok).toBe(false);
    expect(fabricated.ok).toBe(false);
    if (!spent.ok && !fabricated.ok) {
      // Distinguishing them tells whoever holds a leaked token which it is.
      expect(spent.problems).toEqual(fabricated.problems);
    }
  });

  it('kills every existing session', async () => {
    const signedIn = await attemptLocalLogin({ email: EMAIL, password: GOOD });
    expect(signedIn.ok).toBe(true);

    const issued = await issuePasswordReset({ email: EMAIL, origin: 'admin', issuedBy: IDS.admin1 });
    await redeemPasswordReset(issued!.token, ALSO_GOOD);

    // A reset means somebody may have had this account. A live session that
    // survives it makes the reset cosmetic — a stolen laptop stays signed in.
    const rows = await auth()`SELECT 1 FROM auth_session WHERE user_id = ${IDS.admin1}::uuid`;
    expect(rows.length).toBe(0);
  });

  it('does not spend the token when the new password is rejected', async () => {
    const signedIn = await attemptLocalLogin({ email: EMAIL, password: GOOD });
    expect(signedIn.ok).toBe(true);

    const issued = await issuePasswordReset({ email: EMAIL, origin: 'self' });
    const rejected = await redeemPasswordReset(issued!.token, 'short');

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.problems.join(' ')).toMatch(/at least 12/);

    // Everything below is what makes the ordering in redeemPasswordReset load
    // bearing. Validate-after-redeem would pass the assertion above and fail
    // every one of these: the person mistypes their new password once and is
    // left signed out, holding a spent code, during the outage this feature
    // exists for.
    const [row] = await auth()<{ used_at: Date | null }[]>`
      SELECT used_at FROM password_reset WHERE id = ${issued!.resetId}::uuid
    `;
    expect(row!.used_at).toBeNull();

    const sessions = await auth()`SELECT 1 FROM auth_session WHERE user_id = ${IDS.admin1}::uuid`;
    expect(sessions.length).toBe(1);

    expect((await attemptLocalLogin({ email: EMAIL, password: GOOD })).ok).toBe(true);

    // And the token still works on a second, valid attempt.
    expect((await redeemPasswordReset(issued!.token, ALSO_GOOD)).ok).toBe(true);
    expect((await attemptLocalLogin({ email: EMAIL, password: ALSO_GOOD })).ok).toBe(true);
  });

  it('refuses a new password the person has used recently, without spending the token', async () => {
    const issued = await issuePasswordReset({ email: EMAIL, origin: 'self' });
    const reused = await redeemPasswordReset(issued!.token, GOOD);

    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.problems.join(' ')).toMatch(/used recently/);

    const [row] = await auth()<{ used_at: Date | null }[]>`
      SELECT used_at FROM password_reset WHERE id = ${issued!.resetId}::uuid
    `;
    expect(row!.used_at).toBeNull();
  });

  it('invalidates an outstanding token when the password changes another way', async () => {
    const issued = await issuePasswordReset({ email: EMAIL, origin: 'admin', issuedBy: IDS.admin1 });

    // The owner remembers their password and changes it themselves. The code
    // read down the phone an hour ago must stop working.
    await setLocalPassword({ userId: IDS.admin1, password: ALSO_GOOD });

    expect((await redeemPasswordReset(issued!.token, 'a third passphrase here')).ok).toBe(false);
  });

  it('clears a lockout, so a locked-out person can reset their way back in', async () => {
    for (let i = 0; i < 5; i += 1) {
      await attemptLocalLogin({ email: EMAIL, password: `wrong guess ${i}` });
    }

    const issued = await issuePasswordReset({ email: EMAIL, origin: 'admin', issuedBy: IDS.admin1 });
    expect((await redeemPasswordReset(issued!.token, ALSO_GOOD)).ok).toBe(true);

    expect((await attemptLocalLogin({ email: EMAIL, password: ALSO_GOOD })).ok).toBe(true);
  });
});

describe('must-change passwords', () => {
  it('signs in and reports that the password has to be replaced', async () => {
    await setLocalPassword({
      userId: IDS.admin1,
      password: GOOD,
      mustChange: true,
      setBy: IDS.admin2,
      reason: 'initial password issued at bootstrap',
    });

    const result = await attemptLocalLogin({ email: EMAIL, password: GOOD });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mustChange).toBe(true);

    // Replacing it clears the flag.
    await setLocalPassword({ userId: IDS.admin1, password: ALSO_GOOD });
    const second = await attemptLocalLogin({ email: EMAIL, password: ALSO_GOOD });
    if (second.ok) expect(second.mustChange).toBe(false);
  });
});

describe('privilege separation', () => {
  beforeEach(async () => {
    await setLocalPassword({ userId: IDS.admin1, password: GOOD });
  });

  it('denies helm_app the password hash, by every path it has', async () => {
    const app = db('app');

    await expect(
      app`SELECT password_phc FROM local_credential`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      app`SELECT previous_phc FROM local_credential`,
    ).rejects.toThrow(/permission denied/i);

    // Nor through the functions that would hand it over.
    await expect(
      app`SELECT * FROM helm.local_login_challenge(${EMAIL}, NULL)`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      app`SELECT helm.create_local_session(${IDS.admin1}::uuid, ${randomBytes(32).toString('hex')})`,
    ).rejects.toThrow(/permission denied/i);
  });

  it('denies helm_app the throttling ledger and the reset tokens', async () => {
    const app = db('app');
    await expect(app`SELECT * FROM auth_attempt`).rejects.toThrow(/permission denied/i);
    await expect(app`SELECT * FROM password_reset`).rejects.toThrow(/permission denied/i);
  });

  it('lets a signed-in person read their own credential state through the view', async () => {
    // The defect this guards against: a security_invoker view granted to a role
    // that holds no column grant behind it creates cleanly, grants cleanly, and
    // fails only when somebody opens the page.
    const app = db('app');
    const rows = await app.begin(async (tx) => {
      await tx`SELECT helm.set_session_context(${IDS.tenant1}::uuid, ${IDS.admin1}::uuid)`;
      return tx<{ user_id: string; must_change: boolean }[]>`
        SELECT * FROM v_my_local_credential
      `;
    });

    expect(rows.length).toBe(1);
    expect(rows[0]!.user_id).toBe(IDS.admin1);
    expect(Object.keys(rows[0]!)).not.toContain('password_phc');
  });

  it('shows an administrator who holds a local password, without any hash', async () => {
    const app = db('app');
    const rows = await app.begin(async (tx) => {
      await tx`SELECT helm.set_session_context(${IDS.tenant1}::uuid, ${IDS.admin1}::uuid)`;
      return tx<{ email: string; must_change: boolean }[]>`
        SELECT * FROM v_local_credential_status ORDER BY email
      `;
    });

    expect(rows.map((r) => r.email)).toEqual([EMAIL]);
    expect(Object.keys(rows[0]!)).not.toContain('password_phc');
  });

  it('does not show one tenant a rival tenant’s local accounts', async () => {
    await setLocalPassword({ userId: IDS.admin2, password: ALSO_GOOD });

    const app = db('app');
    const rows = await app.begin(async (tx) => {
      await tx`SELECT helm.set_session_context(${IDS.tenant1}::uuid, ${IDS.admin1}::uuid)`;
      return tx<{ email: string }[]>`SELECT email FROM v_local_credential_status`;
    });

    expect(rows.map((r) => r.email)).not.toContain('admin@rival.test');
  });

  it('hides the roster from somebody without user:read', async () => {
    const app = db('app');

    // A tier-one technician holds user:read and can see who in their own MSP
    // has a local password — that is what the view is for.
    const technician = await app.begin(async (tx) => {
      await tx`SELECT helm.set_session_context(${IDS.tenant1}::uuid, ${IDS.tech1}::uuid)`;
      return tx<{ email: string }[]>`SELECT email FROM v_local_credential_status`;
    });
    expect(technician.map((r) => r.email)).toEqual([EMAIL]);

    // A client's read-only user does not, and gets nothing back — not a roster
    // of who can still get in during an outage.
    const viewer = await app.begin(async (tx) => {
      await tx`SELECT helm.set_session_context(${IDS.tenant1}::uuid, ${IDS.acmeViewer}::uuid)`;
      return tx<{ email: string }[]>`SELECT email FROM v_local_credential_status`;
    });
    expect(viewer.length).toBe(0);
  });
});

describe('pruning', () => {
  it('drops stale attempts and keeps recent ones', async () => {
    await setLocalPassword({ userId: IDS.admin1, password: GOOD });
    await attemptLocalLogin({ email: EMAIL, password: 'wrong', ip: '198.51.100.7' });
    await attemptLocalLogin({ email: EMAIL, password: GOOD, ip: '198.51.100.7' });

    // Age the failure out of the retention window; leave the success recent.
    await su`
      UPDATE auth_attempt SET occurred_at = now() - interval '60 days'
      WHERE outcome = 'bad_password'
    `;

    const worker = db('worker');
    const [pruned] = await worker<{ prune_auth_attempts: string }[]>`
      SELECT helm.prune_auth_attempts(30)
    `;
    expect(Number(pruned!.prune_auth_attempts)).toBe(1);

    const remaining = await auth()<{ outcome: string }[]>`SELECT outcome FROM auth_attempt`;
    expect(remaining.map((r) => r.outcome)).toEqual(['success']);
  });
});

describe('a hash stored under weaker parameters', () => {
  it('is upgraded on the next successful sign-in', async () => {
    // A genuinely weak hash, computed at the old parameters. Rewriting the
    // parameter text inside a current hash would not do: verification recomputes
    // from the parameters in the string, so the digest would not match and this
    // would be testing a corrupt row rather than an old one.
    const weak = await argon2Hash(GOOD, {
      algorithm: 2, // Argon2id
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    });
    expect(weak).toContain('m=19456,t=2');

    await su`
      INSERT INTO local_credential (user_id, password_phc)
      VALUES (${IDS.admin1}::uuid, ${weak})
    `;

    // The old hash still verifies — an upgrade must never lock anybody out.
    const result = await attemptLocalLogin({ email: EMAIL, password: GOOD });
    expect(result.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const [row] = await auth()<{ password_phc: string }[]>`
      SELECT password_phc FROM local_credential WHERE user_id = ${IDS.admin1}::uuid
    `;
    expect(row!.password_phc).toContain('m=65536,t=3');
  });
});
