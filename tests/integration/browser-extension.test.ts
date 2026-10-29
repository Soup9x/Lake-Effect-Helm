/**
 * The browser extension (1120), through the real routes.
 *
 *   PAIRING      a person, from a session, MSP-side, with their password typed
 *                again (and their authenticator code, when they have one);
 *                never a client user, never a request that authenticated
 *                with a token, and never without a fresh step-up (1121).
 *   THE KEY      an extension token is half a credential: without a signature
 *                by the paired device key, or with a stale or wrong one, the
 *                request is the same flat 401 as an unknown token.
 *   LOOKUP       a site matches the credentials whose URL names it, exactly or
 *                under the same registrable domain, and the person's own vault.
 *   COPYING      a standard password and nothing else: no 'view', nothing
 *                elevated. The personal vault opens for 'copy' only, and
 *                cannot be written through the extension.
 *   FILLING      the same password for 'autofill', audited as a fill, with
 *                the same limits; in the personal vault too, and only for the
 *                extension.
 *   PERSONAL     a personal API token cannot read the vault at all (closing a
 *                gap 1030's comment said did not exist).
 *   LIFETIME     renewal replaces the token; unpairing stops it at once.
 *   TIDYING      a person renames their own browsers, and clears removed or
 *                lapsed ones off their list, never a live one (1180).
 *   ADMIN        somebody holding user:write sees every pairing and can
 *                revoke one; nobody else can.
 *   SUGGESTIONS  a site with no match offers what the person copied lately,
 *                and what MSP staff copy most; search finds near misses.
 *   SAVING       (1200) after a sign-in, Helm says whether it has the login
 *                and the password without revealing it; the extension saves
 *                a standard login to a client or the vault and updates the
 *                password of one matched to the site, and nothing else: no
 *                elevated secret, no other route, no pairing from before.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { setLocalPassword } from '../../src/lib/auth/local';
import { confirmEnrolment, removeTotp, startEnrolment } from '../../src/lib/auth/local-totp';
import { base32Decode, generateTotp } from '../../src/lib/crypto/totp';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import { canonicalRequest } from '../../src/lib/extension/signature';
import type { ExtensionEntry, ExtensionLookup, ExtensionPairing } from '../../src/lib/extension/types';
import {
  IDS, buildHarness, connectPools, disconnectPools, resetDatabase, superuserSql, type Harness,
} from './harness';

import { GET as listInstalls, POST as pair } from '../../src/app/api/extension/installs/route';
import { DELETE as unpair, PATCH as renameInstall } from '../../src/app/api/extension/installs/[installId]/route';
import { POST as clearInstalls } from '../../src/app/api/extension/installs/clear/route';
import { DELETE as adminRevoke } from '../../src/app/api/extension/admin/installs/[installId]/route';
import { DELETE as signOut, GET as me } from '../../src/app/api/extension/me/route';
import { POST as renew } from '../../src/app/api/extension/renew/route';
import { POST as match } from '../../src/app/api/extension/match/route';
import { POST as searchRoute } from '../../src/app/api/extension/search/route';
import { POST as createSecret } from '../../src/app/api/secrets/route';
import { POST as reveal } from '../../src/app/api/secrets/[secretId]/reveal/route';
import { POST as createEntry, GET as listVault } from '../../src/app/api/personal/vault/route';
import { POST as personalReveal } from '../../src/app/api/personal/vault/[entryId]/reveal/route';
import { DELETE as personalDelete } from '../../src/app/api/personal/vault/[entryId]/route';
import { POST as issueToken } from '../../src/app/api/account/tokens/route';
import { GET as destinations } from '../../src/app/api/extension/destinations/route';
import { POST as checkRoute } from '../../src/app/api/extension/check/route';
import { POST as saveRoute } from '../../src/app/api/extension/logins/route';
import { POST as updateRoute } from '../../src/app/api/extension/logins/update/route';
import { POST as rotateRoute } from '../../src/app/api/secrets/[secretId]/rotate/route';
import { POST as createAsset } from '../../src/app/api/assets/route';
import type { ExtensionDestinations, ExtensionLoginCheck, ExtensionSaved } from '../../src/lib/extension/types';

// Comparing a typed password with a stored one uses the blind index (1200).
process.env.HELM_BLIND_INDEX_KEY_B64 = Buffer.alloc(32, 7).toString('base64');

let h: Harness;
let currentUser: SessionUser | null = null;
const TECH: SessionUser = { id: IDS.tech1, email: 'tech1@northwind.test' };
const CLIENT: SessionUser = { id: IDS.acmeAdmin, email: 'it@acme.test' };

const PASSWORDS: Record<string, string> = {
  [IDS.tech1]: 'nineteen copper doorframes',
  [IDS.acmeAdmin]: 'eleven quiet harbours',
};

const ORIGIN = 'https://helm.test';
const PORTAL_PASSWORD = 'portal-password-4c1e';

interface Device { publicKey: KeyObject; privateKey: KeyObject; spki: string }
const newDevice = (): Device => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { publicKey, privateKey, spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') };
};

const sessionRequest = (path: string, method = 'GET', payload?: unknown) =>
  new NextRequest(new Request(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));

/** A request from the extension: its token, signed by its device key. */
function signed(
  device: Device,
  token: string,
  path: string,
  method = 'GET',
  payload?: unknown,
  overrides: { timestamp?: number; signPath?: string } = {},
): NextRequest {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const timestamp = String(overrides.timestamp ?? Date.now());
  const data = canonicalRequest({
    method,
    pathAndQuery: overrides.signPath ?? path,
    timestamp,
    bodySha256: createHash('sha256').update(body).digest('hex'),
  });
  const signature = sign('sha256', Buffer.from(data), { key: device.privateKey, dsaEncoding: 'ieee-p1363' });
  return new NextRequest(new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-helm-device-timestamp': timestamp,
      'x-helm-device-signature': signature.toString('base64url'),
    },
    ...(body ? { body } : {}),
  }));
}

