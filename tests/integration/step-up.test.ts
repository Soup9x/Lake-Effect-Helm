/**
 * Step-up verification, driven the way a person drives it.
 *
 * WHY THIS FILE EXISTS AT ALL, and it is the whole point of it: three existing
 * suites already "covered" step-up — tests/integration/secrets.test.ts,
 * tests/integration/api.test.ts and db/tests/security.sql — and every one of
 * them satisfied the requirement by INSERTing a step_up_verification row as a
 * superuser. That is a fine way to test what the database does with a
 * verification. It is also why nobody noticed for months that no user could
 * ever create one: helm.record_step_up() was correct, granted, and called by
 * nothing, and a suite that writes the row itself never touches the path that
 * was missing.
 *
 * So the rule here is absolute: NOTHING in this file writes step_up_verification.
 * Every verification in it is obtained by POSTing a password to the real route,
 * and every privileged action is the real route a component calls. The
 * superuser connection is used only to set up passwords and to READ BACK what
 * the flow wrote.
 *
 * The lower-level suites keep their direct inserts. They test a different
 * thing, and the failure mode was never that they were wrong — it was that they
 * were the only coverage.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// next/headers has no async-local request scope when a route handler is called
// directly. Only the step-up route's dependency chain reaches it, and it never
// reads the tenant cookie — resolveIdentity() uses the X-Helm-Tenant header.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { setLocalPassword } from '../../src/lib/auth/local';
import { mintToken } from '../../src/lib/auth/tokens';
import {
  actor,
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { POST as stepUpRoute } from '../../src/app/api/auth/step-up/route';
import { POST as createSecretRoute } from '../../src/app/api/secrets/route';
import { POST as revealRoute } from '../../src/app/api/secrets/[secretId]/reveal/route';
import { POST as rotateRoute } from '../../src/app/api/secrets/[secretId]/rotate/route';

const ADMIN_EMAIL = 'admin@northwind.test';
const ADMIN_PASSWORD = 'seventeen purple lanterns';
const TECH_EMAIL = 'tech@northwind.test';
const TECH_PASSWORD = 'nineteen copper doorframes';

let h: Harness;
let currentUser: SessionUser | null = null;

const asAdmin = () => {
  currentUser = { id: IDS.admin1, email: ADMIN_EMAIL };
};

function post(path: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
    new Request(`http://helm.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const json = async (r: Response) => (await r.json()) as Record<string, any>;

const params = (secretId: string) =>
  ({ params: Promise.resolve({ secretId }) }) as never;

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Reads only. Counting rows the FLOW wrote, never writing one. */
const countVerifications = (userId: string) =>
  su(async (sql) => {
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM step_up_verification
      WHERE user_id = ${userId}::uuid AND expires_at > now()
    `;
    return Number(row!.n);
  });

const stepUp = (password: string) => stepUpRoute(post('/api/auth/step-up', { password }));

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'test provisioning' });

  await setLocalPassword({
    userId: IDS.admin1,
    password: ADMIN_PASSWORD,
    context: { email: ADMIN_EMAIL, name: 'Admin' },
    reason: 'test setup',
    connection: 'auth',
  });
  await setLocalPassword({
    userId: IDS.tech1,
    password: TECH_PASSWORD,
    context: { email: TECH_EMAIL, name: 'Tech' },
    reason: 'test setup',
    connection: 'auth',
  });
}, 120_000);

beforeEach(async () => {
  asAdmin();
  // Each test starts from a session that has NOT stepped up, and from a clean
  // throttle — the lockout test below would otherwise poison everything after
  // it. Deleting verifications is the opposite of granting one.
  await su(async (sql) => {
    await sql`DELETE FROM step_up_verification`;
    await sql`DELETE FROM auth_attempt`;
    await sql`UPDATE local_credential SET locked_until = NULL, failed_attempts = 0`;
  });
});

afterAll(async () => {
  await disconnectPools();
});

// ---------------------------------------------------------------------------

describe('POST /api/auth/step-up', () => {
  it('records a verification for the right password, and says when it lapses', async () => {
    const before = await countVerifications(IDS.admin1);
    expect(before).toBe(0);

    const response = await stepUp(ADMIN_PASSWORD);
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(await countVerifications(IDS.admin1)).toBe(1);

    // Fifteen minutes, give or take the round trip. The window is the control:
    // a verification that never lapsed would make one password entry permanent.
    const lapses = new Date(body.expiresAt as string).getTime() - Date.now();
    expect(lapses).toBeGreaterThan(13 * 60_000);
    expect(lapses).toBeLessThan(16 * 60_000);
  });

  it('refuses a wrong password and records NOTHING', async () => {
    const response = await stepUp('not the password at all');

    expect(response.status).toBe(401);
    expect((await json(response)).error.code).toBe('unauthenticated');
    // The assertion that matters. A route that verified loosely — or recorded
    // first and checked after — would still return 401 here.
    expect(await countVerifications(IDS.admin1)).toBe(0);
  });

  it('writes an audit event naming the method', async () => {
    await stepUp(ADMIN_PASSWORD);

    const row = await su(async (sql) => {
      const [r] = await sql<{ action: string; outcome: string; metadata: any }[]>`
        SELECT action, outcome, metadata FROM audit_log
        WHERE action = 'auth.step_up_verified' AND actor_id = ${IDS.admin1}::uuid
        ORDER BY occurred_at DESC LIMIT 1
      `;
      return r;
    });

    expect(row).toBeDefined();
    expect(row!.outcome).toBe('success');
    expect(row!.metadata.method).toBe('password');
  });

  it('goes through the sign-in throttle, so it is not a password oracle', async () => {
    // A stolen session cookie must not be usable to grind the password at a
    // rate the login form would refuse. Five wrong answers lock the account;
    // the sixth is refused without a verification being attempted.
    for (let i = 0; i < 5; i += 1) {
      expect((await stepUp('wrong answer number ' + i)).status).toBe(401);
    }

    const locked = await stepUp(ADMIN_PASSWORD);
    expect(locked.status).toBe(429);
    expect((await json(locked)).error.code).toBe('rate_limited');
    // ...and the CORRECT password did not get through while locked out.
    expect(await countVerifications(IDS.admin1)).toBe(0);
  });

  it('tells an SSO-only account why it cannot step up, instead of "wrong password"', async () => {
    // acmeViewer has a membership and no local credential. Answering "that
    // password is not correct" to somebody who has no password to get wrong is
    // how a person retypes it eleven times and then files a bug.
    currentUser = { id: IDS.acmeViewer, email: 'viewer@acme.test' };

    const response = await stepUp('anything at all');
    const body = await json(response);

    expect(response.status).toBe(403);
    expect(body.error.message).toMatch(/no local password/i);
    expect(await countVerifications(IDS.acmeViewer)).toBe(0);
  });

  it('refuses an API token: a step-up is a person, not a credential', async () => {
    const minted = mintToken('user_pat');
    await su(async (sql) => {
      await sql`
        INSERT INTO api_token (
          tenant_id, token_type, user_id, name, token_prefix, token_hash, scopes
        )
        VALUES (
          ${IDS.tenant1}::uuid, 'user_pat', ${IDS.admin1}::uuid, 'step-up probe',
          ${minted.prefix}, ${minted.hash}, ARRAY['secret:read']
        )
      `;
    });

    const response = await stepUpRoute(
      post('/api/auth/step-up', { password: ADMIN_PASSWORD }, {
        authorization: `Bearer ${minted.token}`,
      }),
    );

    expect(response.status).toBe(403);
    expect((await json(response)).error.message).toMatch(/API token/i);
    // helm.record_step_up() refuses a service account, but a token issued to a
    // USER carries actor_type 'user' and would sail past that check. This is
    // the refusal that stops it.
    expect(await countVerifications(IDS.admin1)).toBe(0);
  });

  it('rejects a request with no password rather than recording an empty one', async () => {
    const response = await stepUpRoute(post('/api/auth/step-up', {}));
    expect(response.status).toBe(400);
    expect(await countVerifications(IDS.admin1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('a CRITICAL credential can now be created — it could not before', () => {
  const critical = (label: string) => ({
    organizationId: IDS.orgAcme,
    label,
    kind: 'password',
    value: 'a-domain-admin-password',
    sensitivity: 'critical',
    requiresStepUp: true,
    requiresReason: true,
    credentialType: 'domain_admin',
    username: 'ACME\\Administrator',
  });

  it('is refused WITH A CODE THE FORM CAN ACT ON before a step-up', async () => {
    const response = await createSecretRoute(post('/api/secrets', critical('refused critical')));
    const body = await json(response);

    expect(response.status).toBe(403);
    // Not `forbidden`. That was the defect underneath the defect: the refusal
    // was indistinguishable from "your role is too low", so the form had no way
    // to know a prompt would help and never offered one. 0470 attaches a
    // structured DETAIL that the handler maps to this.
    expect(body.error.code).toBe('step_up_required');
  });

  it('succeeds once the step-up route has been used', async () => {
    expect(
      (await createSecretRoute(post('/api/secrets', critical('two-phase critical')))).status,
    ).toBe(403);

    expect((await stepUp(ADMIN_PASSWORD)).status).toBe(200);

    const response = await createSecretRoute(post('/api/secrets', critical('two-phase critical')));
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.secretId).toBeDefined();
    expect(body.credentialId).toBeDefined();
    expect(body.version).toBe(1);

    // And it really is critical, with both flags the CHECK demands.
    const row = await su(async (sql) => {
      const [r] = await sql<{ sensitivity: string; requires_step_up: boolean; requires_reason: boolean }[]>`
        SELECT sensitivity::text, requires_step_up, requires_reason
        FROM secret WHERE id = ${body.secretId}::uuid
      `;
      return r!;
    });
    expect(row.sensitivity).toBe('critical');
    expect(row.requires_step_up).toBe(true);
    expect(row.requires_reason).toBe(true);
  });

  it('explains the critical rule rather than returning "internal error"', async () => {
    // The exact payload new-secret-form.tsx used to send: sensitivity critical,
    // no requiresStepUp. The CHECK fired, nothing caught it, and the person got
    // `500 internal error` for ticking a box the form offered them. The form
    // now sets both flags; this is the floor for an API client that does not.
    await stepUp(ADMIN_PASSWORD);

    const response = await createSecretRoute(
      post('/api/secrets', {
        organizationId: IDS.orgAcme,
        label: 'half-critical',
        kind: 'password',
        value: 'a-value',
        sensitivity: 'critical',
        requiresReason: true,
      }),
    );
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toMatch(/critical/i);
  });
});

// ---------------------------------------------------------------------------

describe('a credential flagged requires_step_up is readable again', () => {
  let secretId: string;

  beforeEach(async () => {
    const created = await h.secrets.create(
      actor(IDS.tenant1, IDS.admin1),
      { organizationId: IDS.orgAcme, kind: 'password', label: 'step-up wifi' },
      'the-stored-value',
    );
    secretId = created.secretId;
    // The flag an administrator sets from the edit form's "Require
    // re-authentication to reveal" checkbox. Before the step-up route existed,
    // ticking it made the credential permanently unreadable.
    await su((sql) => sql`
      UPDATE secret SET requires_step_up = true WHERE id = ${secretId}::uuid
    `);
  });

  const reveal = () =>
    revealRoute(
      post(`/api/secrets/${secretId}/reveal`, { purpose: 'view' }),
      params(secretId),
    );

  it('is refused first, revealed after — the exact sequence the button performs', async () => {
    const refused = await reveal();
    expect(refused.status).toBe(403);
    expect((await json(refused)).error.code).toBe('step_up_required');

    expect((await stepUp(ADMIN_PASSWORD)).status).toBe(200);

    const granted = await reveal();
    const body = await json(granted);
    expect(granted.status).toBe(200);
    expect(body.value).toBe('the-stored-value');
  });

  it('stays refused when the step-up was for a DIFFERENT tenant', async () => {
    // set_session_context() matches step_up_verification on (user_id,
    // tenant_id). A route that recorded against the wrong tenant would write a
    // row, audit it, and leave the person exactly as refused as before — which
    // is why the step-up route resolves its tenant the same way the reveal does
    // rather than reading the cookie.
    await stepUp(ADMIN_PASSWORD);
    await su((sql) => sql`
      UPDATE step_up_verification SET tenant_id = ${IDS.tenant2}::uuid
      WHERE user_id = ${IDS.admin1}::uuid
    `);

    const response = await reveal();
    expect(response.status).toBe(403);
    expect((await json(response)).error.code).toBe('step_up_required');
  });

  it('lapses, and the credential closes again', async () => {
    await stepUp(ADMIN_PASSWORD);
    expect((await reveal()).status).toBe(200);

    // Age the verification past its window rather than waiting fifteen minutes.
    // This edits a row the FLOW created; it does not create one.
    await su((sql) => sql`
      UPDATE step_up_verification
         SET verified_at = now() - interval '20 minutes',
             expires_at  = now() - interval '5 minutes'
       WHERE user_id = ${IDS.admin1}::uuid
    `);

    const response = await reveal();
    expect(response.status).toBe(403);
    expect((await json(response)).error.code).toBe('step_up_required');
  });
});

// ---------------------------------------------------------------------------

describe('rotating a critical credential', () => {
  it('is refused before a step-up and stored after', async () => {
    // Needs a step-up to exist at all, so this is two phases from the start.
    await stepUp(ADMIN_PASSWORD);
    const created = await json(
      await createSecretRoute(
        post('/api/secrets', {
          organizationId: IDS.orgAcme,
          label: 'rotatable critical',
          kind: 'password',
          value: 'first-value',
          sensitivity: 'critical',
          requiresStepUp: true,
          requiresReason: true,
        }),
      ),
    );
    const secretId = created.secretId as string;

    await su((sql) => sql`DELETE FROM step_up_verification`);

    const rotate = () =>
      rotateRoute(
        post(`/api/secrets/${secretId}/rotate`, {
          value: 'second-value',
          reason: 'rotated during the step-up test',
        }),
        params(secretId),
      );

    const refused = await rotate();
    expect(refused.status).toBe(403);
    expect((await json(refused)).error.code).toBe('step_up_required');

    expect((await stepUp(ADMIN_PASSWORD)).status).toBe(200);

    const stored = await rotate();
    expect(stored.status).toBe(200);
    expect((await json(stored)).version).toBe(2);
  });
});
