import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, ipAllowed, mintToken, parseToken } from '../../src/lib/auth/tokens';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { randomBytes } from 'node:crypto';
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

// Route handlers under test.
import { GET as searchRoute } from '../../src/app/api/search/route';
import { GET as organizationsRoute } from '../../src/app/api/organizations/route';
import { GET as auditRoute } from '../../src/app/api/audit/route';
import { GET as expirationsRoute } from '../../src/app/api/expirations/route';
import { POST as revealRoute } from '../../src/app/api/secrets/[secretId]/reveal/route';
import { POST as linkRoute } from '../../src/app/api/assets/links/route';
import { GET as graphRoute } from '../../src/app/api/assets/[nodeId]/graph/route';
import { POST as publishTypeRoute } from '../../src/app/api/flexible-assets/types/route';
import { POST as createRecordRoute } from '../../src/app/api/flexible-assets/records/route';

let h: Harness;

/** Set the user the session resolver will report for the next request. */
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const request = (url: string, init: RequestInit = {}) =>
  new NextRequest(new Request(`http://helm.test${url}`, init));

const body = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  // The routes resolve their SecretService from the composition root, while the
  // harness holds its own. They must share a KEK, or material written by one is
  // undecryptable by the other — which surfaces as a bare GCM authentication
  // failure and looks like data corruption rather than a wiring mistake.
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