const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
const params = <K extends string>(key: K, value: string) => ({ params: Promise.resolve({ [key]: value } as Record<K, string>) });

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

async function pairAs(
  user: SessionUser,
  device: Device,
  label = 'Work laptop',
  auth: { password?: string | undefined; code?: string } = { password: PASSWORDS[user.id] },
) {
  currentUser = user;
  const response = await pair(sessionRequest('/api/extension/installs', 'POST', {
    publicKey: device.spki, label, browser: 'Brave', extensionVersion: '0.1.0', ...auth,
  }));
  currentUser = null;
  return response;
}

let portal: { credentialId: string; secretId: string };
let elevated: { credentialId: string; secretId: string };
let personalId = '';

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'browser extension tests' });
  for (const user of [TECH, CLIENT]) {
    await setLocalPassword({
      userId: user.id,
      password: PASSWORDS[user.id]!,
      context: { email: user.email, name: user.email },
      reason: 'test setup',
      connection: 'auth',
    });
  }

  currentUser = TECH;
  const make = async (payload: Record<string, unknown>) => {
    const response = await createSecret(sessionRequest('/api/secrets', 'POST', {
      organizationId: IDS.orgAcme, credentialType: 'standard_user', ...payload,
    }));
    expect(response.status, await response.clone().text()).toBe(200);
    return json<{ credentialId: string; secretId: string }>(response);
  };
  portal = await make({
    label: 'Acme portal', username: 'helpdesk@acme-corp.test', url: 'https://portal.acme-corp.test/login',
    value: PORTAL_PASSWORD,
  });
  elevated = await make({
    label: 'Acme admin console', username: 'root', url: 'admin.acme-corp.test',
    value: 'elevated-password-77', sensitivity: 'elevated',
  });

  const created = await createEntry(sessionRequest('/api/personal/vault', 'POST', {
    name: 'My bank', username: 'tech1', url: 'https://www.bank.example/', password: 'bank-pw-1',
  }));
  expect(created.status, await created.clone().text()).toBe(200);
  personalId = (await json<{ entry: { id: string } }>(created)).entry.id;
  currentUser = null;
}, 180_000);

afterAll(async () => { await disconnectPools(); });

describe('pairing', () => {
  it('pairs a browser for MSP staff from a session, and audits it with the key fingerprint', async () => {
    const device = newDevice();
    const response = await pairAs(TECH, device);
    expect(response.status, await response.clone().text()).toBe(200);
    const paired = await json<ExtensionPairing>(response);
    expect(paired.token).toMatch(/^helm_be_[A-Za-z0-9]{8}\.[A-Za-z0-9_-]{32,}$/);
    expect(paired.keySha256).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);

    currentUser = TECH;
    const listed = await json<{ browsers: { id: string; label: string; live: boolean; fingerprint: string }[] }>(
      await listInstalls(sessionRequest('/api/extension/installs')),
    );
    currentUser = null;
    expect(listed.browsers).toEqual([
      expect.objectContaining({ id: paired.installId, label: 'Work laptop', live: true, fingerprint: paired.keySha256 }),
    ]);

    const [token] = await su((sql) => sql<{ token_type: string; scopes: string[]; expires_at: Date }[]>`
      SELECT token_type, scopes, expires_at FROM api_token WHERE token_prefix = ${paired.token.split('.')[0]!}`);
    expect(token!.token_type).toBe('browser_extension');
    expect(token!.scopes).toEqual(['asset:read', 'asset:write', 'organization:read', 'secret:read', 'secret:reveal', 'secret:write']);
    expect(token!.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(31 * 24 * 3600 * 1000);

    const [audit] = await su((sql) => sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log WHERE action = 'browser_extension.paired' AND entity_id = ${paired.installId}::uuid`);
    expect(audit!.metadata).toMatchObject({ label: 'Work laptop', browser: 'Brave' });
    expect(JSON.stringify(audit)).not.toContain(paired.token.split('.')[1]);
  });

  it('asks for the password again, and pairs nothing without the right one', async () => {
    const count = () => su(async (sql) =>
      (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM browser_extension_install`)[0]!.n);
    const before = await count();

    const missing = await pairAs(TECH, newDevice(), 'No password', {});
    expect(missing.status).toBe(400);
    const wrong = await pairAs(TECH, newDevice(), 'Wrong password', { password: 'not it at all' });
    expect(wrong.status).toBe(401);
    expect((await json<{ error: { message: string } }>(wrong)).error.message).toBe('That password is not correct.');

    expect(await count()).toBe(before);
    // The wrong one counted, as it would at sign-in.
    await su((sql) => sql`DELETE FROM auth_attempt`);
  });

  it('asks for the authenticator code too, when the person has one', async () => {
    const { secret } = await startEnrolment(TECH.id, TECH.email);
    const code = (offsetSeconds = 0) =>
      generateTotp(base32Decode(secret), { periodSeconds: 30 }, Date.now() + offsetSeconds * 1000).code;
    await confirmEnrolment(TECH.id, code());
    try {
      const first = await pairAs(TECH, newDevice(), 'Two factors');
      expect(first.status).toBe(401);
      expect((await json<{ error: { details: Record<string, unknown> } }>(first)).error.details)
        .toEqual({ secondFactor: 'totp' });

      const wrong = await pairAs(TECH, newDevice(), 'Two factors', { password: PASSWORDS[TECH.id], code: '000000' });
      expect(wrong.status).toBe(401);

      const right = await pairAs(TECH, newDevice(), 'Two factors', {
        password: PASSWORDS[TECH.id],
        // The next step's code: the one that confirmed enrolment is spent.
        code: code(30),
      });
      expect(right.status, await right.clone().text()).toBe(200);
    } finally {
      await removeTotp(TECH.id);
      await su((sql) => sql`DELETE FROM auth_attempt`);
    }
  });

  it('is refused by the database without a fresh step-up, whoever calls it', async () => {
    await su((sql) => sql`DELETE FROM step_up_verification`);
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: IDS.tech1 }, (tx) => tx`
      SELECT * FROM helm.pair_browser_extension(
        'Direct', NULL, NULL, decode(repeat('ab', 91), 'hex'), 'helm_be_direct00',
        decode(repeat('cd', 32), 'hex'), now() + interval '1 day')
    `)).rejects.toThrow(/re-enter your password/);
  });

  it('refuses a co-managed client user', async () => {
    const response = await pairAs(CLIENT, newDevice());
    expect(response.status).toBe(403);
  });

  it('refuses a key that is not P-256', async () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    currentUser = TECH;
    const response = await pair(sessionRequest('/api/extension/installs', 'POST', {
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), label: 'Odd',
    }));
    currentUser = null;
    expect(response.status).toBe(400);
  });

  it('cannot be done by a request that authenticated with a token', async () => {
    const device = newDevice();
    const paired = await json<ExtensionPairing>(await pairAs(TECH, device));
    const response = await pair(signed(device, paired.token, '/api/extension/installs', 'POST', {
      publicKey: newDevice().spki, label: 'Chained',
    }));
    expect(response.status).toBe(403);
  });
});

