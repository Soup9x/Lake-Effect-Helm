/**
 * Reading and writing a generic OIDC provider's client secret.
 *
 * Deliberately a near-copy of radius-config.ts, because it is the same problem:
 * a credential the deployment needs BEFORE anybody is signed in, held by the
 * one role that runs pre-authentication. The duplication is a few dozen lines
 * and the alternative — one abstract "pre-auth secret" module parameterised by
 * purpose — would hide the fact that these are two separate keys bound to two
 * separate contexts, which is the property that matters.
 *
 * WHERE THIS RUNS MATTERS. Every read goes through the `auth` pool, because
 * helm_app holds no privilege on oidc_provider at all (0410 asserts it, per
 * column). Writes are the mirror image: the application encrypts, because it
 * has the KEK provider and the database never has, and hands ciphertext to a
 * SECURITY DEFINER function that checks tenant:write. So helm_app can set the
 * client secret and cannot read back the one it set.
 */
import { db } from '../db/client';
import { openField, sealField, wipe, type Envelope, type SecretBinding } from '../crypto/envelope';
import type { EncryptionContext } from '../crypto/kek';
import { getKekProvider } from '../services';

/**
 * The encryption context this DEK is bound to.
 *
 * Distinct from both tenantKeyContext() and the RADIUS context, so a DEK minted
 * for one purpose cannot unwrap as another. The provider binds the context
 * cryptographically, so the separation survives somebody copying a wrapped_dek
 * from one table into the other.
 */
function oidcKeyContext(tenantId: string): EncryptionContext {
  return { 'helm:purpose': 'oidc-client-secret', 'helm:tenant': tenantId };
}

/**
 * The AAD binding.
 *
 * `secretId` is the tenant id because oidc_provider is keyed by tenant — one
 * provider per tenant, so the tenant IS the row.
 */
function oidcBinding(tenantId: string): SecretBinding {
  return { tenantId, secretId: tenantId, field: 'oidc_client_secret', version: 1 };
}

/** The columns helm.set_oidc_provider() expects. */
export interface SealedSecret {
  wrapProvider: string;
  kekId: string;
  wrappedDek: Buffer;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  aad: string;
}

/**
 * Seal a client secret for storage.
 *
 * A fresh DEK every time rather than one reused across rewrites — same
 * reasoning as sealRadiusSecret: reusing a DEK across two writes means reusing
 * a key across two nonce spaces, which is safe only until somebody refactors
 * the nonce generation.
 */
export async function sealOidcSecret(tenantId: string, secret: string): Promise<SealedSecret> {
  const provider = getKekProvider();
  const dek = await provider.generateDek(oidcKeyContext(tenantId));
  const plaintext = Buffer.from(secret, 'utf8');

  try {
    const envelope = sealField(dek.plaintext, plaintext, oidcBinding(tenantId));
    return {
      wrapProvider: provider.provider,
      kekId: dek.kekId,
      wrappedDek: dek.wrapped,
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      tag: envelope.authTag,
      aad: envelope.aad,
    };
  } finally {
    wipe(plaintext, dek.plaintext);
  }
}

interface ProviderRow {
  tenant_id: string;
  slug: string;
  display_name: string;
  issuer: string;
  client_id: string;
  scopes: string[];
  allow_signup: boolean;
  link_by_email: boolean;
  wrap_provider: string;
  kek_id: string;
  wrapped_dek: Buffer;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_tag: Buffer;
  secret_aad: string;
}

/** A provider ready to authenticate against, plus the tenant it belongs to. */
export interface ResolvedOidc {
  tenantId: string;
  slug: string;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  allowSignup: boolean;
  linkByEmail: boolean;
}