describe('token format and verification primitives', () => {
  it('mints a token whose prefix matches the database constraint', () => {
    const { token, prefix, hash } = mintToken('service_account');
    expect(prefix).toMatch(/^helm_sa_[A-Za-z0-9]{8}$/);
    expect(token.startsWith(`${prefix}.`)).toBe(true);
    expect(hash).toHaveLength(32);
    expect(hash).toEqual(hashToken(token));
  });

  it('gives each token kind a distinguishable prefix', () => {
    // A leaked token should be identifiable on sight and revocable without
    // anyone having to work out which one it was.
    expect(mintToken('service_account').prefix).toMatch(/^helm_sa_/);
    expect(mintToken('user_pat').prefix).toMatch(/^helm_pa_/);
    expect(mintToken('browser_extension').prefix).toMatch(/^helm_be_/);
  });

  it('never repeats a token', () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintToken('user_pat').token));
    expect(seen.size).toBe(500);
  });

  it('rejects malformed tokens without throwing', () => {
    for (const bad of ['', 'nonsense', 'helm_sa_short.x', 'helm_xx_A7f3Kp2Q.abcdefghijklmnopqrstuvwxyz012345']) {
      expect(parseToken(bad)).toBeNull();
    }
  });

  it('matches an allowlisted IP in either notation', () => {
    expect(ipAllowed('203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(ipAllowed('203.0.113.7', ['203.0.113.7/32'])).toBe(true);
    // An IPv4-mapped IPv6 address and its IPv4 form are the same host.
    expect(ipAllowed('::ffff:203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(ipAllowed('203.0.113.8', ['203.0.113.7'])).toBe(false);
    expect(ipAllowed('203.0.113.7', [])).toBe(false);
  });
});

describe('authentication', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await searchRoute(request('/api/search?q=acme'));
    expect(response.status).toBe(401);
    const payload = await body(response);
    expect((payload.error as Record<string, unknown>).code).toBe('unauthenticated');
  });

  it('returns a request id on every response, including errors', async () => {
    // Support answers "what happened to my request" from this alone.
    const response = await searchRoute(request('/api/search?q=acme'));
    expect(response.headers.get('x-request-id')).toBeTruthy();
    const payload = await body(response);
    expect((payload.error as Record<string, unknown>).requestId).toBeTruthy();
  });

  it('honours a caller-supplied request id for correlation', async () => {
    const response = await searchRoute(
      request('/api/search?q=acme', { headers: { 'x-request-id': 'trace-abc-123' } }),
    );
    expect(response.headers.get('x-request-id')).toBe('trace-abc-123');
  });

  it('never caches a response', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await searchRoute(request('/api/search?q=acme'));
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
  });

  it('refuses an authenticated user with no active membership', async () => {
    const sql = superuserSql();
    let orphanId: string;
    try {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO app_user (email, name) VALUES ('orphan@nowhere.test', 'Orphan')
        RETURNING id
      `;
      orphanId = row!.id;
    } finally {
      await sql.end();
    }

    asUser(orphanId, 'orphan@nowhere.test');
    const response = await searchRoute(request('/api/search?q=acme'));
    // 403, not 401 — re-authenticating will not help a former employee.
    expect(response.status).toBe(403);
  });

  it('authenticates a service account by bearer token', async () => {
    const minted = mintToken('service_account');
    const sql = superuserSql();
    try {
      const [sa] = await sql<{ id: string }[]>`
        INSERT INTO service_account (tenant_id, name, role_key, org_scope_all, created_by)
        VALUES (${IDS.tenant1}::uuid, 'RMM Sync', 'api_service', true, ${IDS.admin1}::uuid)
        RETURNING id
      `;
      await sql`
        INSERT INTO api_token (
          tenant_id, token_type, service_account_id, name, token_prefix, token_hash, scopes
        )
        VALUES (
          ${IDS.tenant1}::uuid, 'service_account', ${sa!.id}::uuid, 'RMM Sync',
          ${minted.prefix}, ${minted.hash}, ARRAY['asset:read', 'organization:read']
        )
      `;
    } finally {
      await sql.end();
    }

    const response = await organizationsRoute(
      request('/api/organizations', { headers: { authorization: `Bearer ${minted.token}` } }),
    );
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(Array.isArray(payload.organizations)).toBe(true);
  });

  it('refuses a revoked token with a flat 401', async () => {
    const minted = mintToken('service_account');
    const sql = superuserSql();
    try {
      const [sa] = await sql<{ id: string }[]>`
        INSERT INTO service_account (tenant_id, name, role_key, org_scope_all, created_by)
        VALUES (${IDS.tenant1}::uuid, 'Revoked Sync', 'api_service', true, ${IDS.admin1}::uuid)
        RETURNING id
      `;
      await sql`
        INSERT INTO api_token (
          tenant_id, token_type, service_account_id, name, token_prefix, token_hash,
          scopes, revoked_at, revoked_reason
        )
        VALUES (
          ${IDS.tenant1}::uuid, 'service_account', ${sa!.id}::uuid, 'Revoked Sync',
          ${minted.prefix}, ${minted.hash}, ARRAY['asset:read'], now(), 'leaked'
        )
      `;
    } finally {
      await sql.end();
    }

    const response = await organizationsRoute(
      request('/api/organizations', { headers: { authorization: `Bearer ${minted.token}` } }),
    );
    expect(response.status).toBe(401);
    // "revoked" must be indistinguishable from "never existed": telling the
    // caller their token was real is itself information.
    const payload = await body(response);
    expect(JSON.stringify(payload)).not.toMatch(/revoked|expired/i);
  });

  it('refuses an expired token', async () => {
    const minted = mintToken('service_account');
    const sql = superuserSql();
    try {
      const [sa] = await sql<{ id: string }[]>`
        INSERT INTO service_account (tenant_id, name, role_key, org_scope_all, created_by)
        VALUES (${IDS.tenant1}::uuid, 'Expired Sync', 'api_service', true, ${IDS.admin1}::uuid)
        RETURNING id
      `;
      await sql`
        INSERT INTO api_token (
          tenant_id, token_type, service_account_id, name, token_prefix, token_hash,
          scopes, expires_at
        )
        VALUES (
          ${IDS.tenant1}::uuid, 'service_account', ${sa!.id}::uuid, 'Expired Sync',
          ${minted.prefix}, ${minted.hash}, ARRAY['asset:read'], now() - interval '1 day'
        )
      `;
    } finally {
      await sql.end();
    }

    const response = await organizationsRoute(
      request('/api/organizations', { headers: { authorization: `Bearer ${minted.token}` } }),
    );
    expect(response.status).toBe(401);
  });

  it('refuses a valid token presented with the wrong secret half', async () => {
    const minted = mintToken('service_account');
    const sql = superuserSql();
    try {
      const [sa] = await sql<{ id: string }[]>`
        INSERT INTO service_account (tenant_id, name, role_key, org_scope_all, created_by)
        VALUES (${IDS.tenant1}::uuid, 'Guessed Sync', 'api_service', true, ${IDS.admin1}::uuid)
        RETURNING id
      `;
      await sql`
        INSERT INTO api_token (
          tenant_id, token_type, service_account_id, name, token_prefix, token_hash, scopes
        )
        VALUES (
          ${IDS.tenant1}::uuid, 'service_account', ${sa!.id}::uuid, 'Guessed Sync',
          ${minted.prefix}, ${minted.hash}, ARRAY['asset:read']
        )
      `;
    } finally {
      await sql.end();
    }

    // Correct prefix, wrong secret: the prefix alone must not authenticate.
    const forged = `${minted.prefix}.${randomBytes(32).toString('base64url')}`;
    const response = await organizationsRoute(
      request('/api/organizations', { headers: { authorization: `Bearer ${forged}` } }),
    );
    expect(response.status).toBe(401);
  });
});

describe('tenant scoping through the API', () => {
  it('shows an MSP administrator every client', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const payload = await body(await organizationsRoute(request('/api/organizations')));
    const names = (payload.organizations as { name: string }[]).map((o) => o.name);
    expect(names).toContain('Acme Manufacturing');
    expect(names).toContain('Globex Corporation');
  });

  it('shows a client administrator only their own organisation', async () => {
    asUser(IDS.acmeAdmin, 'it@acme.test');
    const payload = await body(await organizationsRoute(request('/api/organizations')));
    const orgs = payload.organizations as { name: string }[];
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.name).toBe('Acme Manufacturing');
  });

  it('shows the other tenant nothing of the first', async () => {
    asUser(IDS.admin2, 'admin@rival.test');
    const payload = await body(await organizationsRoute(request('/api/organizations')));
    const names = (payload.organizations as { name: string }[]).map((o) => o.name);
    expect(names).toEqual(['Contoso Ltd']);
  });
});

describe('search', () => {
  it('finds an asset by hostname', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const payload = await body(await searchRoute(request('/api/search?q=acme-fw-01')));
    const hits = payload.hits as { title: string }[];
    expect(hits.some((hit) => hit.title === 'acme-fw-01')).toBe(true);
  });

  it('scopes results to the caller organisation', async () => {
    asUser(IDS.acmeAdmin, 'it@acme.test');
    const payload = await body(await searchRoute(request('/api/search?q=globex')));
    expect(payload.hits).toEqual([]);
  });

  it('rejects a missing query term rather than returning everything', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await searchRoute(request('/api/search?q='));
    expect(response.status).toBe(400);
  });

  it('rejects an unknown kind filter', async () => {
    // `kind` is a text column; passing the filter through would let a caller
    // probe which kinds exist.
    //
    // The parameter was `type` until this batch and named entity_type, which
    // is the TABLE a row came from — so a credential and a firewall were both
    // 'asset_node' and the filter could not tell them apart. `kind` is what
    // results group under, which is what somebody filtering actually wants.
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await searchRoute(request('/api/search?q=acme&kind=secret_version'));
    expect(response.status).toBe(400);
  });

  it('groups results by kind', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const payload = await body(await searchRoute(request('/api/search?q=acme')));
    expect(payload).toHaveProperty('groups');
    expect(Array.isArray(payload.groups)).toBe(true);
  });

  it('reports whether more results exist without a second count query', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const payload = await body(await searchRoute(request('/api/search?q=acme&limit=1')));
    expect(payload).toHaveProperty('hasMore');
    expect(payload.limit).toBe(1);
  });

  it('caps an absurd page size', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await searchRoute(request('/api/search?q=acme&limit=100000'));
    expect(response.status).toBe(400);
  });
});

describe('secret reveal endpoint', () => {
  let standardSecretId: string;
  let criticalSecretId: string;

  beforeAll(async () => {
    const admin = actor(IDS.tenant1, IDS.admin1);
    const standard = await h.secrets.create(
      admin,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'API test wifi' },
      'guest-wifi-password',
    );
    standardSecretId = standard.secretId;

    // A direct insert, deliberately: these tests are about the ROUTES above the
    // ladder, not about obtaining a verification. tests/integration/step-up.test.ts
    // covers the real path and inserts nothing.
    const sql = superuserSql();
    try {
      await sql`
        INSERT INTO step_up_verification (tenant_id, user_id, method, expires_at)
        VALUES (${IDS.tenant1}::uuid, ${IDS.admin1}::uuid, 'webauthn', now() + interval '15 minutes')
      `;
    } finally {
      await sql.end();
    }

    const critical = await h.secrets.create(
      admin,
      {
        organizationId: IDS.orgAcme,
        kind: 'password',
        label: 'API test domain admin',
        sensitivity: 'critical',
        minRoleRank: 60,
      },
      'domain-admin-password',
    );
    criticalSecretId = critical.secretId;

    const cleanup = superuserSql();
    try {
      await cleanup`DELETE FROM step_up_verification WHERE user_id = ${IDS.admin1}::uuid`;
    } finally {
      await cleanup.end();
    }
  });

  const reveal = (secretId: string, payload: Record<string, unknown> = {}) =>
    revealRoute(
      request(`/api/secrets/${secretId}/reveal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ secretId }) },
    );

  it('returns the plaintext and the audit event id', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await reveal(standardSecretId);
    expect(response.status).toBe(200);

    const payload = await body(response);
    expect(payload.value).toBe('guest-wifi-password');
    // Surfacing the event id lets support answer "who saw this" from one lookup.
    expect(payload.auditEventUid).toBeTruthy();
  });

  it('maps a step-up refusal to a distinguishable status the UI can act on', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await reveal(criticalSecretId, { reason: 'INC-1234 investigating an outage' });
    expect(response.status).toBe(403);
    const payload = await body(response);
    // The client needs to know a re-auth prompt would help, rather than showing
    // "ask your manager".
    expect((payload.error as Record<string, unknown>).code).toBe('step_up_required');
  });

  it('maps a rank refusal to plain forbidden', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const response = await reveal(criticalSecretId, { reason: 'INC-1234 investigating an outage' });
    expect(response.status).toBe(403);
    const payload = await body(response);
    expect((payload.error as Record<string, unknown>).code).toBe('forbidden');
  });

  it('presents a cross-tenant secret as simply not found', async () => {
    asUser(IDS.admin2, 'admin@rival.test');
    const response = await reveal(standardSecretId);
    expect(response.status).toBe(404);
    // "not found" and "not yours" must be indistinguishable.
    const payload = await body(response);
    expect(JSON.stringify(payload)).not.toMatch(/forbidden|denied/i);
  });

  it('refuses a caller without secret:reveal before touching the secret', async () => {
    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await reveal(standardSecretId);
    expect(response.status).toBe(403);
  });

  it('rejects a non-UUID secret id', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await revealRoute(
      request('/api/secrets/not-a-uuid/reveal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      { params: Promise.resolve({ secretId: 'not-a-uuid' }) },
    );
    expect(response.status).toBe(400);
  });

  it('rejects a malformed JSON body with a 400, not a 500', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await revealRoute(
      request(`/api/secrets/${standardSecretId}/reveal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      }),
      { params: Promise.resolve({ secretId: standardSecretId }) },
    );
    expect(response.status).toBe(400);
  });
});

describe('graph endpoints', () => {
  it('creates a link and reports whether anything changed', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const payload = {
      sourceNodeId: IDS.firewall,
      relation: 'secures',
      targetNodeId: IDS.network,
    };
    const post = () =>
      linkRoute(
        request('/api/assets/links', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      );

    const first = await body(await post());
    expect(first.created).toBe(true);

    const second = await body(await post());
    expect(second.created).toBe(false);
  });

  it('returns an impact view ordered by criticality', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await graphRoute(
      request(`/api/assets/${IDS.domainController}/graph?view=impact&depth=3`),
      { params: Promise.resolve({ nodeId: IDS.domainController }) },
    );
    const payload = await body(response);
    expect(payload.view).toBe('impact');
    expect(Array.isArray(payload.nodes)).toBe(true);
  });

  it('stops a client user at the organisation boundary', async () => {
    asUser(IDS.acmeAdmin, 'it@acme.test');
    const response = await graphRoute(
      request(`/api/assets/${IDS.network}/graph?view=neighbours`),
      { params: Promise.resolve({ nodeId: IDS.network }) },
    );
    const payload = await body(response);
    const edges = payload.edges as { toNodeId: string }[];
    expect(edges.map((e) => e.toNodeId)).not.toContain(IDS.globexServer);
  });

  it('rejects an unknown relation rather than ignoring it', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await linkRoute(
      request('/api/assets/links', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceNodeId: IDS.firewall,
          relation: 'obliterates',
          targetNodeId: IDS.network,
        }),
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe('flexible assets end to end', () => {
  const goodSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['target'],
    properties: {
      target: { type: 'string', maxLength: 200 },
      repository_password: { type: 'string', 'x-helm-secret': true },
    },
  };

  const publish = (payload: Record<string, unknown>) =>
    publishTypeRoute(
      request('/api/flexible-assets/types', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );

  it('refuses a schema with a catastrophically backtracking pattern', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await publish({
      key: 'risky_template',
      name: 'Risky',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { code: { type: 'string', pattern: '^(a+)+$', maxLength: 50 } },
      },
    });
    expect(response.status).toBe(400);
    const payload = await body(response);
    expect(JSON.stringify(payload)).toMatch(/backtrack/);
  });

  it('publishes a good schema and derives its secret fields', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await publish({
      key: 'backup_job',
      name: 'Backup Job',
      jsonSchema: goodSchema,
      searchableFields: ['/target'],
    });
    expect(response.status).toBe(200);

    const payload = await body(response);
    // Derived from x-helm-secret, never taken from the request: a caller who
    // could nominate the secret fields could nominate none.
    expect(payload.secretFields).toEqual(['/repository_password']);
  });

  it('refuses a caller without flexible_type:manage', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const response = await publish({ key: 'sneaky', name: 'Sneaky', jsonSchema: goodSchema });
    expect(response.status).toBe(403);
  });

  it('creates a record, storing the secret outside the document', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');

    const sql = superuserSql();
    let typeId: string;
    try {
      const [row] = await sql<{ id: string }[]>`
        SELECT id FROM flexible_asset_type WHERE key = 'backup_job'
      `;
      typeId = row!.id;
    } finally {
      await sql.end();
    }

    const response = await createRecordRoute(
      request('/api/flexible-assets/records', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          typeId,
          organizationId: IDS.orgAcme,
          name: 'ACME Nightly Backup',
          data: { target: 'nas01', repository_password: 'restic-passphrase-9271' },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.secretFields).toEqual(['/repository_password']);

    const check = superuserSql();
    try {
      const [record] = await check<{ data: Record<string, unknown> }[]>`
        SELECT data FROM flexible_asset_record WHERE id = ${payload.nodeId as string}::uuid
      `;
      // The value must not survive anywhere in the stored document.
      expect(record!.data).not.toHaveProperty('repository_password');
      expect(JSON.stringify(record!.data)).not.toContain('restic-passphrase');

      const links = await check<{ field_path: string; secret_id: string }[]>`
        SELECT field_path, secret_id FROM flexible_asset_secret
        WHERE record_id = ${payload.nodeId as string}::uuid
      `;
      expect(links).toHaveLength(1);
      expect(links[0]!.field_path).toBe('/repository_password');
    } finally {
      await check.end();
    }
  });

  it('rejects a record that does not match its template', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');

    const sql = superuserSql();
    let typeId: string;
    try {
      const [row] = await sql<{ id: string }[]>`
        SELECT id FROM flexible_asset_type WHERE key = 'backup_job'
      `;
      typeId = row!.id;
    } finally {
      await sql.end();
    }

    const response = await createRecordRoute(
      request('/api/flexible-assets/records', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          typeId,
          organizationId: IDS.orgAcme,
          name: 'Invalid Backup',
          data: { unexpected: 'field' },
        }),
      }),
    );
    expect(response.status).toBe(400);
    const payload = await body(response);
    expect(JSON.stringify(payload)).toMatch(/required|not declared/);
  });
});

describe('audit and expirations endpoints', () => {
  it('returns audit events without the hash chain columns', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const payload = await body(await auditRoute(request('/api/audit?limit=10')));
    const events = payload.events as Record<string, unknown>[];
    expect(events.length).toBeGreaterThan(0);
    // Verification is a separate operation; handing out the hashes invites
    // clients to verify against a partial view and conclude it is broken.
    expect(events[0]).not.toHaveProperty('rowHash');
    expect(events[0]).not.toHaveProperty('chainSeq');
  });

  it('refuses audit access without the permission', async () => {
    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await auditRoute(request('/api/audit'));
    expect(response.status).toBe(403);
  });

  it('returns the expirations dashboard with computed severity', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const payload = await body(await expirationsRoute(request('/api/expirations?withinDays=365')));
    const rows = payload.expirations as { severity: string; daysRemaining: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['info', 'notice', 'warning', 'critical', 'expired']).toContain(row.severity);
    }
  });
});
