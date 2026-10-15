/**
 * The /api/auth/local/* routes, driven as HTTP.
 *
 * tests/integration/local-auth.test.ts covers the service layer — what the
 * database enforces and what attemptLocalLogin() decides. This file covers the
 * part that sits above it and is easy to get wrong in a way no service test
 * would notice: what the routes actually SAY, and what they set on the
 * response.
 *
 * Three properties carry most of the weight:
 *
 *   ENUMERATION SAFETY   A wrong password, an address with no account, an
 *                        SSO-only account and a disabled account must be
 *                        indistinguishable in the response — same status, same
 *                        bytes. The service layer returns four different
 *                        outcomes; collapsing them is the route's job, and a
 *                        well-meaning "improvement" to the error message is
 *                        exactly how that regresses.
 *
 *   RATE LIMITING        The refusals have to be visible to the person (so they
 *                        stop typing) without being informative to a stranger,
 *                        and they have to carry Retry-After.
 *
 *   COOKIE ATTRIBUTES    HttpOnly, SameSite, Secure and the __Secure- prefix.
 *                        Get the name wrong and sign-in silently succeeds into
 *                        an anonymous session; get the flags wrong and the
 *                        session is readable from script or sent in the clear.
 *                        Asserted on the raw Set-Cookie header, which is what
 *                        the browser actually parses.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// next/headers reads an async-local request scope that does not exist when a
// route handler is called directly, so getServerIdentity() would throw before
// reaching anything worth testing. Hoisted because vi.mock is.
const mocks = vi.hoisted(() => ({ tenantCookie: undefined as string | undefined }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'helm_tenant' && mocks.tenantCookie
        ? { name, value: mocks.tenantCookie }
        : undefined,
  }),
}));

import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { setResetDelivery, type ResetMessage } from '../../src/lib/auth/reset-delivery';
import { setLocalPassword } from '../../src/lib/auth/local';
import { db } from '../../src/lib/db/client';
import { connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';

import { POST as loginRoute } from '../../src/app/api/auth/local/login/route';
import { POST as logoutRoute } from '../../src/app/api/auth/local/logout/route';
import { POST as resetRoute } from '../../src/app/api/auth/local/reset/route';
import { POST as redeemRoute } from '../../src/app/api/auth/local/reset/redeem/route';
import { POST as changePasswordRoute } from '../../src/app/api/auth/local/change-password/route';

const PASSWORD = 'seventeen purple lanterns';
const NEW_PASSWORD = 'nineteen copper doorframes';
const ADMIN = 'admin@northwind.test';

let su: ReturnType<typeof superuserSql>;
let currentUser: SessionUser | null = null;

/** Captures what the self-service reset path would have emailed. */
const delivered: ResetMessage[] = [];

function post(path: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
    new Request(`http://helm.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const json = async (r: Response) => (await r.json()) as Record<string, any>;

/**
 * Pull a cookie value out of the raw Set-Cookie header.
 *
 * The handlers are typed as returning Response, not NextResponse, so there is
 * no `.cookies` accessor to reach for — and parsing the header is closer to
 * what a browser does anyway.
 */
function cookieValue(r: Response, name: string): string | undefined {
  const raw = r.headers.get('set-cookie') ?? '';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[,;]\\s*)${escaped}=([^;]*)`).exec(raw)?.[1];
}

/** Status plus the exact response bytes — what a caller can actually observe. */
async function observable(r: Response): Promise<{ status: number; body: string }> {
  return { status: r.status, body: await r.text() };
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  su = superuserSql();
  useSessionResolver(async () => currentUser);
}, 120_000);

afterAll(async () => {
  await su.end({ timeout: 5 });
  await disconnectPools();
});

