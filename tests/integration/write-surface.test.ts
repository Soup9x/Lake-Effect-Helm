/**
 * The write surface: creating clients and storing credentials.
 *
 * Until this existed you could sign in to Helm and look at an empty database
 * forever, because the interface had no way to put anything into it. These are
 * the three routes that close that loop, and the properties worth asserting are
 * mostly about what they REFUSE.
 *
 * Two of them matter more than the rest:
 *
 *   The plaintext of a credential goes in and never comes back out. Not in the
 *   response, not in a validation error. The field most likely to fail
 *   validation is the one holding the password, and a framework that helpfully
 *   echoes the offending input would put it in the client's console, the proxy
 *   log and the error tracker.
 *
 *   Nothing here re-checks the tenant in the application. The tenant comes from
 *   the session and the rows are reachable only through RLS, so a request
 *   naming another tenant's organization matches nothing. These tests assert
 *   that from the outside — as a caller, not as a policy reader.
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

import {
  GET as listOrganizations,
  POST as createOrganization,
} from '../../src/app/api/organizations/route';
import { PATCH as patchOrganization } from '../../src/app/api/organizations/[organizationId]/route';
import { POST as createSecret } from '../../src/app/api/secrets/route';
import { POST as revealSecret } from '../../src/app/api/secrets/[secretId]/reveal/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const request = (url: string, init: RequestInit = {}) =>
  new NextRequest(new Request(`http://helm.test${url}`, init));

const post = (url: string, payload: unknown) =>
  request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

const patch = (url: string, payload: unknown) =>
  request(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

const body = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

/** Next passes route params as a promise; the handler awaits it. */
const withParams = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  // The routes resolve their SecretService from the composition root while the
  // harness holds its own. They must share a KEK or material written by one is
  // undecryptable by the other.
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'test provisioning' });
}, 120_000);

afterEach(() => {
  currentUser = null;
});

afterAll(async () => {
  await disconnectPools();
});

