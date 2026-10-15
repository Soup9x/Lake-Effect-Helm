/**
 * Personal API tokens: the first way to create one from the product.
 *
 * Three things are being established. That the loop closes — issue, list,
 * authenticate with it, revoke, refused. That a token narrows and never widens:
 * a scope the issuer does not hold is refused at issue time, and a token's
 * scopes bound what it can do afterwards. And that the two routes cannot be
 * turned on anybody else — a token id that is not yours answers "no such
 * token", and a request that authenticated WITH a token cannot mint another.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { GET as listTokens, POST as issueToken } from '../../src/app/api/account/tokens/route';
import { DELETE as revokeToken } from '../../src/app/api/account/tokens/[tokenId]/route';
import { GET as organizationsRoute, POST as createOrganization } from '../../src/app/api/organizations/route';
import { GET as searchRoute } from '../../src/app/api/search/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const request = (url: string, init: RequestInit = {}) =>
  new NextRequest(new Request(`http://helm.test${url}`, init));

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

interface IssuedBody {
  token: string;
  id: string;
  prefix: string;
  expiresAt: string;
  scopes: string[];
}

async function issue(payload: unknown, headers: Record<string, string> = {}) {
  const response = await issueToken(post('/api/account/tokens', payload, headers));
  return { status: response.status, payload: (await body(response)) as unknown as IssuedBody & { error?: { message: string } } };
}

async function revoke(id: string, headers: Record<string, string> = {}) {
  return revokeToken(request(`/api/account/tokens/${id}`, { method: 'DELETE', headers }), {
    params: Promise.resolve({ tokenId: id }),
  });
}

async function auditRows(action: string): Promise<Record<string, unknown>[]> {
  const sql = superuserSql();
  try {
    return await sql<Record<string, unknown>[]>`
      SELECT actor_id, entity_type, entity_id, metadata FROM audit_log WHERE action = ${action}
    `;
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
  const sql = superuserSql();
  try {
    await sql`DELETE FROM api_token`;
  } finally {
    await sql.end({ timeout: 5 });
  }
});

afterAll(async () => {
  await disconnectPools();
});

describe('issuing', () => {
  it('returns the token exactly once, and the row holds only its hash', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const { status, payload } = await issue({ name: 'Backup script', scopes: ['*'], expiresInDays: 30 });
    expect(status).toBe(200);
    expect(payload.token).toMatch(/^helm_pa_[A-Za-z0-9]{8}\.[A-Za-z0-9_-]{32,}$/);
    expect(payload.prefix).toBe(payload.token.split('.')[0]);
    expect(payload.scopes).toEqual(['*']);

    // The list never carries the token.
    const listed = await body(await listTokens(request('/api/account/tokens')));
    const [row] = listed.tokens as Record<string, unknown>[];
    expect(row).toMatchObject({ id: payload.id, name: 'Backup script', prefix: payload.prefix, live: true });
    expect(JSON.stringify(listed)).not.toContain(payload.token);

    // Nor does the table, nor the audit row.
    const sql = superuserSql();
    try {
      const [stored] = await sql<{ token_type: string; user_id: string; token_hash: Buffer }[]>`
        SELECT token_type, user_id, token_hash FROM api_token WHERE id = ${payload.id}::uuid
      `;
      expect(stored).toMatchObject({ token_type: 'user_pat', user_id: IDS.tech1 });
      expect(stored!.token_hash.length).toBe(32);
    } finally {
      await sql.end({ timeout: 5 });
    }
    const [audit] = await auditRows('api_token.issued');
    expect(audit).toMatchObject({ actor_id: IDS.tech1, entity_type: 'api_token', entity_id: payload.id });
    expect(JSON.stringify(audit!.metadata)).not.toContain(payload.token.split('.')[1]);
  });

  it('refuses a scope the issuer does not hold', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test'); // tier1: no organization:write
    const { status, payload } = await issue({ name: 'Too wide', scopes: ['organization:read', 'organization:write'] });
    expect(status).toBe(400);
    expect(payload.error?.message).toContain('organization:write');
  });

  it('refuses a malformed request before the database is asked', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    expect((await issue({ name: '', scopes: ['*'] })).status).toBe(400);
    expect((await issue({ name: 'x', scopes: [] })).status).toBe(400);
    expect((await issue({ name: 'x', scopes: ['*'], expiresInDays: 400 })).status).toBe(400);
    expect((await issue({ name: 'x', scopes: ['*', 'asset:read'] })).status).toBe(400);
  });

  it('cannot be done by a request that authenticated with a token', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const { payload: first } = await issue({ name: 'Seed', scopes: ['*'] });
    currentUser = null;

    const { status, payload } = await issue({ name: 'Chained', scopes: ['*'] }, bearer(first.token));
    expect(status).toBe(403);
    expect(payload.error?.message).toMatch(/authenticated with a token/);
  });
});

describe('using', () => {
  it('authenticates as the issuer, narrowed to the scopes', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const { payload } = await issue({ name: 'Read-only', scopes: ['organization:read'] });
    currentUser = null;

    const listed = await organizationsRoute(request('/api/organizations', { headers: bearer(payload.token) }));
    expect(listed.status).toBe(200);

    // tier1 holds asset:read; this token does not carry it.
    const refused = await searchRoute(request('/api/search?q=acme', { headers: bearer(payload.token) }));
    expect(refused.status).toBe(403);

    // And a wildcard token can do what the role can, and no more.
    asUser(IDS.tech1, 'tech1@northwind.test');
    const { payload: wide } = await issue({ name: 'Everything', scopes: ['*'] });
    currentUser = null;
    const stillNotAdmin = await createOrganization(
      post('/api/organizations', { slug: 'nope', name: 'Nope', status: 'active', relationship: 'client', timezone: 'UTC' }, bearer(wide.token)),
    );
    expect(stillNotAdmin.status).toBe(403);
  });

  it('records last use against the token', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const { payload } = await issue({ name: 'Used', scopes: ['*'] });
    currentUser = null;
    await organizationsRoute(request('/api/organizations', { headers: bearer(payload.token) }));

    // Usage accounting is fire-and-forget; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 200));
    asUser(IDS.tech1, 'tech1@northwind.test');
    const listed = await body(await listTokens(request('/api/account/tokens')));
    const [row] = listed.tokens as { useCount: number; lastUsedAt: string | null }[];
    expect(row!.useCount).toBeGreaterThanOrEqual(1);
    expect(row!.lastUsedAt).not.toBeNull();
  });
});

describe('revoking', () => {
  it('takes effect on the next request and is audited', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const { payload } = await issue({ name: 'Leaked', scopes: ['*'] });

    const revoked = await revoke(payload.id);
    expect(revoked.status).toBe(200);
    currentUser = null;

    const refused = await organizationsRoute(request('/api/organizations', { headers: bearer(payload.token) }));
    expect(refused.status).toBe(401);
    expect((await body(refused)).error).toMatchObject({ message: 'invalid API token' });

    const [audit] = await auditRows('api_token.revoked');
    expect(audit).toMatchObject({ actor_id: IDS.tech1, entity_id: payload.id });

    // Still listed, marked, so "did it take" has an answer on the page.
    asUser(IDS.tech1, 'tech1@northwind.test');
    const listed = await body(await listTokens(request('/api/account/tokens')));
    expect((listed.tokens as { live: boolean; revokedAt: string | null }[])[0]).toMatchObject({ live: false });
  });

  it('cannot be pointed at somebody else’s token', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const { payload } = await issue({ name: 'Mine', scopes: ['*'] });

    asUser(IDS.admin1, 'admin1@northwind.test'); // outranks tech1, and it does not matter
    const response = await revoke(payload.id);
    expect(response.status).toBe(404);

    currentUser = null;
    const stillWorks = await organizationsRoute(request('/api/organizations', { headers: bearer(payload.token) }));
    expect(stillWorks.status).toBe(200);
  });

  it('may revoke the very token making the request', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const { payload } = await issue({ name: 'Self', scopes: ['*'] });
    currentUser = null;

    const response = await revoke(payload.id, bearer(payload.token));
    expect(response.status).toBe(200);
    const after = await organizationsRoute(request('/api/organizations', { headers: bearer(payload.token) }));
    expect(after.status).toBe(401);
  });
});
