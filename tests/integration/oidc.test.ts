/**
 * Generic OIDC provider: discovery, custody, and who may change it.
 *
 * Three things are established here, and they are different in kind:
 *
 *   DISCOVERY   Helm reads endpoints from the issuer rather than knowing them,
 *               which is what makes this OIDC support rather than support for
 *               one product. Exercised against a stub issuer that can break in
 *               each of the ways a real one breaks.
 *
 *   CUSTODY     The client secret goes in enveloped and never comes back out of
 *               any surface the browser can reach, and helm_app — the role that
 *               renders every page — cannot read the column it lives in by any
 *               path. The AAD binds the ciphertext to its tenant, so a row
 *               lifted from one tenant into another fails to open rather than
 *               authenticating somebody against the wrong directory.
 *
 *   AUTHORITY   Configuring how an entire MSP signs in takes tenant:write,
 *               which tier3 does not hold even though it holds nearly
 *               everything else.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import {
  oidcBySlug,
  oidcForTenant,
  oidcSignInOptions,
  sealOidcSecret,
} from '../../src/lib/auth/oidc-config';
import {
  discover,
  discoveryUrl,
  pkceWarnings,
  redirectUri,
  scopeWarnings,
} from '../../src/lib/auth/oidc';
import { FakeOidc } from '../support/fake-oidc';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { DELETE as deleteOidc, GET as getOidc, PUT as putOidc } from '../../src/app/api/auth/oidc/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const running: FakeOidc[] = [];
async function stub(...args: Parameters<typeof FakeOidc.start>): Promise<FakeOidc> {
  const server = await FakeOidc.start(...args);
  running.push(server);
  return server;
}

const CLIENT_SECRET = 'a-client-secret-that-must-never-come-back-out';

const request = (method: string, payload?: unknown) =>
  new NextRequest(
    new Request('https://helm.test/api/auth/oidc', {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }),
  );

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

const SETTINGS = {
  enabled: true,
  slug: 'company-sso',
  displayName: 'Company SSO',
  issuer: 'https://id.example.test/application/o/helm',
  clientId: 'lake-effect-helm',
  scopes: ['openid', 'profile', 'email'],
  allowSignup: false,
  linkByEmail: true,
  clientSecret: CLIENT_SECRET,
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
    await sql`DELETE FROM oidc_provider`;
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

describe('OIDC discovery', () => {
  it('reads the endpoints from the issuer rather than knowing them', async () => {
    const idp = await stub('ok');
    const doc = await discover(idp.issuer);

    expect(doc.issuer).toBe(idp.issuer);
    expect(doc.authorizationEndpoint).toBe(`${idp.issuer}/authorize`);
    expect(doc.tokenEndpoint).toBe(`${idp.issuer}/token`);
    expect(doc.jwksUri).toBe(`${idp.issuer}/jwks`);
  });

  it('appends the well-known path to the WHOLE issuer, path included', async () => {
    // The Keycloak-realm case, and the single most common setup mistake: an
    // issuer at /realms/helm discovers at /realms/helm/.well-known/..., not at
    // the host root.
    const idp = await stub('ok', '/realms/helm');
    await discover(idp.issuer);

    expect(idp.requests).toContain('/realms/helm/.well-known/openid-configuration');
    expect(discoveryUrl(idp.issuer)).toMatch(/\/realms\/helm\/\.well-known\//);
  });

  it('tolerates a trailing slash on the issuer when building the URL', async () => {
    const idp = await stub('ok', '/realms/helm');
    expect(discoveryUrl(`${idp.issuer}/`)).toBe(
      `${idp.issuer}/.well-known/openid-configuration`,
    );
  });

  it('explains a 404 as a missing path segment', async () => {
    const idp = await stub('not-found');
    await expect(discover(idp.issuer)).rejects.toMatchObject({
      name: 'OidcDiscoveryError',
      remedy: expect.stringContaining('/realms/'),
    });
  });

  it('refuses a document that is not JSON', async () => {
    const idp = await stub('not-json');
    await expect(discover(idp.issuer)).rejects.toThrow(/did not return JSON/);
  });

  it('refuses a plain OAuth 2.0 server', async () => {
    // It parses, it has an authorization endpoint, and it will never produce an
    // id_token. Caught here rather than during somebody's first sign-in.
    const idp = await stub('oauth-only');
    await expect(discover(idp.issuer)).rejects.toThrow(/jwks_uri/);
  });

  it('refuses a document that names a different issuer', async () => {
    // The wrong-realm case. The document is valid; every token it signs would
    // fail verification, and nothing would say why until a real sign-in.
    const idp = await stub('wrong-issuer');
    await expect(discover(idp.issuer)).rejects.toThrow(/calls itself/);
  });

  it('refuses a provider without the authorization code flow', async () => {
    const idp = await stub('no-code-flow');
    await expect(discover(idp.issuer)).rejects.toThrow(/authorization code flow/);
  });

  it('gives up on a provider that never answers', async () => {
    const idp = await stub('hang');
    await expect(discover(idp.issuer)).rejects.toThrow(/No response|Could not reach/);
  }, 15_000);

  it('warns about an unadvertised scope without refusing it', async () => {
    // scopes_supported is optional and widely under-reported, so a mismatch is
    // worth saying and not worth refusing.
    const idp = await stub('ok');
    const doc = await discover(idp.issuer);

    expect(scopeWarnings(doc, ['openid', 'email'])).toEqual([]);
    expect(scopeWarnings(doc, ['openid', 'groups'])[0]?.message).toContain('groups');
    expect(pkceWarnings(doc)).toEqual([]);
  });

  it('builds a redirect URI the operator can paste into their provider', () => {
    expect(redirectUri('https://helm.example.test', 'company-sso')).toBe(
      'https://helm.example.test/api/auth/callback/company-sso',
    );
    expect(redirectUri('https://helm.example.test/', 'company-sso')).toBe(
      'https://helm.example.test/api/auth/callback/company-sso',
    );
  });
});

describe('PUT /api/auth/oidc', () => {
  it('stores a provider', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putOidc(request('PUT', SETTINGS));
    expect(response.status).toBe(200);

    const oidc = (await body(response)).oidc as Record<string, unknown>;
    expect(oidc.configured).toBe(true);
    expect(oidc.slug).toBe('company-sso');
    expect(oidc.issuer).toBe(SETTINGS.issuer);
    expect(oidc.secretSet).toBe(true);
  });

  it('NEVER returns the client secret', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const saved = await putOidc(request('PUT', SETTINGS));
    const fetched = await getOidc(request('GET'));

    for (const response of [saved, fetched]) {
      expect(JSON.stringify(await body(response))).not.toContain(CLIENT_SECRET);
    }
  });

  it('tells the operator exactly which redirect URI to register', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const oidc = (await body(await putOidc(request('PUT', SETTINGS)))).oidc as Record<string, unknown>;
    expect(oidc.redirectUri).toBe('https://helm.test/api/auth/callback/company-sso');
  });

  it('keeps the stored secret when the field is left blank', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putOidc(request('PUT', SETTINGS));

    const { clientSecret: _omitted, ...withoutSecret } = SETTINGS;
    const response = await putOidc(request('PUT', { ...withoutSecret, scopes: ['openid', 'email'] }));
    expect(response.status).toBe(200);

    // The point of the exercise: adding a scope must not require re-typing the
    // secret, or the secret ends up in a shared note so it can be re-typed.
    const resolved = await oidcForTenant(IDS.tenant1);
    expect(resolved?.clientSecret).toBe(CLIENT_SECRET);
    expect(resolved?.scopes).toEqual(['openid', 'email']);
  });

  it('demands a secret the first time', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const { clientSecret: _omitted, ...withoutSecret } = SETTINGS;
    const response = await putOidc(request('PUT', withoutSecret));
    expect(response.status).toBe(400);
  });

  it('refuses to move the sign-in path once it is registered', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putOidc(request('PUT', SETTINGS));

    const response = await putOidc(request('PUT', { ...SETTINGS, slug: 'somewhere-else' }));
    expect(response.status).toBe(400);
    // The message has to name the remedy, or somebody "fixes" it by editing the
    // row and breaks every sign-in instead.
    expect(JSON.stringify(await body(response))).toMatch(/Remove the provider/);
  });

  it('refuses an http issuer', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putOidc(
      request('PUT', { ...SETTINGS, issuer: 'http://id.example.test/application/o/helm' }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses scopes without openid', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putOidc(request('PUT', { ...SETTINGS, scopes: ['profile', 'email'] }));
    expect(response.status).toBe(400);
  });

  it('refuses a slug that would shadow a built-in provider', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putOidc(request('PUT', { ...SETTINGS, slug: 'microsoft-entra-id' }));
    expect(response.status).toBe(400);
  });

  it('reports a configuration nobody new can sign in through', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putOidc(
      request('PUT', { ...SETTINGS, allowSignup: false, linkByEmail: false }),
    );

    const oidc = (await body(response)).oidc as Record<string, unknown>;
    // Reported, not refused: existing links still work, so it is a legitimate
    // lockdown as well as a first-time dead end.
    expect(oidc.deadEnd).toBe(true);
  });
});

describe('who may configure how the MSP signs in', () => {
  it('refuses tier3, which holds nearly everything else', async () => {
    await setTechRole('tier3');
    asUser(IDS.tech1, 'tech@northwind.test');
    const response = await putOidc(request('PUT', SETTINGS));
    expect(response.status).toBe(403);
    await setTechRole('tier2');
  });

  it('refuses tier3 the removal too', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putOidc(request('PUT', SETTINGS));

    await setTechRole('tier3');
    asUser(IDS.tech1, 'tech@northwind.test');
    expect((await deleteOidc(request('DELETE'))).status).toBe(403);
    await setTechRole('tier2');
  });

  it('lets a tenant-wide role READ the settings, for a support call', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putOidc(request('PUT', SETTINGS));

    await setTechRole('tier3');
    asUser(IDS.tech1, 'tech@northwind.test');
    const response = await getOidc(request('GET'));
    expect(response.status).toBe(200);
    expect(((await body(response)).oidc as Record<string, unknown>).issuer).toBe(SETTINGS.issuer);
    await setTechRole('tier2');
  });

  it('takes the client secret with it when the provider is removed', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putOidc(request('PUT', SETTINGS));
    expect((await deleteOidc(request('DELETE'))).status).toBe(200);

    // Deleted, not merely disabled: a decommissioned provider must not leave
    // its secret in the database indefinitely.
    const sql = superuserSql();
    try {
      const rows = await sql`SELECT count(*)::int AS n FROM oidc_provider`;
      expect(rows[0]!.n).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('custody of the client secret', () => {
  it('helm_app cannot read the table, by any column', async () => {
    // Asserted here as well as by the migration's own guard, because a
    // column-level grant added later to "just show the issuer" would satisfy
    // neither and is exactly the shortcut somebody takes.
    const sql = superuserSql();
    try {
      const rows = await sql<{ column_name: string; allowed: boolean }[]>`
        SELECT column_name,
               has_column_privilege('helm_app', 'oidc_provider', column_name, 'SELECT') AS allowed
        FROM information_schema.columns WHERE table_name = 'oidc_provider'
      `;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((r) => r.allowed)).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('helm_worker cannot either, despite being a member of helm_app', async () => {
    const sql = superuserSql();
    try {
      const rows = await sql<{ allowed: boolean }[]>`
        SELECT has_table_privilege('helm_worker', 'oidc_provider', 'SELECT') AS allowed
      `;
      expect(rows[0]!.allowed).toBe(false);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('round-trips through the envelope', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putOidc(request('PUT', SETTINGS));

    const resolved = await oidcForTenant(IDS.tenant1);
    expect(resolved?.clientSecret).toBe(CLIENT_SECRET);
    expect(resolved?.clientId).toBe('lake-effect-helm');
    expect(resolved?.linkByEmail).toBe(true);
    expect(resolved?.allowSignup).toBe(false);
  });

  it('stores ciphertext, not the secret', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putOidc(request('PUT', SETTINGS));

    const sql = superuserSql();
    try {
      const rows = await sql<{ blob: string }[]>`
        SELECT encode(secret_ciphertext, 'escape') AS blob FROM oidc_provider
      `;
      expect(rows[0]!.blob).not.toContain(CLIENT_SECRET);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses to open a row lifted into another tenant', async () => {
    // The assertion that makes this an encryption scheme rather than a
    // scheme-shaped arrangement of the same primitives: the AAD names the
    // tenant, so a copied row fails to open rather than signing somebody in
    // against the wrong directory.
    const sealed = await sealOidcSecret(IDS.tenant1, CLIENT_SECRET);
    const sql = superuserSql();
    try {
      await sql`
        INSERT INTO oidc_provider (tenant_id, enabled, slug, display_name, issuer, client_id,
                                   wrap_provider, kek_id, wrapped_dek,
                                   secret_ciphertext, secret_nonce, secret_tag, secret_aad)
        VALUES (${IDS.tenant2}::uuid, true, 'stolen', 'Stolen', ${SETTINGS.issuer}, 'x',
                ${sealed.wrapProvider}, ${sealed.kekId}, ${sealed.wrappedDek},
                ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.tag}, ${sealed.aad})
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    await expect(oidcForTenant(IDS.tenant2)).rejects.toThrow();
  });
});

describe('what the public sign-in page may know', () => {
  it('offers an enabled provider as a label and a path, and nothing else', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putOidc(request('PUT', SETTINGS));

    const options = await oidcSignInOptions();
    expect(options).toEqual([{ slug: 'company-sso', displayName: 'Company SSO' }]);
    // The issuer is not secret, but a public page naming the deployment's
    // internal identity provider tells a visitor where to scan next.
    expect(JSON.stringify(options)).not.toContain('id.example.test');
  });

  it('does not offer a provider that is switched off', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putOidc(request('PUT', { ...SETTINGS, enabled: false }));
    expect(await oidcSignInOptions()).toEqual([]);
  });

  it('resolves a provider by the slug in its callback URL', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putOidc(request('PUT', SETTINGS));

    const resolved = await oidcBySlug('company-sso');
    expect(resolved?.clientId).toBe('lake-effect-helm');
    expect(await oidcBySlug('no-such-provider')).toBeNull();
  });

  it('answers the same for a disabled provider as for one that does not exist', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putOidc(request('PUT', { ...SETTINGS, enabled: false }));
    expect(await oidcBySlug('company-sso')).toBeNull();
  });
});
