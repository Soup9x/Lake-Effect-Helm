/**
 * An authenticator-app code for local sign-in (0960).
 *
 * What is asserted: enrolment is not in force until a first code proves it;
 * once it is, a sign-in needs a code, a wrong code counts and locks like a
 * wrong password, a code is good once, a recovery code is good once, a
 * re-authentication (step-up, change of password) does not ask again, policy
 * can require it — walking somebody without one through setting it up at the
 * door — and an administrator can reset it.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { attemptLocalLogin, setLocalPassword } from '../../src/lib/auth/local';
import { confirmEnrolment, startEnrolment, totpStatus } from '../../src/lib/auth/local-totp';
import { base32Decode, generateTotp } from '../../src/lib/crypto/totp';
import { POST as loginRoute } from '../../src/app/api/auth/local/login/route';
import { DELETE as resetRoute } from '../../src/app/api/users/[userId]/totp/route';
import { buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';

process.env.HELM_BLIND_INDEX_KEY_B64 = Buffer.alloc(32, 7).toString('base64');

const PASSWORD = 'seventeen purple lanterns';
const EMAIL = 'admin@northwind.test';

let su: ReturnType<typeof superuserSql>;
let currentUser: SessionUser | null = null;

const codeNow = (secret: string, offsetSeconds = 0) =>
  generateTotp(base32Decode(secret), { periodSeconds: 30 }, Date.now() + offsetSeconds * 1000).code;

const login = (extra: Record<string, unknown> = {}) =>
  loginRoute(new NextRequest(new Request('http://helm.test/api/auth/local/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, ...extra }),
  })));
const json = async (r: Response) => (await r.json()) as Record<string, any>;

/** Set admin1 up with an authenticator; returns its secret and recovery codes. */
async function enrol(): Promise<{ secret: string; codes: string[] }> {
  const { secret } = await startEnrolment(IDS.admin1, EMAIL);
  const codes = await confirmEnrolment(IDS.admin1, codeNow(secret));
  if (!codes) throw new Error('enrolment did not confirm');
  return { secret, codes };
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  const h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  su = superuserSql();
  useSessionResolver(async () => currentUser);
}, 180_000);

afterAll(async () => {
  await su.end({ timeout: 5 });
  await disconnectPools();
});

beforeEach(async () => {
  await su`DELETE FROM auth_attempt`;
  await su`DELETE FROM local_totp`;
  await su`DELETE FROM session_policy`;
  await su`DELETE FROM local_credential`;
  currentUser = null;
  await setLocalPassword({ userId: IDS.admin1, password: PASSWORD });
});

describe('setting it up', () => {
  it('is not in force until a first code proves it', async () => {
    const { secret } = await startEnrolment(IDS.admin1, EMAIL);
    expect((await totpStatus(IDS.admin1)).enrolled).toBe(false);
    // An unconfirmed seed asks nothing at the door.
    expect((await login()).status).toBe(200);

    expect(await confirmEnrolment(IDS.admin1, '000000')).toBeNull();
    const codes = await confirmEnrolment(IDS.admin1, codeNow(secret));
    expect(codes).toHaveLength(10);
    expect(await totpStatus(IDS.admin1)).toEqual({ enrolled: true, recoveryRemaining: 10 });
  });

  it('keeps the seed sealed: what is stored is not the seed', async () => {
    const { secret } = await startEnrolment(IDS.admin1, EMAIL);
    const [row] = await su<{ seed_ciphertext: Buffer; seed_aad: string }[]>`
      SELECT seed_ciphertext, seed_aad FROM local_totp WHERE user_id = ${IDS.admin1}::uuid`;
    expect(row!.seed_ciphertext.equals(base32Decode(secret))).toBe(false);
    expect(row!.seed_aad).toContain(IDS.admin1);
  });
});