describe('the device signature', () => {
  let device: Device;
  let paired: ExtensionPairing;

  beforeAll(async () => {
    device = newDevice();
    paired = await json<ExtensionPairing>(await pairAs(TECH, device, 'Signature tests'));
  });

  it('lets a signed request through', async () => {
    const response = await me(signed(device, paired.token, '/api/extension/me'));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await json(response)).toMatchObject({
      installId: paired.installId, label: 'Signature tests', userEmail: 'tech1@northwind.test',
    });
  });

  it('refuses the token alone, a stranger\'s key, a stale time, another path and another body', async () => {
    const bare = new NextRequest(new Request(`${ORIGIN}/api/extension/me`, {
      headers: { authorization: `Bearer ${paired.token}` },
    }));
    expect((await me(bare)).status).toBe(401);
    expect((await me(signed(newDevice(), paired.token, '/api/extension/me'))).status).toBe(401);
    expect((await me(signed(device, paired.token, '/api/extension/me', 'GET', undefined, {
      timestamp: Date.now() - 10 * 60 * 1000,
    }))).status).toBe(401);
    expect((await me(signed(device, paired.token, '/api/extension/me', 'GET', undefined, {
      signPath: '/api/extension/renew',
    }))).status).toBe(401);

    // Signed for one body, sent with another.
    const good = signed(device, paired.token, '/api/extension/search', 'POST', { q: 'acme' });
    const tampered = new NextRequest(new Request(good.url, {
      method: 'POST', headers: good.headers, body: JSON.stringify({ q: 'bank' }),
    }));
    expect((await searchRoute(tampered)).status).toBe(401);
  });

  it('answers every refusal with the same flat message', async () => {
    const response = await me(signed(newDevice(), paired.token, '/api/extension/me'));
    expect((await json<{ error: { message: string } }>(response)).error.message).toBe('invalid API token');
  });
});

