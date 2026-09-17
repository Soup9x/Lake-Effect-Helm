/**
 * RADIUS configuration: storage, custody and who may change it.
 *
 * The protocol itself is covered in tests/unit/radius.test.ts against a real
 * UDP server. What is established here is everything around it:
 *
 *   * The shared secret goes in enveloped and never comes back out of any
 *     surface the browser can reach.
 *   * helm_app — the role that renders every page — cannot read the column it
 *     is stored in, by any path.
 *   * Configuring it takes tenant:write, which tier3 does not hold, even though
 *     tier3 holds nearly everything else.
 *   * The AAD really binds the ciphertext to its tenant, so a row lifted from
 *     one tenant into another fails to open rather than authenticating somebody
 *     against the wrong directory.
 *
 * The last of those is the one worth having. It is the difference between an
 * encryption scheme and a scheme-shaped arrangement of the same primitives.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { radiusForEmail, radiusForTenant, sealRadiusSecret } from '../../src/lib/auth/radius-config';
import { attemptLocalLogin } from '../../src/lib/auth/local';
import { hashPassword } from '../../src/lib/auth/password';
import { DEFAULT_SECRET, FakeRadius } from '../support/fake-radius';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { DELETE as deleteRadius, GET as getRadius, PUT as putRadius } from '../../src/app/api/auth/radius/route';
import { POST as testRadius } from '../../src/app/api/auth/radius/test/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const running: FakeRadius[] = [];

const request = (method: string, payload?: unknown) =>
  new NextRequest(
    new Request('http://helm.test/api/auth/radius', {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }),
  );

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

const SETTINGS = {
  enabled: true,
  host: '127.0.0.1',
  port: 1812,
  timeoutMs: 1500,
  retries: 0,
  nasIdentifier: 'helm-test',
  secret: DEFAULT_SECRET,
};

async function setTechRole(roleKey: string): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`
      UPDATE membership SET role_key = ${roleKey}
      WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function wipeConfig(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`DELETE FROM radius_config`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'test provisioning' });
}, 120_000);

afterEach(async () => {
  currentUser = null;
  while (running.length) running.pop()!.stop();
  await wipeConfig();
});

afterAll(async () => {
  await disconnectPools();
});

describe('PUT /api/auth/radius', () => {
  it('stores a configuration', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putRadius(request('PUT', SETTINGS));
    expect(response.status).toBe(200);

    const radius = (await body(response)).radius as Record<string, unknown>;
    expect(radius.configured).toBe(true);
    expect(radius.host).toBe('127.0.0.1');
    expect(radius.secretSet).toBe(true);
  });

  it('NEVER returns the shared secret', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const saved = await putRadius(request('PUT', SETTINGS));
    const fetched = await getRadius(request('GET'));

    for (const response of [saved, fetched]) {
      expect(JSON.stringify(await body(response))).not.toContain(DEFAULT_SECRET);
    }
  });

  it('stores it as ciphertext, not as text', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putRadius(request('PUT', SETTINGS));

    const sql = superuserSql();
    try {
      const [row] = await sql<{ ct: Buffer; aad: string; provider: string }[]>`
        SELECT secret_ciphertext AS ct, secret_aad AS aad, wrap_provider AS provider
        FROM radius_config WHERE tenant_id = ${IDS.tenant1}::uuid
      `;
      expect(row!.ct.toString('utf8')).not.toContain(DEFAULT_SECRET);
      expect(row!.ct.toString('binary')).not.toContain(DEFAULT_SECRET);
      // The AAD names the tenant and the field, so a blob cannot be moved
      // between rows and still authenticate.
      expect(row!.aad).toContain(IDS.tenant1);
      expect(row!.aad).toContain('radius_shared_secret');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('round-trips the secret through the sign-in path', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putRadius(request('PUT', SETTINGS));

    const resolved = await radiusForTenant(IDS.tenant1);
    expect(resolved?.server.secret).toBe(DEFAULT_SECRET);
    expect(resolved?.server.nasIdentifier).toBe('helm-test');
  });

  it('refuses a shared secret short enough to be guessed', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putRadius(request('PUT', { ...SETTINGS, secret: 'tooshort' }));
    expect(response.status).toBe(400);
  });

  it('requires a secret the first time and not afterwards', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');

    const { secret: _omitted, ...withoutSecret } = SETTINGS;
    expect((await putRadius(request('PUT', withoutSecret))).status).toBe(400);

    await putRadius(request('PUT', SETTINGS));
    const updated = await putRadius(request('PUT', { ...withoutSecret, timeoutMs: 9000 }));
    expect(updated.status).toBe(200);

    // The stored secret survived a settings-only save, which is the whole point
    // of not demanding it every time.
    const resolved = await radiusForTenant(IDS.tenant1);
    expect(resolved?.server.secret).toBe(DEFAULT_SECRET);
    expect(resolved?.server.timeoutMs).toBe(9000);
  });

  it('forgets the last test result when the settings change', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putRadius(request('PUT', SETTINGS));

    const sql = superuserSql();
    try {
      await sql`UPDATE radius_config SET last_test_at = now(), last_test_ok = true`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const { secret: _omitted, ...withoutSecret } = SETTINGS;
    const response = await putRadius(request('PUT', { ...withoutSecret, host: '10.0.0.9' }));
    expect(((await body(response)).radius as { lastTestOk: unknown }).lastTestOk).toBeNull();
  });

  it('refuses nonsense settings', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await putRadius(request('PUT', { ...SETTINGS, port: 0 }))).status).toBe(400);
    expect((await putRadius(request('PUT', { ...SETTINGS, timeoutMs: 10 }))).status).toBe(400);
    expect((await putRadius(request('PUT', { ...SETTINGS, nasIdentifier: 'has spaces' }))).status).toBe(400);
  });
});

describe('who may configure it', () => {
  it('refuses tier3, which holds almost everything else', async () => {
    // Changing how an entire MSP authenticates is a super_admin act. tier3 is
    // excluded from tenant:write in the seed, alongside organization:delete and
    // key:rotate.
    await setTechRole('tier3');
    asUser(IDS.tech1, 'tech1@northwind.test');

    expect((await putRadius(request('PUT', SETTINGS))).status).toBe(403);
    expect((await deleteRadius(request('DELETE'))).status).toBe(403);
    expect((await testRadius(request('POST', { mode: 'connection' }))).status).toBe(403);
  });

  it('lets tier3 see that RADIUS is configured', async () => {
    // A senior engineer taking a "why can I not sign in" call needs to know
    // whether the directory is in the path. Reading settings is not changing
    // them, and the secret is not in the result either way.
    asUser(IDS.admin1, 'admin@northwind.test');
    await putRadius(request('PUT', SETTINGS));

    await setTechRole('tier3');
    asUser(IDS.tech1, 'tech1@northwind.test');
    const response = await getRadius(request('GET'));
    expect(response.status).toBe(200);
    expect(((await body(response)).radius as { enabled: boolean }).enabled).toBe(true);
  });

  it('refuses a client-side role outright', async () => {
    // The refusal comes from the database, which raises insufficient_privilege;
    // the handler turns that into a 403 rather than letting a policy decision
    // surface as a fault.
    asUser(IDS.acmeAdmin, 'it@acme.test');
    expect((await getRadius(request('GET'))).status).toBe(403);
  });
});

describe('custody', () => {
  it('is unreadable by the role that renders every page', async () => {
    const sql = superuserSql();
    try {
      const [row] = await sql<{ readable: boolean; writable: boolean }[]>`
        SELECT has_table_privilege('helm_app', 'radius_config', 'SELECT') AS readable,
               has_table_privilege('helm_app', 'radius_config', 'UPDATE') AS writable
      `;
      expect(row!.readable).toBe(false);
      expect(row!.writable).toBe(false);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('is unreadable by the worker and auditor roles', async () => {
    // A background job that could read this could authenticate as anybody in
    // the directory.
    const sql = superuserSql();
    try {
      const [row] = await sql<{ worker: boolean; auditor: boolean }[]>`
        SELECT has_table_privilege('helm_worker', 'radius_config', 'SELECT') AS worker,
               has_table_privilege('helm_auditor', 'radius_config', 'SELECT') AS auditor
      `;
      expect(row!.worker).toBe(false);
      expect(row!.auditor).toBe(false);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses to open a row moved into another tenant', async () => {
    // The AAD binds the ciphertext to its tenant. Copy the row across and the
    // GCM tag fails, rather than tenant 2 quietly authenticating against tenant
    // 1's directory.
    const sealed = await sealRadiusSecret(IDS.tenant1, DEFAULT_SECRET);

    const sql = superuserSql();
    try {
      await sql`
        INSERT INTO radius_config (
          tenant_id, enabled, host, port, timeout_ms, retries, nas_identifier,
          wrap_provider, kek_id, wrapped_dek,
          secret_ciphertext, secret_nonce, secret_tag, secret_aad)
        VALUES (
          ${IDS.tenant2}::uuid, true, '127.0.0.1', 1812, 1500, 0::smallint, 'helm-test',
          ${sealed.wrapProvider}, ${sealed.kekId}, ${sealed.wrappedDek},
          ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.tag}, ${sealed.aad})
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    await expect(radiusForTenant(IDS.tenant2)).rejects.toThrow();
  });
});

describe('resolving a server for a sign-in', () => {
  it('finds it by the address signing in', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putRadius(request('PUT', SETTINGS));

    const resolved = await radiusForEmail('tech1@northwind.test');
    expect(resolved?.tenantId).toBe(IDS.tenant1);
  });

  it('finds nothing when RADIUS is switched off', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putRadius(request('PUT', { ...SETTINGS, enabled: false }));
    expect(await radiusForEmail('tech1@northwind.test')).toBeNull();
  });

  it('finds nothing for an address with no account', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putRadius(request('PUT', SETTINGS));
    expect(await radiusForEmail('nobody@northwind.test')).toBeNull();
  });

  it('finds nothing for a member of a different tenant', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putRadius(request('PUT', SETTINGS));
    // admin2 belongs to tenant 2, which has no RADIUS configuration.
    expect(await radiusForEmail('admin@rival.test')).toBeNull();
  });
});

describe('POST /api/auth/radius/test', () => {
  async function configureAgainst(options: Parameters<typeof FakeRadius.start>[0] = {}) {
    const fake = await FakeRadius.start(options);
    running.push(fake);
    asUser(IDS.admin1, 'admin@northwind.test');
    await putRadius(request('PUT', { ...SETTINGS, port: fake.port }));
    return fake;
  }

  it('passes the connection test when a server answers and the secret matches', async () => {
    await configureAgainst({ password: 'irrelevant' });
    const response = await testRadius(request('POST', { mode: 'connection' }));

    expect(response.status).toBe(200);
    const result = await body(response);
    // A rejection of the throwaway account is the expected answer: it is a
    // SIGNED rejection, which is what proves the secret matches.
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('reject');
  });

  it('fails the connection test when the secret does not match', async () => {
    await configureAgainst({ password: 'x', signWith: 'an-entirely-different-secret' });
    const result = await body(await testRadius(request('POST', { mode: 'connection' })));

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('bad_secret');
  });

  it('fails the connection test when nothing answers', async () => {
    await configureAgainst({ silent: true });
    const result = await body(await testRadius(request('POST', { mode: 'connection' })));

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('timeout');
  });

  it('accepts real credentials in the authentication test', async () => {
    await configureAgainst({ password: 'hunter2' });
    const result = await body(
      await testRadius(request('POST', { mode: 'authentication', username: 'tech', password: 'hunter2' })),
    );

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('accept');
  });

  it('reports a rejection as a failure in the authentication test', async () => {
    await configureAgainst({ password: 'hunter2' });
    const result = await body(
      await testRadius(request('POST', { mode: 'authentication', username: 'tech', password: 'wrong' })),
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('reject');
  });

  it('remembers what the test found', async () => {
    await configureAgainst({ password: 'irrelevant' });
    await testRadius(request('POST', { mode: 'connection' }));

    const response = await getRadius(request('GET'));
    const radius = (await body(response)).radius as { lastTestOk: boolean; lastTestAt: string };
    expect(radius.lastTestOk).toBe(true);
    expect(radius.lastTestAt).not.toBeNull();
  });

  it('says so when there is nothing configured to test', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await testRadius(request('POST', { mode: 'connection' }))).status).toBe(404);
  });
});

describe('DELETE /api/auth/radius', () => {
  it('removes the configuration and the stored secret with it', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putRadius(request('PUT', SETTINGS));

    expect((await deleteRadius(request('DELETE'))).status).toBe(200);
    expect(await radiusForTenant(IDS.tenant1)).toBeNull();

    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM radius_config`;
      expect(row!.n).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('says so when there is nothing to remove', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await deleteRadius(request('DELETE'))).status).toBe(404);
  });
});

describe('signing in through RADIUS', () => {
  async function enableAgainst(options: Parameters<typeof FakeRadius.start>[0] = {}) {
    const fake = await FakeRadius.start(options);
    running.push(fake);
    asUser(IDS.admin1, 'admin@northwind.test');
    await putRadius(request('PUT', { ...SETTINGS, port: fake.port }));
    currentUser = null;
    return fake;
  }

  async function giveLocalPassword(userId: string, password: string): Promise<void> {
    const sql = superuserSql();
    try {
      const phc = await hashPassword(password);
      await sql`SELECT helm.set_local_password(${userId}::uuid, ${phc}, false, NULL, 'test')`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  async function clearLocalPasswords(): Promise<void> {
    const sql = superuserSql();
    try {
      await sql`DELETE FROM local_credential`;
      await sql`DELETE FROM auth_attempt`;
      await sql`DELETE FROM auth_session`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  afterEach(clearLocalPasswords);

  it('lets in an account that has NO local password', async () => {
    // The case the whole feature exists for, and the one that was broken:
    // helm.local_login_challenge reports `found` for a LOCAL CREDENTIAL, not
    // for an account, so gating the RADIUS attempt on it confined the
    // directory to people who already had a password here.
    await enableAgainst({ password: 'directory-password' });

    const result = await attemptLocalLogin({
      email: 'tech1@northwind.test',
      password: 'directory-password',
      ip: '198.51.100.7',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe('radius');
      expect(result.mustChange).toBe(false);
      expect(result.sessionToken).not.toBe('');
    }
  });

  it('records the session as a RADIUS one', async () => {
    await enableAgainst({ password: 'directory-password' });
    await attemptLocalLogin({ email: 'tech1@northwind.test', password: 'directory-password' });

    const sql = superuserSql();
    try {
      const [row] = await sql<{ auth_method: string }[]>`
        SELECT auth_method::text FROM auth_session WHERE user_id = ${IDS.tech1}::uuid
      `;
      expect(row!.auth_method).toBe('radius');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses the wrong directory password', async () => {
    await enableAgainst({ password: 'directory-password' });
    const result = await attemptLocalLogin({
      email: 'tech1@northwind.test',
      password: 'not-it',
    });
    expect(result.ok).toBe(false);
  });

  it('falls through to the local password when RADIUS rejects', async () => {
    // The break-glass account. RADIUS does not know them; Helm does.
    await enableAgainst({ password: 'somebody-elses-password' });
    await giveLocalPassword(IDS.admin1, 'a-local-break-glass-password');

    const result = await attemptLocalLogin({
      email: 'admin@northwind.test',
      password: 'a-local-break-glass-password',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.method).toBe('password');
  });

  it('falls through to the local password when RADIUS is UNREACHABLE', async () => {
    // The morning the directory is down is the morning the vault is needed.
    await enableAgainst({ silent: true });
    await giveLocalPassword(IDS.admin1, 'a-local-break-glass-password');

    const result = await attemptLocalLogin({
      email: 'admin@northwind.test',
      password: 'a-local-break-glass-password',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.method).toBe('password');
  });

  it('records an unreachable directory without counting it against the throttle', async () => {
    // Visible to an operator, invisible to the rate limiter: a server outage
    // must not lock out the people it is already failing.
    await enableAgainst({ silent: true });
    await giveLocalPassword(IDS.admin1, 'a-local-break-glass-password');
    await attemptLocalLogin({ email: 'admin@northwind.test', password: 'a-local-break-glass-password' });

    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM auth_attempt WHERE outcome = 'radius_unavailable'
      `;
      expect(row!.n).toBeGreaterThan(0);

      // The throttle counts only these three, and the new outcome is not one.
      const [counted] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM auth_attempt
        WHERE outcome IN ('bad_password', 'no_such_account', 'disabled')
      `;
      expect(counted!.n).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('does not reach the directory when RADIUS is switched off', async () => {
    const fake = await FakeRadius.start({ password: 'directory-password' });
    running.push(fake);
    asUser(IDS.admin1, 'admin@northwind.test');
    await putRadius(request('PUT', { ...SETTINGS, port: fake.port, enabled: false }));
    currentUser = null;

    await giveLocalPassword(IDS.tech1, 'a-perfectly-good-local-password');
    const result = await attemptLocalLogin({
      email: 'tech1@northwind.test',
      password: 'a-perfectly-good-local-password',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.method).toBe('password');
    expect(fake.seen).toHaveLength(0);
  });

  it('never asks the directory about an address with no account', async () => {
    // Otherwise Helm becomes a way to enumerate somebody else's directory.
    const fake = await enableAgainst({ password: 'directory-password' });
    await attemptLocalLogin({ email: 'stranger@northwind.test', password: 'directory-password' });
    expect(fake.seen).toHaveLength(0);
  });

  it('never asks the directory about a disabled account, and refuses it', async () => {
    // Two properties, and the first is the one that matters. A revoked
    // technician must not be authenticated against their former employer's
    // directory at all — helm.radius_config_for_email joins through ACTIVE
    // memberships and a non-disabled user, so there is no configuration to
    // find and no packet is sent. The refusal then falls out of there being no
    // local password either.
    const fake = await enableAgainst({ password: 'directory-password' });

    const sql = superuserSql();
    try {
      await sql`UPDATE app_user SET disabled_at = now() WHERE id = ${IDS.tech1}::uuid`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    try {
      const result = await attemptLocalLogin({
        email: 'tech1@northwind.test',
        password: 'directory-password',
      });
      expect(result.ok).toBe(false);
      expect(fake.seen).toHaveLength(0);
    } finally {
      const restore = superuserSql();
      try {
        await restore`UPDATE app_user SET disabled_at = NULL WHERE id = ${IDS.tech1}::uuid`;
      } finally {
        await restore.end({ timeout: 5 });
      }
    }
  });

  it('refuses a member whose membership was revoked', async () => {
    // Same mechanism, the other half of the join: the configuration is reached
    // through an ACTIVE membership, so suspending one takes the directory away
    // with it.
    const fake = await enableAgainst({ password: 'directory-password' });

    const sql = superuserSql();
    try {
      await sql`
        UPDATE membership SET status = 'revoked'
        WHERE user_id = ${IDS.tech1}::uuid AND tenant_id = ${IDS.tenant1}::uuid
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    try {
      const result = await attemptLocalLogin({
        email: 'tech1@northwind.test',
        password: 'directory-password',
      });
      expect(result.ok).toBe(false);
      expect(fake.seen).toHaveLength(0);
    } finally {
      const restore = superuserSql();
      try {
        await restore`
          UPDATE membership SET status = 'active'
          WHERE user_id = ${IDS.tech1}::uuid AND tenant_id = ${IDS.tenant1}::uuid
        `;
      } finally {
        await restore.end({ timeout: 5 });
      }
    }
  });

  it('refuses a throttled attempt WITHOUT asking the directory', async () => {
    // The rate limiter has to come first, or Helm becomes a password-spray
    // amplifier pointed at somebody else's RADIUS server.
    const fake = await enableAgainst({ password: 'directory-password' });

    const sql = superuserSql();
    try {
      await sql`
        INSERT INTO auth_attempt (email, ip, outcome)
        SELECT 'tech1@northwind.test'::citext, '198.51.100.9'::inet, 'bad_password'
        FROM generate_series(1, 12)
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const result = await attemptLocalLogin({
      email: 'tech1@northwind.test',
      password: 'directory-password',
      ip: '198.51.100.9',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome).toBe('rate_limited');
    expect(fake.seen).toHaveLength(0);
  });
});