describe('signing in with it', () => {
  it('asks for a code after the right password, and not after a wrong one', async () => {
    await enrol();
    const asked = await login();
    expect(asked.status).toBe(401);
    expect((await json(asked)).error.code).toBe('totp_required');

    const wrongPassword = await login({ password: 'not the password at all' });
    expect((await json(wrongPassword)).error.code).toBe('invalid_credentials');
  });

  it('signs in with the next code, and refuses the same code twice', async () => {
    const { secret } = await enrol();
    // The code that confirmed the enrolment has been used; the next one has not.
    const next = codeNow(secret, 30);
    expect((await login({ code: next })).status).toBe(200);
    const again = await login({ code: next });
    expect(again.status).toBe(401);
    expect((await json(again)).error.code).toBe('totp_invalid');
  });

  it('counts a wrong code as a failed sign-in, and locks on the threshold', async () => {
    await enrol();
    await su`INSERT INTO session_policy (tenant_id, lockout_threshold) VALUES (${IDS.tenant1}::uuid, 3)`;
    for (let i = 0; i < 3; i += 1) await login({ code: '000000' });
    const [row] = await su<{ locked: boolean; n: number }[]>`
      SELECT c.locked_until IS NOT NULL AS locked,
             (SELECT count(*)::int FROM auth_attempt WHERE outcome = 'bad_totp') AS n
      FROM local_credential c WHERE c.user_id = ${IDS.admin1}::uuid`;
    expect(row).toEqual({ locked: true, n: 3 });
  });

  it('takes a recovery code once', async () => {
    const { codes } = await enrol();
    expect((await login({ code: codes[0] })).status).toBe(200);
    expect((await login({ code: codes[0] })).status).toBe(401);
    expect((await totpStatus(IDS.admin1)).recoveryRemaining).toBe(9);
  });

  it('does not ask again to re-authenticate a session that already passed it', async () => {
    await enrol();
    const reauth = await attemptLocalLogin({ email: EMAIL, password: PASSWORD, establishSession: false });
    expect(reauth.ok).toBe(true);
  });
});

describe('when policy requires it', () => {
  it('walks somebody without one through setting it up at the door', async () => {
    await su`INSERT INTO session_policy (tenant_id, require_local_totp) VALUES (${IDS.tenant1}::uuid, true)`;

    const first = await login();
    expect(first.status).toBe(401);
    const body = await json(first);
    expect(body.error.code).toBe('totp_enrolment_required');
    const secret = body.error.details.secret as string;
    expect(body.error.details.uri).toMatch(/^otpauth:\/\/totp\//);

    // Asking again shows the same seed, so the code typed from it still matches.
    expect((await json(await login())).error.details.secret).toBe(secret);

    const done = await login({ code: codeNow(secret) });
    expect(done.status).toBe(200);
    expect((await json(done)).recoveryCodes).toHaveLength(10);
    expect((await totpStatus(IDS.admin1)).enrolled).toBe(true);
  });

  it('leaves single sign-on alone: only the local door is affected', async () => {
    await su`INSERT INTO session_policy (tenant_id, require_local_totp) VALUES (${IDS.tenant1}::uuid, true)`;
    // A re-authentication is not a sign-in at the door.
    expect((await attemptLocalLogin({ email: EMAIL, password: PASSWORD, establishSession: false })).ok).toBe(true);
  });
});

describe('an administrator’s reset', () => {
  const reset = (userId: string) => resetRoute(
    new NextRequest(new Request(`http://helm.test/api/users/${userId}/totp`, { method: 'DELETE' })),
    { params: Promise.resolve({ userId }) },
  );

  it('clears a lost phone, after which the password alone signs in again', async () => {
    await enrol();
    currentUser = { id: IDS.tech1, email: 'tech1@northwind.test' };
    expect((await reset(IDS.admin1)).status).toBe(403);

    // user:write is what it takes; the fixtures' one administrator holds it.
    currentUser = { id: IDS.admin1, email: EMAIL };
    expect((await reset(IDS.admin1)).status).toBe(200);
    expect((await totpStatus(IDS.admin1)).enrolled).toBe(false);
    expect((await login()).status).toBe(200);
  });
});
