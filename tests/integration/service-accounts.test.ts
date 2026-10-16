/**
 * Service accounts: the first way to create a machine identity from the
 * product, and the authority rules around it.
 *
 * What matters here: that creating one needs user:write and a session; that
 * the role granted cannot outrank the grantor and the scope cannot leave
 * theirs; that a token's scopes are bounded by the ACCOUNT'S role, not the
 * administrator's; that disabling the account or revoking the token refuses
 * the next request; and that an IP allow-list is enforced.
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

import { GET as listAccounts, POST as createAccount } from '../../src/app/api/tenant/service-accounts/route';
import { PATCH as patchAccount } from '../../src/app/api/tenant/service-accounts/[accountId]/route';
import {
  GET as listTokens,
  POST as issueToken,
} from '../../src/app/api/tenant/service-accounts/[accountId]/tokens/route';
import { DELETE as revokeToken } from '../../src/app/api/tenant/service-accounts/[accountId]/tokens/[tokenId]/route';
import { GET as organizationsRoute, POST as createOrganization } from '../../src/app/api/organizations/route';
import { GET as searchRoute } from '../../src/app/api/search/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const request = (url: string, init: RequestInit = {}) =>
  new NextRequest(new Request(`http://helm.test${url}`, init));

const json = (method: string, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  request(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const body = async (response: Response) => (await response.json()) as Record<string, unknown>;
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

/** One of the built-in worker identities 0290 seeds per tenant; tokens are refused for it. */
async function systemAccountId(): Promise<string> {
  const sql = superuserSql();
  try {
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM service_account WHERE tenant_id = ${IDS.tenant1}::uuid AND is_system ORDER BY name LIMIT 1
    `;
    return row!.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function create(payload: unknown) {
  const response = await createAccount(json('POST', '/api/tenant/service-accounts', payload));
  const parsed = await body(response);
  return { status: response.status, account: parsed.account as { id: string; name: string } | undefined, payload: parsed };
}

async function issue(accountId: string, payload: unknown, headers: Record<string, string> = {}) {
  const response = await issueToken(
    json('POST', `/api/tenant/service-accounts/${accountId}/tokens`, payload, headers),
    params({ accountId }),
  );
  const parsed = await body(response);
  return { status: response.status, payload: parsed as { token?: string; id?: string; error?: { message: string } } };
}

async function audit(action: string): Promise<Record<string, unknown>[]> {
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
    await sql`DELETE FROM service_account WHERE NOT is_system`;
  } finally {
    await sql.end({ timeout: 5 });
  }
});

afterAll(async () => {
  await disconnectPools();
});

describe('creating', () => {
  it('needs user:write, which tier1 does not hold', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const { status } = await create({ name: 'Nope', roleKey: 'tier1', orgScopeAll: true });
    expect(status).toBe(403);
  });

  it('creates an account an administrator can see, and audits it', async () => {
    asUser(IDS.admin1, 'admin1@northwind.test');
    const { status, account } = await create({
      name: 'nightly-backup', description: 'Pulls credentials for the backup job', roleKey: 'tier1', orgScopeAll: true,
    });
    expect(status).toBe(200);
    expect(account).toMatchObject({ name: 'nightly-backup' });

    const listed = await body(await listAccounts(request('/api/tenant/service-accounts')));
    const accounts = listed.accounts as Record<string, unknown>[];
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ roleKey: 'tier1', orgScopeAll: true, liveTokens: 0, disabledAt: null });
    // The built-in worker identities are not in this list.
    const system = await systemAccountId();
    expect(accounts.find((a) => a.id === system)).toBeUndefined();
    // And the roles offered stop at the caller's own rank, without the worker roles.
    const roles = listed.roles as { key: string }[];
    expect(roles.map((r) => r.key)).toContain('super_admin');
    expect(roles.map((r) => r.key).some((k) => k.startsWith('system_'))).toBe(false);

    const [row] = await audit('service_account.created');
    expect(row).toMatchObject({ actor_id: IDS.admin1, entity_type: 'service_account', entity_id: account!.id });
  });

  it('refuses a worker role, and a scope that is both or neither', async () => {
    asUser(IDS.admin1, 'admin1@northwind.test');
    expect((await create({ name: 'x', roleKey: 'system_sync', orgScopeAll: true })).status).toBe(400);
    expect((await create({ name: 'x', roleKey: 'tier1', orgScopeAll: false, orgScope: [] })).status).toBe(400);
    expect((await create({ name: 'x', roleKey: 'tier1', orgScopeAll: true, orgScope: [IDS.orgAcme] })).status).toBe(400);
  });

  it('refuses a client-scoped role with tenant-wide scope', async () => {
    asUser(IDS.admin1, 'admin1@northwind.test');
    const { status, payload } = await create({ name: 'x', roleKey: 'client_read_only', orgScopeAll: true });
    expect(status).toBe(400);
    expect(JSON.stringify(payload)).toContain('client-scoped');
  });

  it('cannot be done by a request that authenticated with a token', async () => {
    asUser(IDS.admin1, 'admin1@northwind.test');
    const { account } = await create({ name: 'seed', roleKey: 'super_admin', orgScopeAll: true });
    const { payload } = await issue(account!.id, { name: 'seed', scopes: ['*'] });
    currentUser = null;

    const response = await createAccount(
      json('POST', '/api/tenant/service-accounts', { name: 'chained', roleKey: 'tier1', orgScopeAll: true }, bearer(payload.token!)),
    );
    expect(response.status).toBe(403);
  });
});

describe('tokens', () => {
  it('are bounded by the account role, not the administrator', async () => {
    asUser(IDS.admin1, 'admin1@northwind.test'); // super_admin, holds organization:write
    const { account } = await create({ name: 'reader', roleKey: 'tier1', orgScopeAll: true });

    // tier1 does not hold organization:write, so neither may its token.
    const refused = await issue(account!.id, { name: 'too wide', scopes: ['organization:write'] });
    expect(refused.status).toBe(400);
    expect(refused.payload.error?.message).toContain('organization:write');

    const narrow = await issue(account!.id, { name: 'orgs only', scopes: ['organization:read'] });
    expect(narrow.status).toBe(200);
    expect(narrow.payload.token).toMatch(/^helm_sa_/);
    currentUser = null;

    expect((await organizationsRoute(request('/api/organizations', { headers: bearer(narrow.payload.token!) }))).status).toBe(200);
    // asset:read is tier1's, but not this token's.
    expect((await searchRoute(request('/api/search?q=acme', { headers: bearer(narrow.payload.token!) }))).status).toBe(403);

    // A wildcard token reaches everything tier1 can, and nothing tier1 cannot.
    asUser(IDS.admin1, 'admin1@northwind.test');
    const wide = await issue(account!.id, { name: 'all of tier1', scopes: ['*'] });
    currentUser = null;
    expect((await searchRoute(request('/api/search?q=acme', { headers: bearer(wide.payload.token!) }))).status).toBe(200);
    const stillNotAdmin = await createOrganization(
      json('POST', '/api/organizations', { slug: 'nope', name: 'Nope' }, bearer(wide.payload.token!)),
    );
    expect(stillNotAdmin.status).toBe(403);
  });

  it('are listed without the secret, with their use recorded', async () => {
    asUser(IDS.admin1, 'admin1@northwind.test');
    const { account } = await create({ name: 'probe', roleKey: 'tier1', orgScopeAll: true });
    const { payload } = await issue(account!.id, { name: 'monitor', scopes: ['organization:read'], ipAllowlist: ['203.0.113.9'] });
    currentUser = null;
    await organizationsRoute(request('/api/organizations', {
      headers: { ...bearer(payload.token!), 'x-forwarded-for': '203.0.113.9' },
    }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    asUser(IDS.admin1, 'admin1@northwind.test');
    const listed = await body(await listTokens(request(`/api/tenant/service-accounts/${account!.id}/tokens`), params({ accountId: account!.id })));
    const [row] = listed.tokens as Record<string, unknown>[];
    expect(row).toMatchObject({ name: 'monitor', live: true, ipAllowlist: ['203.0.113.9'] });
    expect(Number(row!.useCount)).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(listed)).not.toContain(payload.token!.split('.')[1]);
  });

  it('refuse an address outside the allow-list', async () => {
    asUser(IDS.admin1, 'admin1@northwind.test');
    const { account } = await create({ name: 'pinned', roleKey: 'tier1', orgScopeAll: true });
    const { payload } = await issue(account!.id, { name: 'from one host', scopes: ['*'], ipAllowlist: ['203.0.113.9'] });
    currentUser = null;

    const elsewhere = await organizationsRoute(request('/api/organizations', {
      headers: { ...bearer(payload.token!), 'x-forwarded-for': '198.51.100.7' },
    }));
    expect(elsewhere.status).toBe(401);
    const home = await organizationsRoute(request('/api/organizations', {
      headers: { ...bearer(payload.token!), 'x-forwarded-for': '203.0.113.9' },
    }));
    expect(home.status).toBe(200);
  });

  it('are refused for a built-in worker identity and for a disabled account', async () => {
    asUser(IDS.admin1, 'admin1@northwind.test');
    expect((await issue(await systemAccountId(), { name: 'x', scopes: ['*'] })).status).toBe(400);

    const { account } = await create({ name: 'paused', roleKey: 'tier1', orgScopeAll: true });
    const off = await patchAccount(json('PATCH', `/api/tenant/service-accounts/${account!.id}`, { disabled: true }), params({ accountId: account!.id }));
    expect(off.status).toBe(200);
    const { status, payload } = await issue(account!.id, { name: 'x', scopes: ['*'] });
    expect(status).toBe(400);
    expect(payload.error?.message).toContain('disabled');
  });
});

describe('disabling and revoking', () => {
  it('disabling the account refuses its tokens at once, and enabling restores them', async () => {
    asUser(IDS.admin1, 'admin1@northwind.test');
    const { account } = await create({ name: 'flaky', roleKey: 'tier1', orgScopeAll: true });
    const { payload } = await issue(account!.id, { name: 't', scopes: ['*'] });

    await patchAccount(json('PATCH', `/api/tenant/service-accounts/${account!.id}`, { disabled: true }), params({ accountId: account!.id }));
    currentUser = null;
    expect((await organizationsRoute(request('/api/organizations', { headers: bearer(payload.token!) }))).status).toBe(401);

    asUser(IDS.admin1, 'admin1@northwind.test');
    await patchAccount(json('PATCH', `/api/tenant/service-accounts/${account!.id}`, { disabled: false }), params({ accountId: account!.id }));
    currentUser = null;
    expect((await organizationsRoute(request('/api/organizations', { headers: bearer(payload.token!) }))).status).toBe(200);

    // The audit log is append-only and shared across this file's tests, so
    // look for this account's row rather than counting.
    const rows = await audit('service_account.disabled');
    expect(rows.filter((r) => r.entity_id === account!.id)).toHaveLength(1);
  });

  it('revoking a token refuses it at once and is audited', async () => {
    asUser(IDS.admin1, 'admin1@northwind.test');
    const { account } = await create({ name: 'leaky', roleKey: 'tier1', orgScopeAll: true });
    const { payload } = await issue(account!.id, { name: 'leaked', scopes: ['*'] });

    const revoked = await revokeToken(
      request(`/api/tenant/service-accounts/${account!.id}/tokens/${payload.id}`, { method: 'DELETE' }),
      params({ accountId: account!.id, tokenId: payload.id! }),
    );
    expect(revoked.status).toBe(200);
    currentUser = null;
    expect((await organizationsRoute(request('/api/organizations', { headers: bearer(payload.token!) }))).status).toBe(401);

    const rows = await audit('api_token.revoked');
    expect(rows.find((r) => r.entity_id === payload.id)).toBeDefined();
  });
});
