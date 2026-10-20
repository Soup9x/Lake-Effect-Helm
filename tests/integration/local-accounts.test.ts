/**
 * Local accounts an administrator creates, and the emails that go with them
 * (1000), through the real routes, the real worker and a real SMTP relay.
 *
 *   SET HERE      a password set by an administrator signs the person in, and
 *                 they must change it; a weak one leaves nothing behind.
 *   BY EMAIL      a setup link goes out through the relay, works once, and
 *                 chooses the password; an SSO person is told they have access.
 *   SAYS WHY      no relay, or a relay refusing, is recorded on the row.
 *   AUTHORITY     user:write; not over somebody who outranks you; not over an
 *                 account another MSP also uses; the request role cannot set
 *                 anybody's password but its own.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import {
  IDS, buildHarness, connectPools, disconnectPools, resetDatabase, superuserSql, type Harness,
} from './harness';
import { POST as invite } from '../../src/app/api/users/route';
import { POST as passwordAction } from '../../src/app/api/users/[userId]/password/route';
import { accountEmailJob } from '../../src/workers/account-email';
import { attemptLocalLogin, redeemPasswordReset } from '../../src/lib/auth/local';
import { hashPassword } from '../../src/lib/auth/password';
import type { JobContext, JobLogger } from '../../src/workers/runtime';
import { FakeSmtp, bodyOf, subjectOf } from '../support/fake-smtp';

let h: Harness;
let relay: FakeSmtp;
let currentUser: SessionUser | null = null;
const asAdmin = () => {
  currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
};
const asTech = () => {
  currentUser = { id: IDS.tech1, email: 'tech1@northwind.test' };
};

const STRONG = 'correct horse battery staple 42';

const req = (path: string, payload: unknown) =>
  new NextRequest(new Request(`https://helm.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }));
const params = (userId: string) => ({ params: Promise.resolve({ userId }) });

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function configureRelay(): Promise<void> {
  await su((sql) => sql`
    INSERT INTO smtp_setting (tenant_id, enabled, host, port, security, tls_verify, tls_pinned_certificate,
                              from_address, from_name, allowed_recipient_domains)
    VALUES (${IDS.tenant1}::uuid, true, ${relay.host}, ${relay.port}, 'starttls', true, ${relay.certificatePem},
            'helm@northwind.test', 'Lake Effect Helm', '{}')
    ON CONFLICT (tenant_id) DO UPDATE SET enabled = true, host = EXCLUDED.host, port = EXCLUDED.port,
      tls_pinned_certificate = EXCLUDED.tls_pinned_certificate`);
}

function silent(): JobLogger {
  const make = (): JobLogger => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => make() });
  return make();
}
async function deliver(): Promise<Record<string, number>> {
  const ctx: JobContext = { log: silent(), stopping: () => false };
  return (await accountEmailJob().run(ctx)).counts ?? {};
}

const member = (email: string, extra: Record<string, unknown> = {}) => ({
  email, name: 'New Person', roleKey: 'tier1', orgScopeAll: true, ...extra,
});

async function emails(userEmail: string) {
  return su((sql) => sql<{ kind: string; status: string; last_error: string | null }[]>`
    SELECT e.kind, e.status, e.last_error FROM account_email e JOIN app_user u ON u.id = e.user_id
    WHERE u.email = ${userEmail} ORDER BY e.created_at`);
}

const linkIn = (body: string) => body.match(/https:\/\/helm\.northwind\.test\/sign-in\/reset\?token=([A-Za-z0-9_%-]+)(&setup=1)?/);

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'local account tests' });
  relay = await FakeSmtp.start();
  process.env.HELM_PUBLIC_URL = 'https://helm.northwind.test';
}, 180_000);

afterEach(async () => {
  currentUser = null;
  relay.received.length = 0;
  await su(async (sql) => {
    await sql`DELETE FROM smtp_setting`;
    await sql`DELETE FROM app_user WHERE email LIKE 'new-%'`;
    await sql`UPDATE membership SET role_key = 'tier1' WHERE user_id = ${IDS.tech1}::uuid`;
  });
});

afterAll(async () => {
  await relay.stop();
  delete process.env.HELM_PUBLIC_URL;
  await disconnectPools();
});

describe('an administrator sets the password', () => {
  it('creates a local account that signs in and must change its password', async () => {
    asAdmin();
    const response = await invite(req('/api/users', member('new-pat@northwind.test', { signIn: 'password', password: STRONG })));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signIn: 'password', emailQueued: null });

    const result = await attemptLocalLogin({ email: 'new-pat@northwind.test', password: STRONG, establishSession: false });
    expect(result.ok).toBe(true);
    expect(result.ok && result.mustChange).toBe(true);

    const audit = await su((sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.password_changed'
        AND actor_id = ${IDS.admin1}::uuid`);
    expect(audit[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it('refuses a weak password and leaves nobody half-added', async () => {
    asAdmin();
    const response = await invite(req('/api/users', member('new-weak@northwind.test', { signIn: 'password', password: 'password123' })));
    expect(response.status).toBe(400);
    const rows = await su((sql) => sql`SELECT 1 FROM membership m JOIN app_user u ON u.id = m.user_id
      WHERE u.email = 'new-weak@northwind.test'`);
    expect(rows).toHaveLength(0);
  });

  it('can set one later from the person’s row', async () => {
    asAdmin();
    const created = await (await invite(req('/api/users', member('new-later@northwind.test', { signIn: 'sso', notify: false })))).json() as { userId: string };
    const response = await passwordAction(req('/x', { action: 'set', password: STRONG, mustChange: false }), params(created.userId));
    expect(response.status).toBe(200);
    const result = await attemptLocalLogin({ email: 'new-later@northwind.test', password: STRONG, establishSession: false });
    expect(result.ok && result.mustChange).toBe(false);
  });
});

describe('Helm emails a link', () => {
  it('sends a setup link through the relay that chooses the password, once', async () => {
    await configureRelay();
    asAdmin();
    const response = await invite(req('/api/users', member('new-sam@northwind.test', { signIn: 'email_link' })));
    expect(await response.json()).toMatchObject({ emailQueued: 'password_setup' });
    expect(await emails('new-sam@northwind.test')).toEqual([{ kind: 'password_setup', status: 'pending', last_error: null }]);

    expect(await deliver()).toMatchObject({ sent: 1, failed: 0 });
    expect(relay.received).toHaveLength(1);
    const mail = relay.received[0]!;
    expect(mail.to).toEqual(['new-sam@northwind.test']);
    expect(subjectOf(mail)).toMatch(/Set up your Lake Effect Helm account/);
    const link = linkIn(bodyOf(mail));
    expect(link?.[2]).toBe('&setup=1');
    expect((await emails('new-sam@northwind.test'))[0]!.status).toBe('sent');

    // Nothing at rest holds the link.
    const token = decodeURIComponent(link![1]!);
    const stored = await su((sql) => sql<{ hit: number }[]>`
      SELECT count(*)::int AS hit FROM account_email WHERE row_to_json(account_email)::text LIKE ${'%' + token + '%'}`);
    expect(stored[0]!.hit).toBe(0);

    const redeemed = await redeemPasswordReset(token, STRONG);
    expect(redeemed.ok).toBe(true);
    expect((await redeemPasswordReset(token, STRONG)).ok).toBe(false);
    const login = await attemptLocalLogin({ email: 'new-sam@northwind.test', password: STRONG, establishSession: false });
    expect(login.ok).toBe(true);
  });

  it('tells a single sign-on person they have access', async () => {
    await configureRelay();
    asAdmin();
    await invite(req('/api/users', member('new-sso@northwind.test', { signIn: 'sso' })));
    await deliver();
    expect(relay.received).toHaveLength(1);
    expect(subjectOf(relay.received[0]!)).toMatch(/You have access to/);
    expect(bodyOf(relay.received[0]!)).toContain('https://helm.northwind.test/sign-in');
    expect(linkIn(bodyOf(relay.received[0]!))).toBeNull();
  });

  it('reaches a client’s staff at their own domain', async () => {
    await configureRelay();
    asAdmin();
    await invite(req('/api/users', {
      email: 'new-client@acme.test', roleKey: 'client_admin', orgScopeAll: false, orgScope: [IDS.orgAcme], signIn: 'email_link',
    }));
    expect(await deliver()).toMatchObject({ sent: 1 });
    expect(relay.received[0]!.to).toEqual(['new-client@acme.test']);
  });

  it('emails a reset link, not a setup link, to somebody who has a password', async () => {
    await configureRelay();
    asAdmin();
    const created = await (await invite(req('/api/users', member('new-reset@northwind.test', { signIn: 'password', password: STRONG })))).json() as { userId: string };
    const response = await passwordAction(req('/x', { action: 'email' }), params(created.userId));
    expect(await response.json()).toMatchObject({ emailQueued: 'password_reset' });
    await deliver();
    const link = linkIn(bodyOf(relay.received[0]!));
    expect(link).not.toBeNull();
    expect(link![2]).toBeUndefined();
  });

  it('says why when email is not set up, instead of failing silently', async () => {
    asAdmin();
    await invite(req('/api/users', member('new-nomail@northwind.test', { signIn: 'email_link' })));
    expect(await deliver()).toMatchObject({ failed: 1 });
    const [row] = await emails('new-nomail@northwind.test');
    expect(row).toMatchObject({ status: 'failed' });
    expect(row!.last_error).toMatch(/Email is not set up/);

    // And the People page can show it.
    const state = await withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, (tx) =>
      tx<{ email_status: string; email_error: string }[]>`
        SELECT s.email_status, s.email_error FROM helm.member_sign_in_state() s
        JOIN app_user u ON u.id = s.user_id WHERE u.email = 'new-nomail@northwind.test'`);
    expect(state[0]).toMatchObject({ email_status: 'failed' });
  });

  it('keeps trying while the relay is unreachable', async () => {
    await su((sql) => sql`
      INSERT INTO smtp_setting (tenant_id, enabled, host, port, security, tls_verify, from_address, allowed_recipient_domains)
      VALUES (${IDS.tenant1}::uuid, true, '127.0.0.1', 1, 'starttls', true, 'helm@northwind.test', '{}')`);
    asAdmin();
    await invite(req('/api/users', member('new-down@northwind.test', { signIn: 'email_link' })));
    await deliver();
    const [row] = await emails('new-down@northwind.test');
    expect(row).toMatchObject({ status: 'pending' });
    expect(row!.last_error).toBeTruthy();
  });
});

describe('who may', () => {
  it('needs user:write', async () => {
    asTech();
    expect((await invite(req('/api/users', member('new-x@northwind.test', { signIn: 'password', password: STRONG })))).status).toBe(403);
    expect((await passwordAction(req('/x', { action: 'email' }), params(IDS.admin1))).status).toBe(403);
  });

  it('does not let an administrator set the password of somebody who outranks them', async () => {
    await su((sql) => sql`UPDATE membership SET role_key = 'tier3' WHERE user_id = ${IDS.tech1}::uuid`);
    asTech();
    const response = await passwordAction(req('/x', { action: 'set', password: STRONG }), params(IDS.admin1));
    expect(response.status).toBe(403);
    expect((await passwordAction(req('/x', { action: 'email' }), params(IDS.admin1))).status).toBe(403);
  });

  it('does not touch an account another MSP also uses', async () => {
    asAdmin();
    const created = await (await invite(req('/api/users', member('new-shared@northwind.test', { signIn: 'sso', notify: false })))).json() as { userId: string };
    await su((sql) => sql`
      INSERT INTO membership (tenant_id, user_id, role_key, org_scope_all) VALUES (${IDS.tenant2}::uuid, ${created.userId}::uuid, 'tier1', true)`);
    const response = await passwordAction(req('/x', { action: 'set', password: STRONG }), params(created.userId));
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { message: string } }).error.message).toMatch(/another MSP/);
  });

  it('does not let the request role set anybody’s password but its own', async () => {
    const phc = await hashPassword(STRONG);
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, (tx) =>
      tx`SELECT helm.set_local_password(${IDS.tech1}::uuid, ${phc}, false, NULL, NULL)`,
    )).rejects.toThrow(/only your own password/);
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, (tx) =>
      tx`SELECT helm._write_local_password(${IDS.tech1}::uuid, ${phc}, false, NULL, NULL)`,
    )).rejects.toThrow(/permission denied/);
  });
});