describe('looking up and copying', () => {
  let device: Device;
  let token: string;

  beforeAll(async () => {
    device = newDevice();
    token = (await json<ExtensionPairing>(await pairAs(TECH, device, 'Lookup tests'))).token;
  });

  const lookup = async (url: string) => {
    const response = await match(signed(device, token, '/api/extension/match', 'POST', { url }));
    expect(response.status, await response.clone().text()).toBe(200);
    return json<ExtensionLookup>(response);
  };

  it('matches the exact host first, then the rest of the site', async () => {
    const result = await lookup('https://portal.acme-corp.test/login?next=/');
    expect(result).toMatchObject({ host: 'portal.acme-corp.test', site: 'acme-corp.test' });
    expect(result.entries.map((e) => [e.name, e.match, e.passwordCopyable])).toEqual([
      ['Acme portal', 'host', true],
      ['Acme admin console', 'site', false],
    ]);
    const [first] = result.entries;
    expect(first).toMatchObject({
      kind: 'client', organizationName: expect.any(String), username: 'helpdesk@acme-corp.test',
      secretId: portal.secretId, hasPassword: true,
    });
    expect(JSON.stringify(result)).not.toContain(PORTAL_PASSWORD);
  });

  it('matches the person\'s own vault, and nothing for a lookalike or a browser page', async () => {
    const bank = await lookup('https://login.bank.example/');
    expect(bank.entries).toEqual([expect.objectContaining({ kind: 'personal', id: personalId, match: 'site' })]);
    expect((await lookup('https://portal.acme-corp.test.evil.example/')).entries).toEqual([]);
    expect((await lookup('chrome://newtab/')).entries).toEqual([]);
  });

  it('searches by name, username, client and URL', async () => {
    const response = await searchRoute(signed(device, token, '/api/extension/search', 'POST', { q: 'helpdesk@' }));
    const { entries } = await json<{ entries: ExtensionEntry[] }>(response);
    expect(entries.map((e) => e.name)).toEqual(['Acme portal']);

    const bank = await json<{ entries: ExtensionEntry[] }>(
      await searchRoute(signed(device, token, '/api/extension/search', 'POST', { q: 'bank' })),
    );
    expect(bank.entries.map((e) => e.kind)).toEqual(['personal']);
  });

  it('copies a standard password, audited as a copy', async () => {
    const path = `/api/secrets/${portal.secretId}/reveal`;
    const response = await reveal(signed(device, token, path, 'POST', { purpose: 'copy' }), params('secretId', portal.secretId));
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await json<{ value: string; auditEventUid: string }>(response);
    expect(body.value).toBe(PORTAL_PASSWORD);
    const [row] = await su((sql) => sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log WHERE event_uid = ${body.auditEventUid}::uuid`);
    expect(row!.metadata).toMatchObject({ purpose: 'copy' });
  });

  it('refuses to view, and refuses anything above standard, with the denial on record', async () => {
    const viewPath = `/api/secrets/${portal.secretId}/reveal`;
    const view = await reveal(signed(device, token, viewPath, 'POST', { purpose: 'view' }), params('secretId', portal.secretId));
    expect(view.status).toBe(403);

    const path = `/api/secrets/${elevated.secretId}/reveal`;
    const response = await reveal(signed(device, token, path, 'POST', { purpose: 'copy' }), params('secretId', elevated.secretId));
    expect(response.status).toBe(403);
    expect((await json<{ error: { message: string } }>(response)).error.message).toMatch(/open it in Helm/);

    const causes = await su((sql) => sql<{ cause: string }[]>`
      SELECT metadata->>'cause' AS cause FROM audit_log
      WHERE action = 'secret.reveal_denied' AND entity_id IN (${portal.secretId}::uuid, ${elevated.secretId}::uuid)`);
    expect(causes.map((c) => c.cause)).toEqual(['not_permitted_for_extension', 'not_permitted_for_extension']);
  });

  it('fills a standard password, audited as a fill, and nothing above standard', async () => {
    const path = `/api/secrets/${portal.secretId}/reveal`;
    const response = await reveal(signed(device, token, path, 'POST', { purpose: 'autofill' }), params('secretId', portal.secretId));
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await json<{ value: string; auditEventUid: string }>(response);
    expect(body.value).toBe(PORTAL_PASSWORD);
    const [row] = await su((sql) => sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log WHERE event_uid = ${body.auditEventUid}::uuid`);
    expect(row!.metadata).toMatchObject({ purpose: 'autofill' });

    const elevatedPath = `/api/secrets/${elevated.secretId}/reveal`;
    const refused = await reveal(
      signed(device, token, elevatedPath, 'POST', { purpose: 'autofill' }), params('secretId', elevated.secretId),
    );
    expect(refused.status).toBe(403);
  });

  it('still lets the same person view the elevated one from a browser session', async () => {
    currentUser = TECH;
    const response = await reveal(
      sessionRequest(`/api/secrets/${elevated.secretId}/reveal`, 'POST', { purpose: 'view' }),
      params('secretId', elevated.secretId),
    );
    currentUser = null;
    expect(response.status).toBe(200);
  });
});