beforeEach(async () => {
  await su`DELETE FROM auth_attempt`;
  await su`DELETE FROM password_reset`;
  await su`DELETE FROM local_credential`;
  await su`DELETE FROM auth_session`;
  await su`UPDATE app_user SET disabled_at = NULL`;

  delivered.length = 0;
  currentUser = null;
  mocks.tenantCookie = undefined;
  // The refusing default, unless a test installs a channel.
  setResetDelivery(null);

  await setLocalPassword({ userId: IDS.admin1, password: PASSWORD });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// -----------------------------------------------------------------------------
describe('POST /api/auth/local/login — enumeration safety', () => {
  it('answers a wrong password, an unknown address, an SSO-only account and a disabled account identically', async () => {
    await su`UPDATE app_user SET disabled_at = now() WHERE id = ${IDS.acmeAdmin}::uuid`;
    await setLocalPassword({ userId: IDS.acmeAdmin, password: PASSWORD });

    const answers = await Promise.all(
      [
        // Real account, wrong password.
        { email: ADMIN, password: 'not the password' },
        // No such account at all.
        { email: 'nobody-at-all@northwind.test', password: 'not the password' },
        // Real account, SSO only — no local credential.
        { email: 'tech1@northwind.test', password: 'not the password' },
        // Real account, correct password, disabled.
        { email: 'it@acme.test', password: PASSWORD },
      ].map(async (body, i) =>
        observable(await loginRoute(post('/api/auth/local/login', body, {
          // Distinct addresses so the per-address counter cannot make one of
          // these four differ from the others for an unrelated reason.
          'x-forwarded-for': `198.51.100.${10 + i}`,
        }))),
      ),
    );

    // Not "all 401" — all IDENTICAL. A difference of a single word is enough to
    // tell an attacker which addresses are worth attacking.
    const [first, ...rest] = answers;
    for (const answer of rest) expect(answer).toEqual(first);
    expect(first!.status).toBe(401);
    expect(first!.body).not.toMatch(/disabled|no such|unknown|sso|exist/i);
  });

  it('never sets a session cookie on any of those failures', async () => {
    const response = await loginRoute(
      post('/api/auth/local/login', { email: ADMIN, password: 'wrong' }),
    );
    expect(response.headers.get('set-cookie')).toBeNull();

    const rows = await db('auth')`SELECT 1 FROM auth_session`;
    expect(rows.length).toBe(0);
  });

  it('rejects a malformed body before touching the database', async () => {
    for (const body of [{}, { email: ADMIN }, { password: PASSWORD }, { email: 1, password: 2 }]) {
      const response = await loginRoute(post('/api/auth/local/login', body));
      expect(response.status).toBe(400);
      expect((await json(response)).error.code).toBe('invalid_request');
    }
    // A 400 must not be recorded as a failed attempt; it never reached an
    // account, and counting it would let anyone lock a colleague out with
    // malformed requests.
    const [row] = await db('auth')<{ n: number }[]>`SELECT count(*)::int AS n FROM auth_attempt`;
    expect(row!.n).toBe(0);
  });
});

// -----------------------------------------------------------------------------
describe('POST /api/auth/local/login — rate limiting and lockout', () => {
  it('returns 429 with Retry-After once the account is locked', async () => {
    for (let i = 0; i < 5; i += 1) {
      await loginRoute(post('/api/auth/local/login', { email: ADMIN, password: `wrong ${i}` },
        { 'x-forwarded-for': '203.0.113.5' }));
    }

    // The correct password, refused. Anything else makes the lockout theatre.
    const response = await loginRoute(
      post('/api/auth/local/login', { email: ADMIN, password: PASSWORD },
        { 'x-forwarded-for': '203.0.113.5' }),
    );

    expect(response.status).toBe(429);
    const retryAfter = Number(response.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);

    const payload = await json(response);
    expect(payload.error.code).toBe('locked');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('returns 429 for an address spraying many accounts', async () => {
    for (let i = 0; i < 30; i += 1) {
      await loginRoute(post('/api/auth/local/login',
        { email: `victim-${i}@northwind.test`, password: 'spray' },
        { 'x-forwarded-for': '203.0.113.99' }));
    }

    const sprayed = await loginRoute(
      post('/api/auth/local/login', { email: 'victim-30@northwind.test', password: 'spray' },
        { 'x-forwarded-for': '203.0.113.99' }),
    );
    expect(sprayed.status).toBe(429);
    expect((await json(sprayed)).error.code).toBe('rate_limited');
    expect(sprayed.headers.get('retry-after')).toBe('900');

    // A different address is unaffected: the limit is per source, not global.
    const elsewhere = await loginRoute(
      post('/api/auth/local/login', { email: ADMIN, password: PASSWORD },
        { 'x-forwarded-for': '198.51.100.7' }),
    );
    expect(elsewhere.status).toBe(200);
  });

  it('does not reveal whether a throttled address was guessing at a real account', async () => {
    for (let i = 0; i < 30; i += 1) {
      await loginRoute(post('/api/auth/local/login',
        { email: `victim-${i}@northwind.test`, password: 'spray' },
        { 'x-forwarded-for': '203.0.113.98' }));
    }

    const real = await observable(await loginRoute(
      post('/api/auth/local/login', { email: ADMIN, password: 'guess' },
        { 'x-forwarded-for': '203.0.113.98' })));
    const fake = await observable(await loginRoute(
      post('/api/auth/local/login', { email: 'ghost@northwind.test', password: 'guess' },
        { 'x-forwarded-for': '203.0.113.98' })));

    expect(real).toEqual(fake);
  });
});

// -----------------------------------------------------------------------------
describe('POST /api/auth/local/login — the session cookie', () => {
  /** The raw Set-Cookie header: what the browser parses, not what we meant. */
  const setCookie = (r: Response) => r.headers.get('set-cookie') ?? '';

  it('sets HttpOnly, SameSite=Lax and Path=/ outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    const response = await loginRoute(post('/api/auth/local/login', { email: ADMIN, password: PASSWORD }));
    expect(response.status).toBe(200);

    const cookie = setCookie(response);
    expect(cookie).toContain('authjs.session-token=');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
    // Not Secure here, or a developer on http cannot hold a session at all.
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  it('uses the __Secure- prefix and the Secure flag in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const response = await loginRoute(post('/api/auth/local/login', { email: ADMIN, password: PASSWORD }));
    expect(response.status).toBe(200);

    const cookie = setCookie(response);
    // The name must match what Auth.js reads. If it does not, sign-in appears
    // to succeed and every subsequent request is anonymous.
    expect(cookie).toContain('__Secure-authjs.session-token=');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=lax/i);
  });

  it('carries a token that matches a real auth_session row', async () => {
    const response = await loginRoute(post('/api/auth/local/login', { email: ADMIN, password: PASSWORD }));
    const token = cookieValue(response, 'authjs.session-token');
    expect(token).toBeTruthy();

    const [session] = await db('auth')<{ user_id: string }[]>`
      SELECT user_id FROM auth_session WHERE session_token = ${token!}
    `;
    expect(session!.user_id).toBe(IDS.admin1);
  });

  it('reports mustChange so the client can route to the change screen', async () => {
    await setLocalPassword({
      userId: IDS.admin1,
      password: NEW_PASSWORD,
      mustChange: true,
      setBy: IDS.admin2,
    });

    const response = await loginRoute(post('/api/auth/local/login', { email: ADMIN, password: NEW_PASSWORD }));
    expect((await json(response)).mustChange).toBe(true);
  });
});

// -----------------------------------------------------------------------------
describe('POST /api/auth/local/logout', () => {
  it('deletes the session row and expires the cookie', async () => {
    const login = await loginRoute(post('/api/auth/local/login', { email: ADMIN, password: PASSWORD }));
    const token = cookieValue(login, 'authjs.session-token')!;

    const response = await logoutRoute(
      post('/api/auth/local/logout', {}, { cookie: `authjs.session-token=${token}` }),
    );
    expect(response.status).toBe(200);

    // The row first — a cleared cookie over a live row is a session anyone who
    // copied the cookie still holds.
    const rows = await db('auth')`SELECT 1 FROM auth_session WHERE session_token = ${token}`;
    expect(rows.length).toBe(0);
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  });

  it('succeeds with no cookie at all', async () => {
    const response = await logoutRoute(post('/api/auth/local/logout', {}));
    expect(response.status).toBe(200);
  });
});

// -----------------------------------------------------------------------------
describe('POST /api/auth/local/reset', () => {
  it('refuses rather than pretending, when no delivery channel is configured', async () => {
    const response = await resetRoute(post('/api/auth/local/reset', { email: ADMIN }));

    expect(response.status).toBe(503);
    expect((await json(response)).error.code).toBe('reset_delivery_unavailable');
    // "Check your email" when nothing was sent produces somebody who believes
    // they are locked out permanently. And nothing is issued: there is no
    // channel to send it through.
    const [row] = await db('auth')<{ n: number }[]>`SELECT count(*)::int AS n FROM password_reset`;
    expect(row!.n).toBe(0);
  });

  it('gives that refusal for every address, so it says nothing about which exist', async () => {
    // Before, the refusal came from send(), which only an address WITH an
    // account ever reached: 503 meant "exists", 200 meant "does not".
    const known = await observable(await resetRoute(post('/api/auth/local/reset', { email: ADMIN })));
    const unknown = await observable(
      await resetRoute(post('/api/auth/local/reset', { email: 'ghost@northwind.test' })),
    );
    expect(known).toEqual(unknown);
    expect(known.status).toBe(503);
  });

  it('answers a failed delivery exactly as a successful one', async () => {
    setResetDelivery({ name: 'broken', send: async () => { throw new Error('relay down'); } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const known = await observable(await resetRoute(post('/api/auth/local/reset', { email: ADMIN })));
      const unknown = await observable(
        await resetRoute(post('/api/auth/local/reset', { email: 'ghost@northwind.test' })),
      );
      expect(known).toEqual(unknown);
      expect(known.status).toBe(200);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('does not let an anonymous request cancel an administrator’s code (0740)', async () => {
    currentUser = { id: IDS.admin1, email: ADMIN };
    mocks.tenantCookie = IDS.tenant1;
    const issued = await json(
      await resetRoute(post('/api/auth/local/reset', { email: ADMIN, outOfBand: true })),
    );
    const adminToken = new URL(issued.resetUrl as string).searchParams.get('token')!;

    // Anybody, repeatedly, during the outage the code exists for.
    currentUser = null;
    mocks.tenantCookie = undefined;
    setResetDelivery({ name: 'capture', send: async (m) => { delivered.push(m); } });
    for (let i = 0; i < 3; i += 1) {
      expect((await resetRoute(post('/api/auth/local/reset', { email: ADMIN }))).status).toBe(200);
    }
    // ...and only the first of those produced a message: the rest were inside
    // the five-minute window and issued nothing.
    expect(delivered.length).toBe(1);

    const redeemed = await redeemRoute(
      post('/api/auth/local/reset/redeem', { token: adminToken, password: NEW_PASSWORD }),
    );
    expect(redeemed.status).toBe(200);
  });

  it('answers an unknown address exactly as a known one', async () => {
    setResetDelivery({ name: 'capture', send: async (m) => { delivered.push(m); } });

    const known = await observable(await resetRoute(post('/api/auth/local/reset', { email: ADMIN })));
    const unknown = await observable(
      await resetRoute(post('/api/auth/local/reset', { email: 'ghost@northwind.test' })),
    );

    expect(known).toEqual(unknown);
    expect(known.status).toBe(200);
    // ...and only the real one actually produced a message.
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.email).toBe(ADMIN);
  });

  it('refuses an out-of-band code to an anonymous caller', async () => {
    const response = await resetRoute(
      post('/api/auth/local/reset', { email: ADMIN, outOfBand: true }),
    );
    expect(response.status).toBe(401);
    expect((await json(response)).error.code).toBe('unauthenticated');
  });

  it('refuses an out-of-band code to a signed-in user without user:write', async () => {
    currentUser = { id: IDS.tech1, email: 'tech1@northwind.test' };
    mocks.tenantCookie = IDS.tenant1;

    const response = await resetRoute(
      post('/api/auth/local/reset', { email: ADMIN, outOfBand: true }),
    );
    expect(response.status).toBe(403);
    expect((await json(response)).error.message).toMatch(/user:write/);
  });

  it('issues an out-of-band code to an administrator, and returns it once', async () => {
    currentUser = { id: IDS.admin1, email: ADMIN };
    mocks.tenantCookie = IDS.tenant1;

    const response = await resetRoute(
      post('/api/auth/local/reset', { email: ADMIN, outOfBand: true }),
    );
    expect(response.status).toBe(200);

    const payload = await json(response);
    // ABSOLUTE, not a bare path. This link's whole purpose is being read down
    // the phone; "/sign-in/reset?token=..." is not something anyone can type.
    const url = new URL(payload.resetUrl as string);
    expect(url.pathname).toBe('/sign-in/reset');
    expect(url.searchParams.get('token')).toBeTruthy();
    expect(url.origin).toMatch(/^https?:\/\/.+/);
    expect(payload.warning).toMatch(/do not put it in a ticket/i);

    // No delivery channel was needed — that is the whole point of this path.
    expect(delivered.length).toBe(0);
  });

  it('refuses an out-of-band code for somebody outside the administrator’s tenant', async () => {
    currentUser = { id: IDS.admin1, email: ADMIN };
    mocks.tenantCookie = IDS.tenant1;

    const response = await resetRoute(
      post('/api/auth/local/reset', { email: 'admin@rival.test', outOfBand: true }),
    );
    expect(response.status).toBe(404);
  });

  /*
   * 0710. A tier3 holds user:write, so before 0710 this path handed them the
   * super_admin's reset link — and with it the super_admin's account, which
   * 0350 exists to stop a tier3 from ever reaching.
   */
  describe('rank and scope (0710)', () => {
    beforeEach(async () => {
      await su`UPDATE membership SET role_key = 'tier3' WHERE user_id = ${IDS.tech1}::uuid`;
    });

    afterEach(async () => {
      await su`UPDATE membership SET role_key = 'tier1' WHERE user_id = ${IDS.tech1}::uuid`;
      await su`DELETE FROM membership WHERE tenant_id = ${IDS.tenant2}::uuid AND user_id = ${IDS.tech1}::uuid`;
    });

    it('refuses a tier3 issuing a code for the super_admin, and issues nothing', async () => {
      currentUser = { id: IDS.tech1, email: 'tech1@northwind.test' };
      mocks.tenantCookie = IDS.tenant1;

      const response = await resetRoute(
        post('/api/auth/local/reset', { email: ADMIN, outOfBand: true }),
      );
      expect(response.status).toBe(403);
      expect((await json(response)).error.message).toMatch(/outranks yours/);

      const [issued] = await su<{ n: number }[]>`
        SELECT count(*)::int AS n FROM password_reset WHERE user_id = ${IDS.admin1}::uuid
      `;
      expect(issued!.n).toBe(0);
    });

    it('still lets a tier3 issue a code for somebody they outrank', async () => {
      currentUser = { id: IDS.tech1, email: 'tech1@northwind.test' };
      mocks.tenantCookie = IDS.tenant1;

      const response = await resetRoute(
        post('/api/auth/local/reset', { email: 'viewer@acme.test', outOfBand: true }),
      );
      expect(response.status).toBe(200);
      expect((await json(response)).resetUrl).toBeTruthy();
    });

    it('lets a super_admin issue a code for a peer of equal rank', async () => {
      // Equal rank is the break-glass case: one super_admin recovering another.
      await su`UPDATE membership SET role_key = 'super_admin' WHERE user_id = ${IDS.tech1}::uuid`;
      currentUser = { id: IDS.admin1, email: ADMIN };
      mocks.tenantCookie = IDS.tenant1;

      const response = await resetRoute(
        post('/api/auth/local/reset', { email: 'tech1@northwind.test', outOfBand: true }),
      );
      expect(response.status).toBe(200);
    });

    it('refuses an account that also belongs to another tenant', async () => {
      // The password is one credential for every tenant the person is in;
      // tenant 1's administrator has no authority over their way into tenant 2.
      await su`
        INSERT INTO membership (tenant_id, user_id, role_key, org_scope_all)
        VALUES (${IDS.tenant2}::uuid, ${IDS.tech1}::uuid, 'tier1', true)
      `;
      currentUser = { id: IDS.admin1, email: ADMIN };
      mocks.tenantCookie = IDS.tenant1;

      const response = await resetRoute(
        post('/api/auth/local/reset', { email: 'tech1@northwind.test', outOfBand: true }),
      );
      expect(response.status).toBe(403);
      expect((await json(response)).error.message).toMatch(/another tenant/);
    });
  });
});

// -----------------------------------------------------------------------------
describe('POST /api/auth/local/reset/redeem', () => {
  async function issueToken(): Promise<string> {
    currentUser = { id: IDS.admin1, email: ADMIN };
    mocks.tenantCookie = IDS.tenant1;
    const response = await resetRoute(post('/api/auth/local/reset', { email: ADMIN, outOfBand: true }));
    currentUser = null;
    return new URL((await json(response)).resetUrl as string).searchParams.get('token')!;
  }

  it('sets the new password and lets it sign in', async () => {
    const token = await issueToken();

    const response = await redeemRoute(
      post('/api/auth/local/reset/redeem', { token, password: NEW_PASSWORD }),
    );
    expect(response.status).toBe(200);

    // Deliberately does NOT sign them in: a leaked link must not be a takeover
    // in one step.
    expect(response.headers.get('set-cookie')).toBeNull();

    const login = await loginRoute(post('/api/auth/local/login', { email: ADMIN, password: NEW_PASSWORD }));
    expect(login.status).toBe(200);
  });

  it('returns the policy problems and does NOT spend the token', async () => {
    const token = await issueToken();

    const rejected = await redeemRoute(
      post('/api/auth/local/reset/redeem', { token, password: 'short' }),
    );
    expect(rejected.status).toBe(400);
    expect((await json(rejected)).error.details.problems.join(' ')).toMatch(/at least 12/);

    // Still usable — otherwise one typo leaves somebody locked out holding a
    // spent code, during the outage this feature exists for.
    const second = await redeemRoute(
      post('/api/auth/local/reset/redeem', { token, password: NEW_PASSWORD }),
    );
    expect(second.status).toBe(200);
  });

  it('says the same thing for spent, expired and fabricated tokens', async () => {
    const token = await issueToken();
    await redeemRoute(post('/api/auth/local/reset/redeem', { token, password: NEW_PASSWORD }));

    const spent = await observable(await redeemRoute(
      post('/api/auth/local/reset/redeem', { token, password: 'a third passphrase here' })));
    const fabricated = await observable(await redeemRoute(
      post('/api/auth/local/reset/redeem', { token: 'not-a-real-token-at-all', password: 'a third passphrase here' })));

    expect(spent).toEqual(fabricated);
    expect(spent.status).toBe(400);
  });
});

// -----------------------------------------------------------------------------
describe('POST /api/auth/local/change-password', () => {
  beforeEach(() => {
    currentUser = { id: IDS.admin1, email: ADMIN, name: 'Northwind Admin' };
    mocks.tenantCookie = IDS.tenant1;
  });

  it('refuses an anonymous caller', async () => {
    currentUser = null;
    const response = await changePasswordRoute(
      post('/api/auth/local/change-password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    );
    expect(response.status).toBe(401);
  });

  it('requires the current password even with a valid session', async () => {
    // A stolen cookie must not be upgradable into permanent ownership.
    const response = await changePasswordRoute(
      post('/api/auth/local/change-password', { currentPassword: 'not it', newPassword: NEW_PASSWORD }),
    );
    expect(response.status).toBe(401);
    expect((await json(response)).error.code).toBe('invalid_credentials');

    const login = await loginRoute(post('/api/auth/local/login', { email: ADMIN, password: PASSWORD }));
    expect(login.status).toBe(200);
  });

  it('reports every policy problem at once, with 422', async () => {
    const response = await changePasswordRoute(
      post('/api/auth/local/change-password', { currentPassword: PASSWORD, newPassword: 'password123' }),
    );
    expect(response.status).toBe(422);

    const problems = (await json(response)).error.details.problems as string[];
    expect(problems.length).toBeGreaterThan(1);
  });

  it('changes the password and leaves the caller signed in', async () => {
    const login = await loginRoute(post('/api/auth/local/login', { email: ADMIN, password: PASSWORD }));
    const token = cookieValue(login, 'authjs.session-token')!;

    const response = await changePasswordRoute(
      post('/api/auth/local/change-password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    );
    expect(response.status).toBe(200);

    // They proved they know both passwords, so there is nothing to revoke —
    // and signing them out of the tab they are working in would be hostile.
    const rows = await db('auth')`SELECT 1 FROM auth_session WHERE session_token = ${token}`;
    expect(rows.length).toBe(1);

    expect((await loginRoute(post('/api/auth/local/login',
      { email: ADMIN, password: NEW_PASSWORD }))).status).toBe(200);
  });
});