async function open(row: ProviderRow): Promise<ResolvedOidc> {
  const provider = getKekProvider();
  const dek = await provider.unwrapDek(row.wrapped_dek, row.kek_id, oidcKeyContext(row.tenant_id));

  try {
    const envelope: Envelope = {
      ciphertext: row.secret_ciphertext,
      nonce: row.secret_nonce,
      authTag: row.secret_tag,
      aad: row.secret_aad,
    };
    // Passing the expected binding makes openField refuse a ciphertext whose
    // AAD names a different tenant — a row copied between deployments fails
    // here rather than authenticating somebody against the wrong directory.
    const plaintext = openField(dek, envelope, oidcBinding(row.tenant_id));
    try {
      return {
        tenantId: row.tenant_id,
        slug: row.slug,
        displayName: row.display_name,
        issuer: row.issuer,
        clientId: row.client_id,
        clientSecret: plaintext.toString('utf8'),
        scopes: row.scopes,
        allowSignup: row.allow_signup,
        linkByEmail: row.link_by_email,
      };
    } finally {
      wipe(plaintext);
    }
  } finally {
    wipe(dek);
  }
}

/** What the sign-in page renders: a label and a path, and nothing else. */
export interface SignInOption {
  slug: string;
  displayName: string;
}

/**
 * The providers to offer on the sign-in page.
 *
 * Returns labels and slugs only. The issuer is withheld even though it is not
 * secret: a public page naming the deployment's internal IdP hostname tells an
 * unauthenticated visitor where to point their next scan.
 */
export async function oidcSignInOptions(): Promise<SignInOption[]> {
  const rows = await db('auth')<{ slug: string; display_name: string }[]>`
    SELECT * FROM helm.oidc_signin_options()
  `;
  return rows.map((r) => ({ slug: r.slug, displayName: r.display_name }));
}

/**
 * The provider behind a callback URL.
 *
 * Keyed by slug because that is what /api/auth/callback/<slug> carries, and at
 * that point in a sign-in there is no session, no cookie and no tenant. Returns
 * null for an unknown or disabled slug — which is the same answer, on purpose.
 */
export async function oidcBySlug(slug: string): Promise<ResolvedOidc | null> {
  const [row] = await db('auth')<ProviderRow[]>`
    SELECT * FROM helm.oidc_provider_by_slug(${slug})
  `;
  return row ? open(row) : null;
}

/**
 * Every enabled provider, built for the endpoints that must LIST them.
 *
 * `signIn()` in the browser asks /api/auth/providers before it posts anywhere,
 * and that path carries no slug — so a config resolved only from the slug in
 * the URL leaves the provider missing from the list, and the click falls back
 * to reloading the sign-in page. Which is precisely the bug the POST was meant
 * to fix, reintroduced one layer down.
 *
 * Kept separate from oidcBySlug so the expensive path stays narrow: this
 * unwraps a DEK per provider, and it runs on two endpoints rather than on
 * every session check.
 */
export async function oidcEnabledProviders(): Promise<ResolvedOidc[]> {
  const rows = await db('auth')<ProviderRow[]>`
    SELECT p.* FROM helm.oidc_signin_options() o
    CROSS JOIN LATERAL helm.oidc_provider_by_slug(o.slug) p
  `;
  return Promise.all(rows.map(open));
}

/**
 * The same, for an administrator testing their own tenant's settings.
 *
 * Not filtered on `enabled`: testing a configuration before switching it on is
 * the entire point of a test button.
 */
export async function oidcForTenant(tenantId: string): Promise<ResolvedOidc | null> {
  const [row] = await db('auth')<ProviderRow[]>`
    SELECT * FROM helm.oidc_provider_for_tenant(${tenantId}::uuid)
  `;
  return row ? open(row) : null;
}

/** Remember what the Test button found, so the answer survives a page reload. */
export async function recordOidcTest(tenantId: string, ok: boolean, error?: string): Promise<void> {
  await db('auth')`
    SELECT helm.record_oidc_test(${tenantId}::uuid, ${ok}, ${error ?? null})
  `;
}

/**
 * Label a session Auth.js just created.
 *
 * auth_session.auth_method defaults to 'sso', which is right for Entra and
 * wrong for a self-hosted Keycloak. Runs on the auth pool because helm_app must
 * never reach auth_session at all.
 */
export async function stampSessionMethod(
  sessionToken: string,
  method: 'sso' | 'oidc',
  ip?: string | null,
  userAgent?: string | null,
): Promise<void> {
  await db('auth')`
    SELECT helm.stamp_session_method(
      ${sessionToken}, ${method}::auth_method, ${ip ?? null}::inet, ${userAgent ?? null})
  `;
}