describe('the personal vault', () => {
  let device: Device;
  let token: string;

  beforeAll(async () => {
    device = newDevice();
    token = (await json<ExtensionPairing>(await pairAs(TECH, device, 'Vault tests'))).token;
  });

  it('copies through the extension, and only copies', async () => {
    const path = `/api/personal/vault/${personalId}/reveal`;
    const copied = await personalReveal(signed(device, token, path, 'POST', { purpose: 'copy' }), params('entryId', personalId));
    expect(copied.status, await copied.clone().text()).toBe(200);
    expect((await json<{ value: string }>(copied)).value).toBe('bank-pw-1');

    const viewed = await personalReveal(signed(device, token, path, 'POST', { purpose: 'view' }), params('entryId', personalId));
    expect(viewed.status).toBe(403);
  });

  it('fills through the extension, audited as a fill, and fills for nobody else', async () => {
    const path = `/api/personal/vault/${personalId}/reveal`;
    const filled = await personalReveal(signed(device, token, path, 'POST', { purpose: 'autofill' }), params('entryId', personalId));
    expect(filled.status, await filled.clone().text()).toBe(200);
    const body = await json<{ value: string; auditEventUid: string }>(filled);
    expect(body.value).toBe('bank-pw-1');
    const [row] = await su((sql) => sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log WHERE event_uid = ${body.auditEventUid}::uuid`);
    expect(row!.metadata).toMatchObject({ purpose: 'autofill' });

    currentUser = TECH;
    const fromSession = await personalReveal(sessionRequest(path, 'POST', { purpose: 'autofill' }), params('entryId', personalId));
    currentUser = null;
    expect(fromSession.status).toBe(403);
  });

  it('cannot be listed, changed or deleted through the extension', async () => {
    expect((await listVault(signed(device, token, '/api/personal/vault'))).status).toBe(403);
    const path = `/api/personal/vault/${personalId}`;
    expect((await personalDelete(signed(device, token, path, 'DELETE'), params('entryId', personalId))).status).toBe(403);
  });

  it('is not writable by an extension token even below the routes', async () => {
    const [row] = await su((sql) => sql<{ id: string }[]>`
      SELECT t.id FROM api_token t WHERE t.token_prefix = ${token.split('.')[0]!}`);
    const deleted = await withTenant(
      { tenantId: IDS.tenant1, actorId: IDS.tech1, apiTokenId: row!.id },
      async (tx) => {
        const visible = await tx`SELECT id FROM personal_credential`;
        const gone = await tx`DELETE FROM personal_credential WHERE id = ${personalId}::uuid RETURNING id`;
        return { visible: visible.length, gone: gone.length };
      },
    );
    expect(deleted).toEqual({ visible: 1, gone: 0 });
  });

  it('is unreachable to a personal API token, by route and by policy', async () => {
    currentUser = TECH;
    const issued = await json<{ token: string; id: string }>(
      await issueToken(sessionRequest('/api/account/tokens', 'POST', { name: 'Script', scopes: ['*'] })),
    );
    currentUser = null;
    const listed = await listVault(new NextRequest(new Request(`${ORIGIN}/api/personal/vault`, {
      headers: { authorization: `Bearer ${issued.token}` },
    })));
    expect(listed.status).toBe(403);

    const rows = await withTenant(
      { tenantId: IDS.tenant1, actorId: IDS.tech1, apiTokenId: issued.id },
      (tx) => tx`SELECT id FROM personal_credential`,
    );
    expect(rows.length).toBe(0);
  });
});

describe('suggestions and search as you type', () => {
  let device: Device;
  let token: string;

  beforeAll(async () => {
    device = newDevice();
    token = (await json<ExtensionPairing>(await pairAs(TECH, device, 'Suggestion tests'))).token;
  });

  const lookup = async (url: string) =>
    json<ExtensionLookup>(await match(signed(device, token, '/api/extension/match', 'POST', { url })));
  const find = async (q: string) => {
    const response = await searchRoute(signed(device, token, '/api/extension/search', 'POST', { q }));
    expect(response.status, await response.clone().text()).toBe(200);
    return (await json<{ entries: ExtensionEntry[] }>(response)).entries;
  };

  it('offers what the person copied lately when the site matches nothing', async () => {
    const result = await lookup('https://nothing-here.example/');
    expect(result.entries).toEqual([]);
    const recent = result.suggestions!.recent;
    // Copied above: the portal password, and the personal entry.
    expect(recent.map((e) => e.name)).toEqual(expect.arrayContaining(['Acme portal', 'My bank']));
    expect(recent.find((e) => e.kind === 'personal')).toMatchObject({ id: personalId });
    // One list or the other, never both.
    const recentIds = new Set(recent.map((e) => e.id));
    expect(result.suggestions!.popular.filter((e) => recentIds.has(e.id))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(PORTAL_PASSWORD);

    // A browser page gets them too; a site that matched does not need them.
    expect((await lookup('chrome://newtab/')).suggestions?.recent.length).toBeGreaterThan(0);
    expect((await lookup('https://portal.acme-corp.test/')).suggestions).toBeUndefined();
  });

  it('counts colleagues\' copies for MSP staff only, and nobody else\'s vault at all', async () => {
    const activity = (actorId: string) => withTenant({ tenantId: IDS.tenant1, actorId }, (tx) =>
      tx<{ activity_entity_type: string; activity_entity_id: string; last_used_by_me: Date | null; uses: number }[]>`
        SELECT * FROM helm.extension_credential_activity()`);

    const admin = await activity(IDS.admin1);
    expect(admin.find((r) => r.activity_entity_id === portal.secretId))
      .toMatchObject({ last_used_by_me: null });
    expect(Number(admin.find((r) => r.activity_entity_id === portal.secretId)!.uses)).toBeGreaterThan(0);
    expect(admin.some((r) => r.activity_entity_type === 'personal_credential')).toBe(false);

    const client = await activity(IDS.acmeAdmin);
    expect(client.every((r) => Number(r.uses) === 0)).toBe(true);
  });

  it('searches from the first character, and finds a near miss', async () => {
    expect((await find('a')).length).toBeGreaterThan(0);
    expect((await find('portl')).map((e) => e.name)).toContain('Acme portal');
    expect((await find('zzzzqqq'))).toEqual([]);
  });
});

describe('renewing and unpairing', () => {
  it('renews: the new token works, the old one is refused', async () => {
    const device = newDevice();
    const first = await json<ExtensionPairing>(await pairAs(TECH, device, 'Renewal'));
    const renewed = await renew(signed(device, first.token, '/api/extension/renew', 'POST', {}));
    expect(renewed.status, await renewed.clone().text()).toBe(200);
    const next = await json<{ token: string; expiresAt: string }>(renewed);
    expect(next.token).not.toBe(first.token);

    expect((await me(signed(device, first.token, '/api/extension/me'))).status).toBe(401);
    const after = await me(signed(device, next.token, '/api/extension/me'));
    expect(after.status).toBe(200);
    expect((await json<{ installId: string }>(after)).installId).toBe(first.installId);
  });

  it('is refused to a browser session', async () => {
    currentUser = TECH;
    const response = await renew(sessionRequest('/api/extension/renew', 'POST', {}));
    currentUser = null;
    expect(response.status).toBe(403);
  });

  it('unpairing from Helm stops the extension on its next request', async () => {
    const device = newDevice();
    const paired = await json<ExtensionPairing>(await pairAs(TECH, device, 'To remove'));
    expect((await me(signed(device, paired.token, '/api/extension/me'))).status).toBe(200);

    currentUser = TECH;
    const removed = await unpair(
      sessionRequest(`/api/extension/installs/${paired.installId}`, 'DELETE'),
      params('installId', paired.installId),
    );
    currentUser = null;
    expect(removed.status).toBe(200);
    expect((await me(signed(device, paired.token, '/api/extension/me'))).status).toBe(401);
  });

  it('signing out of the extension unpairs it', async () => {
    const device = newDevice();
    const paired = await json<ExtensionPairing>(await pairAs(TECH, device, 'Sign out'));
    expect((await signOut(signed(device, paired.token, '/api/extension/me', 'DELETE'))).status).toBe(200);
    expect((await me(signed(device, paired.token, '/api/extension/me'))).status).toBe(401);
  });

  it('cannot unpair somebody else\'s browser', async () => {
    const device = newDevice();
    const paired = await json<ExtensionPairing>(await pairAs(TECH, device, 'Not yours'));
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const response = await unpair(
      sessionRequest(`/api/extension/installs/${paired.installId}`, 'DELETE'),
      params('installId', paired.installId),
    );
    currentUser = null;
    expect(response.status).toBe(404);
    expect((await me(signed(device, paired.token, '/api/extension/me'))).status).toBe(200);
  });
});

describe('renaming and clearing your browsers', () => {
  // Earlier blocks leave live pairings behind, and a person may have ten.
  beforeAll(async () => {
    await su((sql) => sql`
      UPDATE browser_extension_install SET revoked_at = now()
      WHERE user_id = ${IDS.tech1}::uuid AND revoked_at IS NULL`);
  });

  const listMine = async (user: SessionUser = TECH) => {
    currentUser = user;
    const response = await listInstalls(sessionRequest('/api/extension/installs'));
    currentUser = null;
    return (await json<{ browsers: { id: string; label: string; live: boolean }[] }>(response)).browsers;
  };
  const renameAs = async (user: SessionUser, id: string, label: string) => {
    currentUser = user;
    const response = await renameInstall(
      sessionRequest(`/api/extension/installs/${id}`, 'PATCH', { label }),
      params('installId', id),
    );
    currentUser = null;
    return response;
  };
  const clearAs = async (user: SessionUser, payload: Record<string, unknown> = {}) => {
    currentUser = user;
    const response = await clearInstalls(sessionRequest('/api/extension/installs/clear', 'POST', payload));
    currentUser = null;
    return response;
  };

  it('renames a browser and its token, audited with both names, and the extension keeps working', async () => {
    const device = newDevice();
    const paired = await json<ExtensionPairing>(await pairAs(TECH, device, 'Old name'));
    const response = await renameAs(TECH, paired.installId, '  Front desk PC  ');
    expect(response.status, await response.clone().text()).toBe(200);

    expect((await listMine()).find((b) => b.id === paired.installId)?.label).toBe('Front desk PC');
    const [token] = await su((sql) => sql<{ name: string }[]>`
      SELECT name FROM api_token WHERE token_prefix = ${paired.token.split('.')[0]!}`);
    expect(token?.name).toBe('Browser extension: Front desk PC');
    const audit = await su((sql) => sql<{ metadata: Record<string, string> }[]>`
      SELECT metadata FROM audit_log
      WHERE action = 'browser_extension.renamed' AND entity_id = ${paired.installId}::uuid`);
    expect(audit[0]?.metadata).toMatchObject({ from: 'Old name', to: 'Front desk PC' });
    expect((await me(signed(device, paired.token, '/api/extension/me'))).status).toBe(200);
  });

  it('refuses an empty name, and somebody else\'s browser', async () => {
    const paired = await json<ExtensionPairing>(await pairAs(TECH, newDevice(), 'Mine'));
    expect((await renameAs(TECH, paired.installId, '   ')).status).toBe(400);
    expect((await renameAs({ id: IDS.admin1, email: 'admin@northwind.test' }, paired.installId, 'Taken')).status)
      .toBe(404);
    expect((await listMine()).find((b) => b.id === paired.installId)?.label).toBe('Mine');
  });

  it('clears a removed browser off the list, and never a live one', async () => {
    const live = await json<ExtensionPairing>(await pairAs(TECH, newDevice(), 'Still here'));
    const gone = await json<ExtensionPairing>(await pairAs(TECH, newDevice(), 'Uninstalled'));
    currentUser = TECH;
    await unpair(sessionRequest(`/api/extension/installs/${gone.installId}`, 'DELETE'), params('installId', gone.installId));
    currentUser = null;

    expect((await clearAs(TECH, { id: live.installId })).status).toBe(404);
    const one = await clearAs(TECH, { id: gone.installId });
    expect(one.status, await one.clone().text()).toBe(200);
    expect(await json(one)).toMatchObject({ cleared: 1 });

    const mine = await listMine();
    expect(mine.some((b) => b.id === gone.installId)).toBe(false);
    expect(mine.some((b) => b.id === live.installId)).toBe(true);
  });

  it('clears every removed or lapsed browser at once, and an administrator still sees them', async () => {
    const lapsed = await json<ExtensionPairing>(await pairAs(TECH, newDevice(), 'Lapsed'));
    await su((sql) => sql`
      UPDATE api_token SET expires_at = now() - interval '1 day'
      WHERE token_prefix = ${lapsed.token.split('.')[0]!}`);
    const removed = await json<ExtensionPairing>(await pairAs(TECH, newDevice(), 'Removed'));
    currentUser = TECH;
    await unpair(sessionRequest(`/api/extension/installs/${removed.installId}`, 'DELETE'), params('installId', removed.installId));
    currentUser = null;

    const response = await clearAs(TECH);
    expect(response.status).toBe(200);
    expect((await json<{ cleared: number }>(response)).cleared).toBeGreaterThanOrEqual(2);

    const mine = await listMine();
    expect(mine.every((b) => b.live)).toBe(true);
    const kept = await su((sql) => sql<{ id: string }[]>`
      SELECT id FROM browser_extension_install
      WHERE id IN (${lapsed.installId}::uuid, ${removed.installId}::uuid) AND hidden_at IS NOT NULL`);
    expect(kept).toHaveLength(2);
  });
});

describe('every paired browser, for an administrator', () => {
  const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
  const asUser = async <T>(user: SessionUser, fn: () => Promise<T>) => {
    currentUser = user;
    try { return await fn(); } finally { currentUser = null; }
  };
  // The file has paired tech1 close to the limit of 10 live browsers by now.
  beforeAll(async () => {
    await su((sql) => sql`UPDATE browser_extension_install SET revoked_at = now()
                           WHERE user_id = ${IDS.tech1}::uuid AND revoked_at IS NULL`);
  });

  const tenantList = (actorId: string) => withTenant({ tenantId: IDS.tenant1, actorId }, (tx) =>
    tx<{ id: string; user_email: string; revoked_at: Date | null }[]>`SELECT * FROM helm.tenant_browser_extensions()`);

  it('lists everybody\'s pairings for somebody who manages people, and nobody else', async () => {
    const paired = await json<ExtensionPairing>(await pairAs(TECH, newDevice(), 'Admin list'));
    const rows = await tenantList(IDS.admin1);
    expect(rows.find((r) => r.id === paired.installId)).toMatchObject({ user_email: 'tech1@northwind.test' });
    await expect(tenantList(IDS.tech1)).rejects.toThrow(/user:write/);
  });

  it('revokes somebody else\'s browser, which stops it on its next request', async () => {
    const device = newDevice();
    const paired = await json<ExtensionPairing>(await pairAs(TECH, device, 'Revoked by admin'));
    expect((await me(signed(device, paired.token, '/api/extension/me'))).status).toBe(200);

    const refused = await asUser(TECH, () =>
      adminRevoke(sessionRequest(`/api/extension/admin/installs/${paired.installId}`, 'DELETE'),
        params('installId', paired.installId)));
    expect(refused.status).toBe(403);

    const revoked = await asUser(ADMIN, () =>
      adminRevoke(sessionRequest(`/api/extension/admin/installs/${paired.installId}`, 'DELETE'),
        params('installId', paired.installId)));
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect((await me(signed(device, paired.token, '/api/extension/me'))).status).toBe(401);

    const [audit] = await su((sql) => sql<{ actor_id: string; metadata: Record<string, unknown> }[]>`
      SELECT actor_id, metadata FROM audit_log
      WHERE action = 'browser_extension.revoked' AND entity_id = ${paired.installId}::uuid`);
    expect(audit).toMatchObject({ actor_id: IDS.admin1, metadata: { by: 'administrator', userId: IDS.tech1 } });

    const again = await asUser(ADMIN, () =>
      adminRevoke(sessionRequest(`/api/extension/admin/installs/${paired.installId}`, 'DELETE'),
        params('installId', paired.installId)));
    expect(again.status).toBe(404);
  });
});


describe('saving and updating logins (1200)', () => {
  let device: Device;
  let token: string;
  const SITE = 'https://portal.acme-corp.test/login?next=%2F';

  beforeAll(async () => {
    device = newDevice();
    token = (await json<ExtensionPairing>(await pairAs(TECH, device, 'Save tests'))).token;
  });

  const check = (payload: Record<string, unknown>) =>
    checkRoute(signed(device, token, '/api/extension/check', 'POST', payload));
  const save = (payload: Record<string, unknown>) =>
    saveRoute(signed(device, token, '/api/extension/logins', 'POST', payload));
  const update = (payload: Record<string, unknown>) =>
    updateRoute(signed(device, token, '/api/extension/logins/update', 'POST', payload));

  it('lists the clients a login can go to, with their sites', async () => {
    const response = await destinations(signed(device, token, '/api/extension/destinations'));
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await json<ExtensionDestinations>(response);
    expect(body.canSave).toBe(true);
    expect(body.organizations.map((o) => o.id)).toContain(IDS.orgAcme);
  });

  it('says whether Helm has a sign-in, and whether the password matches, without revealing it', async () => {
    const before = await su(async (sql) =>
      (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'secret.reveal%'`)[0]!.n);

    const same = await json<ExtensionLoginCheck>(await check({ url: SITE, username: 'HelpDesk@acme-corp.test', password: PORTAL_PASSWORD }));
    expect(same).toMatchObject({ state: 'same', host: 'portal.acme-corp.test', entry: { id: portal.credentialId } });

    const changed = await json<ExtensionLoginCheck>(await check({ url: SITE, username: 'helpdesk@acme-corp.test', password: 'a-new-one' }));
    expect(changed).toMatchObject({ state: 'changed', entry: { id: portal.credentialId } });

    const other = await json<ExtensionLoginCheck>(await check({ url: SITE, username: 'someone-else', password: 'x' }));
    expect(other).toMatchObject({ state: 'new', entry: null });

    // Elevated: Helm has it, the extension may not touch it, so it asks nothing.
    const admin = await json<ExtensionLoginCheck>(await check({ url: 'https://admin.acme-corp.test/', username: 'root', password: 'guess' }));
    expect(admin.state).toBe('skip');

    const after = await su(async (sql) =>
      (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'secret.reveal%'`)[0]!.n);
    expect(after).toBe(before);
  });

  it('compares with the personal vault too', async () => {
    const same = await json<ExtensionLoginCheck>(await check({ url: 'https://www.bank.example/signin', username: 'tech1', password: 'bank-pw-1' }));
    expect(same).toMatchObject({ state: 'same', entry: { kind: 'personal', id: personalId } });
    const changed = await json<ExtensionLoginCheck>(await check({ url: 'https://www.bank.example/signin', username: 'tech1', password: 'bank-pw-2' }));
    expect(changed).toMatchObject({ state: 'changed', entry: { kind: 'personal' } });
  });

  it('saves a standard login under a client, which then matches the site', async () => {
    const response = await save({
      destination: { kind: 'client', organizationId: IDS.orgAcme },
      name: 'Acme CRM', username: 'crm-admin', password: 'crm-pw-1', url: 'https://crm.acme-corp.test',
      tags: ['Saved From Browser'],
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = await json<ExtensionSaved>(response);
    expect(saved).toMatchObject({ kind: 'client', name: 'Acme CRM' });
    expect(JSON.stringify(saved)).not.toContain('crm-pw-1');

    const [row] = await su((sql) => sql<{ sensitivity: string; tags: string[]; username: string }[]>`
      SELECT s.sensitivity, n.tags, c.username FROM credential c
      JOIN asset_node n ON n.id = c.id JOIN secret s ON s.id = c.secret_id WHERE c.id = ${saved.id}::uuid`);
    expect(row).toEqual({ sensitivity: 'standard', tags: ['saved from browser'], username: 'crm-admin' });

    const again = await json<ExtensionLoginCheck>(await check({ url: 'https://crm.acme-corp.test/', username: 'crm-admin', password: 'crm-pw-1' }));
    expect(again.state).toBe('same');
  });

  it('saves to the personal vault, audited without its name', async () => {
    const response = await save({
      destination: { kind: 'personal' }, name: 'My forum', username: 'tech1', password: 'forum-pw', url: 'https://forum.example',
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = await json<ExtensionSaved>(response);
    expect(saved.kind).toBe('personal');
    const [audit] = await su((sql) => sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log WHERE action = 'personal_vault.saved' AND entity_id = ${saved.id}::uuid`);
    expect(audit!.metadata).toMatchObject({ source: 'browser_extension', change: 'created' });
    expect(JSON.stringify(audit)).not.toContain('My forum');
  });

  it('updates a client password to a new version, keeping the old, and the check then says same', async () => {
    const response = await update({ url: SITE, kind: 'client', id: portal.credentialId, password: 'portal-password-2' });
    expect(response.status, await response.clone().text()).toBe(200);
    const versions = await su(async (sql) =>
      (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM secret_version WHERE secret_id = ${portal.secretId}::uuid`)[0]!.n);
    expect(versions).toBe(2);
    const now = await json<ExtensionLoginCheck>(await check({ url: SITE, username: 'helpdesk@acme-corp.test', password: 'portal-password-2' }));
    expect(now.state).toBe('same');
  });

  it('updates a personal password', async () => {
    const response = await update({ url: 'https://www.bank.example/', kind: 'personal', id: personalId, password: 'bank-pw-2' });
    expect(response.status, await response.clone().text()).toBe(200);
    const path = `/api/personal/vault/${personalId}/reveal`;
    const copied = await personalReveal(signed(device, token, path, 'POST', { purpose: 'copy' }), params('entryId', personalId));
    expect((await json<{ value: string }>(copied)).value).toBe('bank-pw-2');
  });

  it('will not update a login on a site it does not belong to, or an elevated one', async () => {
    const elsewhere = await update({ url: 'https://evil.example/', kind: 'client', id: portal.credentialId, password: 'stolen' });
    expect(elsewhere.status).toBe(404);
    const high = await update({ url: 'https://admin.acme-corp.test/', kind: 'client', id: elevated.credentialId, password: 'x' });
    expect(high.status).toBe(403);
  });

  it('cannot save anything but a standard password, even below the routes', async () => {
    const [row] = await su((sql) => sql<{ id: string }[]>`
      SELECT t.id FROM api_token t WHERE t.token_prefix = ${token.split('.')[0]!}`);
    const actor = { tenantId: IDS.tenant1, actorId: IDS.tech1, apiTokenId: row!.id };
    await expect(withTenant(actor, (tx) => tx`
      INSERT INTO secret (tenant_id, organization_id, kind, sensitivity, label, requires_step_up, requires_reason)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'password', 'critical', 'Sneaky', true, true)
    `)).rejects.toThrow(/standard passwords only/);
    await expect(withTenant(actor, (tx) => tx`
      UPDATE secret SET sensitivity = 'standard', requires_step_up = false, requires_reason = false
      WHERE id = ${elevated.secretId}::uuid
    `)).rejects.toThrow(/cannot change how a credential is protected/);
  });

  it('reaches no route but its own, whatever its scopes allow', async () => {
    const rotate = await rotateRoute(
      signed(device, token, `/api/secrets/${elevated.secretId}/rotate`, 'POST', { value: 'x', reason: 'ten characters at least' }),
      params('secretId', elevated.secretId),
    );
    expect(rotate.status).toBe(403);
    const asset = await createAsset(signed(device, token, '/api/assets', 'POST', {
      organizationId: IDS.orgAcme, nodeType: 'vendor', name: 'Not from a browser',
    }));
    expect(asset.status).toBe(403);
    const personal = await createEntry(signed(device, token, '/api/personal/vault', 'POST', { name: 'x' }));
    expect(personal.status).toBe(403);
  });

  it('refuses to save from a pairing made before 1200, which says so', async () => {
    const old = newDevice();
    const paired = await json<ExtensionPairing>(await pairAs(TECH, old, 'Before saving'));
    await su((sql) => sql`
      UPDATE api_token SET scopes = ARRAY['asset:read', 'organization:read', 'secret:read', 'secret:reveal']
      WHERE token_prefix = ${paired.token.split('.')[0]!}`);
    const who = await json<{ canSave: boolean }>(await me(signed(old, paired.token, '/api/extension/me')));
    expect(who.canSave).toBe(false);
    const listed = await json<ExtensionDestinations>(await destinations(signed(old, paired.token, '/api/extension/destinations')));
    expect(listed).toEqual({ canSave: false, organizations: [] });
    const refused = await saveRoute(signed(old, paired.token, '/api/extension/logins', 'POST', {
      destination: { kind: 'personal' }, name: 'x', password: 'y',
    }));
    expect(refused.status).toBe(403);
  });
});