describe('POST /api/organizations', () => {
  it('adds a client that then appears in the list', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');

    const created = await createOrganization(
      post('/api/organizations', { name: 'Initech LLC', slug: 'initech' }),
    );
    expect(created.status).toBe(200);

    const payload = (await body(created)).organization as Record<string, unknown>;
    expect(payload.slug).toBe('initech');
    expect(payload.name).toBe('Initech LLC');

    asUser(IDS.admin1, 'admin@northwind.test');
    const listed = await listOrganizations(request('/api/organizations'));
    const organizations = (await body(listed)).organizations as { slug: string }[];
    expect(organizations.map((o) => o.slug)).toContain('initech');
  });

  it('refuses a role that has secret:write but not organization:write', async () => {
    // tier1 is the interesting case precisely because it is not powerless — it
    // can store credentials. Permissions are per action, not per seniority.
    asUser(IDS.tech1, 'tech@northwind.test');
    const response = await createOrganization(
      post('/api/organizations', { name: 'Should Not Exist', slug: 'should-not-exist' }),
    );
    expect(response.status).toBe(403);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM organization WHERE slug = 'should-not-exist'
      `;
      expect(row!.n).toBe('0');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('reports a duplicate slug as a conflict, not a constraint violation', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await createOrganization(
      post('/api/organizations', { name: 'Acme Again', slug: 'acme' }),
    );
    expect(response.status).toBe(409);
    expect(JSON.stringify(await body(response))).toContain('acme');
  });

  it('rejects a slug that is not URL-safe', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await createOrganization(
      post('/api/organizations', { name: 'Bad Slug', slug: 'Not A Slug!' }),
    );
    expect(response.status).toBe(400);
  });

  it('will not let a caller declare itself the MSP', async () => {
    // is_msp_internal decides which credentials an offboarding export treats as
    // the MSP's own. Exactly one organization per tenant has it, bootstrap
    // creates that one, and the field is not in the schema at all — so a body
    // that sets it is ignored rather than honoured.
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await createOrganization(
      post('/api/organizations', {
        name: 'Pretender',
        slug: 'pretender',
        isMspInternal: true,
        is_msp_internal: true,
      }),
    );
    expect(response.status).toBe(200);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ is_msp_internal: boolean }[]>`
        SELECT is_msp_internal FROM organization WHERE slug = 'pretender'
      `;
      expect(row!.is_msp_internal).toBe(false);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('takes the tenant from the session, never from the body', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await createOrganization(
      post('/api/organizations', {
        name: 'Tenant Confusion',
        slug: 'tenant-confusion',
        tenantId: IDS.tenant2,
        tenant_id: IDS.tenant2,
      }),
    );
    expect(response.status).toBe(200);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ tenant_id: string }[]>`
        SELECT tenant_id::text FROM organization WHERE slug = 'tenant-confusion'
      `;
      expect(row!.tenant_id).toBe(IDS.tenant1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('PATCH /api/organizations/[organizationId]', () => {
  it('renames a client', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchOrganization(
      patch(`/api/organizations/${IDS.orgGlobex}`, { name: 'Globex Corporation' }),
      withParams({ organizationId: IDS.orgGlobex }),
    );
    expect(response.status).toBe(200);
    expect(((await body(response)).organization as Record<string, unknown>).name).toBe(
      'Globex Corporation',
    );
  });

  it('keeps an absent field and clears an explicitly null one', async () => {
    // Two different requests that a naive COALESCE would conflate. "I did not
    // mention the website" and "remove the website" must not be the same thing.
    const sql = superuserSql();
    try {
      await sql`
        UPDATE organization SET industry = 'Manufacturing', website = 'https://globex.test'
        WHERE id = ${IDS.orgGlobex}::uuid
      `;

      asUser(IDS.admin1, 'admin@northwind.test');
      const response = await patchOrganization(
        patch(`/api/organizations/${IDS.orgGlobex}`, { website: null }),
        withParams({ organizationId: IDS.orgGlobex }),
      );
      expect(response.status).toBe(200);

      const [row] = await sql<{ industry: string | null; website: string | null }[]>`
        SELECT industry, website FROM organization WHERE id = ${IDS.orgGlobex}::uuid
      `;
      expect(row!.industry).toBe('Manufacturing');
      expect(row!.website).toBeNull();
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses an empty patch rather than reporting success', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchOrganization(
      patch(`/api/organizations/${IDS.orgGlobex}`, {}),
      withParams({ organizationId: IDS.orgGlobex }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses a slug already taken by another client', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchOrganization(
      patch(`/api/organizations/${IDS.orgGlobex}`, { slug: 'acme' }),
      withParams({ organizationId: IDS.orgGlobex }),
    );
    expect(response.status).toBe(409);
  });

  it("cannot reach another tenant's client", async () => {
    // admin2 is a super_admin — in tenant 2. Authority is per tenant, and the
    // row is simply not there to be updated.
    asUser(IDS.admin2, 'admin@contoso.test');
    const response = await patchOrganization(
      patch(`/api/organizations/${IDS.orgGlobex}`, { name: 'Taken Over' }),
      withParams({ organizationId: IDS.orgGlobex }),
    );
    expect(response.status).toBe(400);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ name: string }[]>`
        SELECT name FROM organization WHERE id = ${IDS.orgGlobex}::uuid
      `;
      expect(row!.name).not.toBe('Taken Over');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('POST /api/secrets', () => {
  const PLAINTEXT = 'correct horse battery staple 41';

  it('stores a credential that can then be revealed', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await createSecret(
      post('/api/secrets', {
        organizationId: IDS.orgAcme,
        label: 'Acme backup service account',
        kind: 'password',
        value: PLAINTEXT,
      }),
    );
    expect(created.status).toBe(200);

    const payload = await body(created);
    expect(payload.secretId).toEqual(expect.any(String));
    expect(payload.version).toBe(1);
    expect(payload.auditEventUid).toEqual(expect.any(String));

    asUser(IDS.admin1, 'admin@northwind.test');
    const revealed = await revealSecret(
      post(`/api/secrets/${payload.secretId as string}/reveal`, { purpose: 'view' }),
      withParams({ secretId: payload.secretId as string }),
    );
    expect(revealed.status).toBe(200);
    expect((await body(revealed)).value).toBe(PLAINTEXT);
  });

  it('never returns the plaintext from the create call itself', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await createSecret(
      post('/api/secrets', {
        organizationId: IDS.orgAcme,
        label: 'Echo check',
        kind: 'api_key',
        value: 'sk-live-do-not-echo-me',
      }),
    );
    expect(created.status).toBe(200);
    // The whole body, not just the fields we expect — a future addition that
    // included the input would be caught here.
    expect(JSON.stringify(await body(created))).not.toContain('do-not-echo-me');
  });

  it('never echoes the credential in a validation error', async () => {
    // The field most likely to fail validation is the one holding the password.
    // zod's issues carry `input` if you let them through; this asserts we do not.
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await createSecret(
      post('/api/secrets', {
        organizationId: IDS.orgAcme,
        label: '',
        kind: 'password',
        value: 'super-secret-do-not-leak',
      }),
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(await body(response))).not.toContain('do-not-leak');
  });

  it('writes an audit row naming the actor', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await createSecret(
      post('/api/secrets', {
        organizationId: IDS.orgAcme,
        label: 'Audited creation',
        kind: 'generic',
        value: 'value-for-audit',
      }),
    );
    const { secretId, auditEventUid } = await body(created);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ actor_id: string; action: string; entity_type: string }[]>`
        SELECT actor_id::text, action::text, entity_type::text
        FROM audit_log
        WHERE event_uid = ${auditEventUid as string}::uuid
      `;
      expect(row).toBeDefined();
      expect(row!.actor_id).toBe(IDS.admin1);
      expect(row!.entity_type).toBe('secret');

      // And the ciphertext is what landed in the table, not the plaintext.
      const [version] = await sql<{ ciphertext: Uint8Array }[]>`
        SELECT ciphertext FROM secret_version WHERE secret_id = ${secretId as string}::uuid
      `;
      expect(Buffer.from(version!.ciphertext).toString('utf8')).not.toContain('value-for-audit');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses a role without secret:write', async () => {
    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await createSecret(
      post('/api/secrets', {
        organizationId: IDS.orgAcme,
        label: 'Read only should not write',
        kind: 'password',
        value: 'nope',
      }),
    );
    expect(response.status).toBe(403);
  });

  it('cannot store a credential against a client the actor cannot reach', async () => {
    // acmeAdmin is scoped to Acme. Globex is in the same tenant and is still
    // not theirs; no application check says so, the row policy does.
    asUser(IDS.acmeAdmin, 'admin@acme.test');
    const response = await createSecret(
      post('/api/secrets', {
        organizationId: IDS.orgGlobex,
        label: 'Out of scope',
        kind: 'password',
        value: 'should-not-persist',
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM secret
        WHERE organization_id = ${IDS.orgGlobex}::uuid AND label = 'Out of scope'
      `;
      expect(row!.n).toBe('0');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
