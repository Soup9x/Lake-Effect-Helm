/**
 * Confirm it is you with the sign-in provider (1270), driven end to end
 * against a fake OpenID Connect provider that signs real id_tokens.
 *
 * As in step-up.test.ts, NOTHING here writes step_up_verification. Every
 * confirmation is the real start route, a redirect the fake provider answers,
 * and the real callback on /api/auth/callback/<slug>. The superuser connection
 * sets up the provider and the linked account, reads back what the flow wrote,
 * and ages a row to test the five-minute window.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { setLocalPassword } from '../../src/lib/auth/local';
import { sealOidcSecret } from '../../src/lib/auth/oidc-config';
import { finishSsoReauth, REAUTH_COOKIE } from '../../src/lib/auth/sso-reauth';
import { reauthenticate } from '../../src/lib/auth/reauthenticate';
import { resolveIdentity } from '../../src/lib/auth/identity';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { GET as startRoute } from '../../src/app/api/auth/reauth/sso/start/route';
import { GET as statusRoute } from '../../src/app/api/auth/reauth/sso/status/route';
import { GET as optionsRoute } from '../../src/app/api/auth/reauth/route';
import { POST as upgradeRoute } from '../../src/app/api/auth/field/upgrade/route';

const ADMIN_EMAIL = 'admin@northwind.test';
const TECH_EMAIL = 'tech@northwind.test';
const CLIENT_ID = 'helm-app';
const CLIENT_SECRET = 'fake-provider-secret';
const SLUG = 'entra';
const ADMIN_SUB = 'sub-of-admin';

process.env.AUTH_SECRET ??= 'test-auth-secret-for-sso-reauth-cookies';

let h: Harness;
let currentUser: SessionUser | null = null;

// ---------------------------------------------------------------------------
// The fake provider: discovery, keys, and a token endpoint that signs.
// ---------------------------------------------------------------------------

interface Grant {
  nonce: string;
  sub: string;
  authTime?: number;
  /** Sign with a key the provider does not publish. */
  foreignKey?: boolean;
}

class FakeProvider {
  readonly grants = new Map<string, Grant>();
  readonly tokenRequests: { auth: string | undefined; body: URLSearchParams }[] = [];
  private constructor(
    private readonly server: Server,
    readonly issuer: string,
  ) {}

  static async start(): Promise<FakeProvider> {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    let self: FakeProvider | null = null;
    let issuer = '';

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', issuer);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (url.pathname === '/.well-known/openid-configuration') {
        return send(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        });
      }
      if (url.pathname === '/jwks') {
        return send(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          const body = new URLSearchParams(raw);
          self!.tokenRequests.push({ auth: req.headers.authorization, body });
          const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
          if (req.headers.authorization !== expected) return send(401, { error: 'invalid_client' });
          const grant = self!.grants.get(body.get('code') ?? '');
          if (!grant) return send(400, { error: 'invalid_grant', error_description: 'unknown code' });
          self!.grants.delete(body.get('code') ?? '');
          const now = Math.floor(Date.now() / 1000);
          const idToken = sign(grant.foreignKey ? foreign : privateKey, {
            iss: issuer,
            aud: CLIENT_ID,
            sub: grant.sub,
            nonce: grant.nonce,
            iat: now,
            exp: now + 300,
            ...(grant.authTime !== undefined ? { auth_time: grant.authTime } : {}),
          });
          send(200, { access_token: 'x', token_type: 'Bearer', id_token: idToken });
        });
        return undefined;
      }
      return send(404, { error: 'not_found' });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    self = new FakeProvider(server, issuer);
    return self;
  }

  stop(): void {
    this.server.closeAllConnections?.();
    this.server.close();
  }
}

function sign(key: KeyObject, claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const data = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc(claims)}`;
  const signature = createSign('sha256').update(data).sign(key).toString('base64url');
  return `${data}.${signature}`;
}

// ---------------------------------------------------------------------------

let idp: FakeProvider;

const su = async <T,>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> => {
  const sql = superuserSql();
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
};

function get(path: string, cookie?: string): NextRequest {
  return new NextRequest(
    new Request(`http://helm.test${path}`, { headers: cookie ? { cookie } : {} }),
  );
}

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://helm.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://helm.test' },
      body: JSON.stringify(body),
    }),
  );
}

let ticketCounter = 0;
const newTicket = () => {
  ticketCounter += 1;
  return `ticket-${Date.now()}-${ticketCounter}`;
};

