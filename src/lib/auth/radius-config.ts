/**
 * Reading and writing the RADIUS shared secret.
 *
 * The secret is enveloped exactly the way a tenant's credentials are: a DEK
 * minted by the configured KEK provider, the secret sealed under that DEK with
 * AES-256-GCM, and an AAD binding the ciphertext to the tenant it belongs to.
 * Nothing new was invented for it — a second, bespoke encryption scheme in an
 * application that already has one is how the weaker of the two gets used by
 * accident.
 *
 * WHERE THIS RUNS MATTERS. Every read goes through the `auth` pool, because
 * helm_app holds no privilege on radius_config at all (0360 asserts it). That
 * is the same boundary password_phc sits behind, and for the same reason: the
 * value proves identity, so the role that renders client documentation has no
 * business being able to SELECT it.
 *
 * Writes are the mirror image. The application encrypts — it has the KEK
 * provider, the database never has — and hands the database ciphertext through
 * a SECURITY DEFINER function that checks tenant:write. So helm_app can set the
 * shared secret and cannot read back the one it set.
 */
import { db } from '../db/client';
import { openField, sealField, wipe, type Envelope, type SecretBinding } from '../crypto/envelope';
import type { EncryptionContext } from '../crypto/kek';
import { getKekProvider } from '../services';
import type { RadiusServer } from './radius';

/**
 * The encryption context the RADIUS DEK is bound to.
 *
 * Deliberately NOT tenantKeyContext(): a DEK minted for this purpose must not
 * unwrap as a tenant data key, and vice versa. The provider binds the context
 * cryptographically, so the separation survives someone copying a wrapped_dek
 * from one table into the other.
 */
function radiusKeyContext(tenantId: string): EncryptionContext {
  return { 'helm:purpose': 'radius-shared-secret', 'helm:tenant': tenantId };
}

/**
 * The AAD binding.
 *
 * `secretId` is the tenant id because radius_config is keyed by tenant — one
 * server per tenant, so the tenant IS the row. The binding therefore says
 * exactly what it should: this ciphertext belongs to this tenant's RADIUS
 * configuration and nothing else.
 */
function radiusBinding(tenantId: string): SecretBinding {
  return { tenantId, secretId: tenantId, field: 'radius_shared_secret', version: 1 };
}

/** The columns helm.set_radius_config() expects. */
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
 * Seal a shared secret for storage.
 *
 * A fresh DEK every time rather than one reused across rewrites. The saving
 * would be one KEK call on a page nobody opens twice a year, and reusing a DEK
 * across two writes means reusing a key across two nonce spaces — which is
 * safe only for as long as nobody refactors the nonce generation.
 */
export async function sealRadiusSecret(tenantId: string, secret: string): Promise<SealedSecret> {
  const provider = getKekProvider();
  const context = radiusKeyContext(tenantId);
  const dek = await provider.generateDek(context);
  const plaintext = Buffer.from(secret, 'utf8');

  try {
    const envelope = sealField(dek.plaintext, plaintext, radiusBinding(tenantId));
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

interface ConfigRow {
  tenant_id: string;
  host: string;
  port: number;
  timeout_ms: number;
  retries: number;
  nas_identifier: string;
  wrap_provider: string;
  kek_id: string;
  wrapped_dek: Buffer;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_tag: Buffer;
  secret_aad: string;
}

/** A server ready to authenticate against, plus the tenant it belongs to. */
export interface ResolvedRadius {
  tenantId: string;
  server: RadiusServer;
}

async function open(row: ConfigRow): Promise<ResolvedRadius> {
  const provider = getKekProvider();
  const context = radiusKeyContext(row.tenant_id);
  const dek = await provider.unwrapDek(row.wrapped_dek, row.kek_id, context);

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
    const plaintext = openField(dek, envelope, radiusBinding(row.tenant_id));
    try {
      return {
        tenantId: row.tenant_id,
        server: {
          host: row.host,
          port: row.port,
          secret: plaintext.toString('utf8'),
          timeoutMs: row.timeout_ms,
          retries: row.retries,
          nasIdentifier: row.nas_identifier,
        },
      };
    } finally {
      wipe(plaintext);
    }
  } finally {
    wipe(dek);
  }
}

/**
 * The RADIUS server that applies to whoever is trying to sign in.
 *
 * Resolved from the address because that is all a sign-in form has. Returns
 * null when the address has no account, the account has no active membership,
 * or that tenant has RADIUS switched off — all three of which mean the same
 * thing to the caller: there is no third door for this person, carry on with
 * the password.
 */
export async function radiusForEmail(email: string): Promise<ResolvedRadius | null> {
  const [row] = await db('auth')<ConfigRow[]>`
    SELECT * FROM helm.radius_config_for_email(${email.trim().toLowerCase()}::citext)
  `;
  return row ? open(row) : null;
}

/** The same, for an administrator testing their own tenant's settings. */
export async function radiusForTenant(tenantId: string): Promise<ResolvedRadius | null> {
  const [row] = await db('auth')<ConfigRow[]>`
    SELECT * FROM helm.radius_config_for_tenant(${tenantId}::uuid)
  `;
  return row ? open(row) : null;
}

/** Remember what the Test button found, so the answer survives a page reload. */
export async function recordRadiusTest(
  tenantId: string,
  ok: boolean,
  error?: string,
): Promise<void> {
  await db('auth')`
    SELECT helm.record_radius_test(${tenantId}::uuid, ${ok}, ${error ?? null})
  `;
}
