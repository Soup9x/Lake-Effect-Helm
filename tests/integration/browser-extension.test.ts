/**
 * The browser extension (1120), through the real routes.
 *
 *   PAIRING      a person, from a session, MSP-side; never a client user, and
 *                never a request that authenticated with a token.
 *   THE KEY      an extension token is half a credential: without a signature
 *                by the paired device key, or with a stale or wrong one, the
 *                request is the same flat 401 as an unknown token.
 *   LOOKUP       a site matches the credentials whose URL names it, exactly or
 *                under the same registrable domain, and the person's own vault.
 *   COPYING      a standard password and nothing else: no 'view', nothing
 *                elevated. The personal vault opens for 'copy' only, and
 *                cannot be written through the extension.
 *   PERSONAL     a personal API token cannot read the vault at all (closing a
 *                gap 1030's comment said did not exist).
 *   LIFETIME     renewal replaces the token; unpairing stops it at once.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import { canonicalRequest } from '../../src/lib/extension/signature';
import type { ExtensionEntry, ExtensionLookup, ExtensionPairing } from '../../src/lib/extension/types';
import {
  IDS, buildHarness, connectPools, disconnectPools, resetDatabase, superuserSql, type Harness,
} from './harness';

import { GET as listInstalls, POST as pair } from '../../src/app/api/extension/installs/route';
import { DELETE as unpair } from '../../src/app/api/extension/installs/[installId]/route';
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

let h: Harness;
let currentUser: SessionUser | null = null;
const TECH: SessionUser = { id: IDS.tech1, email: 'tech1@northwind.test' };
const CLIENT: SessionUser = { id: IDS.acmeAdmin, email: 'it@acme.test' };

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

async function pairAs(user: SessionUser, device: Device, label = 'Work laptop') {
  currentUser = user;
  const response = await pair(sessionRequest('/api/extension/installs', 'POST', {
    publicKey: device.spki, label, browser: 'Brave', extensionVersion: '0.1.0',
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
    expect(token!.scopes).toEqual(['asset:read', 'organization:read', 'secret:read', 'secret:reveal']);
    expect(token!.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(31 * 24 * 3600 * 1000);

    const [audit] = await su((sql) => sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log WHERE action = 'browser_extension.paired' AND entity_id = ${paired.installId}::uuid`);
    expect(audit!.metadata).toMatchObject({ label: 'Work laptop', browser: 'Brave' });
    expect(JSON.stringify(audit)).not.toContain(paired.token.split('.')[1]);
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