/** Start, let the provider "sign the person in", and land the callback. */
async function confirm(
  grant: Partial<Grant> = {},
  ticket = newTicket(),
): Promise<{ ticket: string; done: URL; response: Response }> {
  const started = await startRoute(get(`/api/auth/reauth/sso/start?t=${ticket}`));
  expect(started.status).toBe(303);
  const location = new URL(started.headers.get('location')!);
  expect(location.origin).toBe(idp.issuer);
  const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
  expect(cookie.startsWith(`${REAUTH_COOKIE}=`)).toBe(true);

  const state = location.searchParams.get('state')!;
  const nonce = location.searchParams.get('nonce')!;
  const code = `code-${ticket}`;
  idp.grants.set(code, {
    nonce,
    sub: ADMIN_SUB,
    authTime: Math.floor(Date.now() / 1000),
    ...grant,
  });

  const response = (await finishSsoReauth(
    get(`/api/auth/callback/${SLUG}?code=${code}&state=${state}`, cookie),
  ))!;
  expect(response).not.toBeNull();
  return { ticket, done: new URL(response.headers.get('location')!), response };
}

const verifications = () =>
  su((sql) => sql<{ method: string; request_id: string; consumed_at: Date | null }[]>`
    SELECT method, request_id, consumed_at FROM step_up_verification WHERE user_id = ${IDS.admin1}::uuid
  `);

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'test provisioning' });

  idp = await FakeProvider.start();
  const sealed = await sealOidcSecret(IDS.tenant1, CLIENT_SECRET);
  await su(async (sql) => {
    // The fake provider is plain http on loopback. The production rule that an
    // issuer is https is the settings page's business, not this flow's, so it
    // is lifted for this throwaway database only.
    await sql`ALTER TABLE oidc_provider DROP CONSTRAINT oidc_issuer_https`;
    await sql`
      INSERT INTO oidc_provider (tenant_id, enabled, slug, display_name, issuer, client_id,
                                 wrap_provider, kek_id, wrapped_dek,
                                 secret_ciphertext, secret_nonce, secret_tag, secret_aad)
      VALUES (${IDS.tenant1}::uuid, true, ${SLUG}, 'Microsoft 365', ${idp.issuer}, ${CLIENT_ID},
              ${sealed.wrapProvider}, ${sealed.kekId}, ${sealed.wrappedDek},
              ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.tag}, ${sealed.aad})
    `;
    // The admin signs in through the provider and has no Helm password.
    await sql`
      INSERT INTO auth_account (user_id, type, provider, provider_account_id)
      VALUES (${IDS.admin1}::uuid, 'oidc', ${SLUG}, ${ADMIN_SUB})
    `;
  });
  await setLocalPassword({
    userId: IDS.tech1,
    password: 'nineteen copper doorframes',
    context: { email: TECH_EMAIL, name: 'Tech' },
    reason: 'test setup',
    connection: 'auth',
  });
}, 120_000);

beforeEach(async () => {
  currentUser = { id: IDS.admin1, email: ADMIN_EMAIL };
  await su((sql) => sql`DELETE FROM step_up_verification`);
});

afterAll(async () => {
  idp?.stop();
  await disconnectPools();
});

describe('GET /api/auth/reauth', () => {
  it('offers the provider, and no password box, to an account linked to it without one', async () => {
    const body = await (await optionsRoute(get('/api/auth/reauth'))).json();
    expect(body).toEqual({ password: false, sso: { name: 'Microsoft 365' }, totp: false });
  });

  it('offers only the password to an account with no provider link', async () => {
    currentUser = { id: IDS.tech1, email: TECH_EMAIL };
    const body = await (await optionsRoute(get('/api/auth/reauth'))).json();
    expect(body).toEqual({ password: true, sso: null, totp: false });
  });
});

describe('a confirmation round trip', () => {
  it('asks the provider for a fresh sign-in, with PKCE, on the registered redirect URI', async () => {
    const started = await startRoute(get(`/api/auth/reauth/sso/start?t=${newTicket()}`));
    const location = new URL(started.headers.get('location')!);
    expect(location.pathname).toBe('/authorize');
    expect(location.searchParams.get('prompt')).toBe('login');
    expect(location.searchParams.get('max_age')).toBe('0');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('login_hint')).toBe(ADMIN_EMAIL);
    expect(location.searchParams.get('redirect_uri')).toBe(`http://helm.test/api/auth/callback/${SLUG}`);
    const cookie = started.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/auth\/callback/);
  });

  it('records a step-up for a good sign-in, and the waiting tab can see it', async () => {
    const { ticket, done } = await confirm();
    expect(done.pathname).toBe('/reauth/done');
    expect(done.searchParams.get('ok')).toBe('1');
    expect(done.searchParams.get('t')).toBe(ticket);

    const rows = await verifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe('sso_reauth');

    const status = await (await statusRoute(get(`/api/auth/reauth/sso/status?t=${ticket}`))).json();
    expect(status).toEqual({ done: true });

    // The client secret went over basic auth, with the PKCE verifier.
    const last = idp.tokenRequests.at(-1)!;
    expect(last.body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('clears its cookie whatever the outcome', async () => {
    const { response } = await confirm({ sub: 'somebody-else' });
    expect(response.headers.get('set-cookie')).toMatch(new RegExp(`${REAUTH_COOKIE}=;`));
  });

  it('refuses a sign-in as a different provider account', async () => {
    const { done } = await confirm({ sub: 'somebody-else' });
    expect(done.searchParams.get('ok')).toBeNull();
    expect(done.searchParams.get('error')).toMatch(/different account/);
    expect(await verifications()).toHaveLength(0);
  });

  it('refuses a token signed with a key the provider does not publish', async () => {
    const { done } = await confirm({ foreignKey: true });
    expect(done.searchParams.get('error')).toMatch(/signature/);
    expect(await verifications()).toHaveLength(0);
  });

  it('refuses a token whose nonce is not this confirmation’s', async () => {
    const { done } = await confirm({ nonce: 'replayed-nonce' });
    expect(done.searchParams.get('error')).toMatch(/does not belong/);
    expect(await verifications()).toHaveLength(0);
  });

  it('refuses a sign-in the provider did not actually redo', async () => {
    const { done } = await confirm({ authTime: Math.floor(Date.now() / 1000) - 3600 });
    expect(done.searchParams.get('error')).toMatch(/did not ask for your sign-in again/);
    expect(await verifications()).toHaveLength(0);
  });

  it('refuses when the browser is signed in to Helm as somebody else by the time it returns', async () => {
    const ticket = newTicket();
    const started = await startRoute(get(`/api/auth/reauth/sso/start?t=${ticket}`));
    const location = new URL(started.headers.get('location')!);
    const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
    idp.grants.set('c-switch', { nonce: location.searchParams.get('nonce')!, sub: ADMIN_SUB });

    currentUser = { id: IDS.tech1, email: TECH_EMAIL };
    const response = (await finishSsoReauth(
      get(`/api/auth/callback/${SLUG}?code=c-switch&state=${location.searchParams.get('state')}`, cookie),
    ))!;
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toMatch(/somebody else/);
  });

  it('leaves an ordinary sign-in callback to Auth.js', async () => {
    const started = await startRoute(get(`/api/auth/reauth/sso/start?t=${newTicket()}`));
    const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
    // Same path, same cookie, but Auth.js's own state.
    expect(await finishSsoReauth(get(`/api/auth/callback/${SLUG}?code=x&state=auth-js-state`, cookie))).toBeNull();
    // No cookie at all.
    expect(await finishSsoReauth(get(`/api/auth/callback/${SLUG}?code=x&state=whatever`))).toBeNull();
  });
});

describe('one-shot actions spend a confirmation once', () => {
  it('takes a ticket in place of the password, and only once', async () => {
    const { ticket } = await confirm();
    const identity = await resolveIdentity(get('/'));
    await expect(reauthenticate(get('/'), identity, { ssoTicket: ticket })).resolves.toBeInstanceOf(Date);
    await expect(reauthenticate(get('/'), identity, { ssoTicket: ticket })).rejects.toThrow(/expired or was already used/);
    expect((await verifications())[0]!.consumed_at).not.toBeNull();
  });

  it('will not spend a confirmation older than five minutes', async () => {
    const { ticket } = await confirm();
    await su((sql) => sql`UPDATE step_up_verification SET verified_at = now() - interval '6 minutes'`);
    const identity = await resolveIdentity(get('/'));
    await expect(reauthenticate(get('/'), identity, { ssoTicket: ticket })).rejects.toThrow(/expired/);
  });

  it('will not spend another person’s ticket', async () => {
    const { ticket } = await confirm();
    currentUser = { id: IDS.tech1, email: TECH_EMAIL };
    const identity = await resolveIdentity(get('/'));
    await expect(reauthenticate(get('/'), identity, { ssoTicket: ticket })).rejects.toThrow(/expired or was already used/);
  });

  it('opens the full site from Field view with a confirmation instead of a password', async () => {
    const { ticket } = await confirm();
    const response = await upgradeRoute(
      new NextRequest(
        new Request('http://helm.test/api/auth/field/upgrade', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://helm.test',
            cookie: 'authjs.session-token=not-a-real-session',
          },
          body: JSON.stringify({ ssoTicket: ticket }),
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, fieldMode: false });
  });

  it('refuses a request with neither a password nor a ticket', async () => {
    const response = await upgradeRoute(post('/api/auth/field/upgrade', {}));
    expect(response.status).toBe(400);
  });
});

describe('the database side', () => {
  it('gives helm_app no way to edit a verification directly', async () => {
    const [row] = await su((sql) => sql<{ upd: boolean; del: boolean }[]>`
      SELECT has_table_privilege('helm_app', 'step_up_verification', 'UPDATE') AS upd,
             has_table_privilege('helm_app', 'step_up_verification', 'DELETE') AS del
    `);
    expect(row).toEqual({ upd: false, del: false });
  });
});
