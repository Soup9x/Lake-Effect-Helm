/**
 * Reading and writing a webhook destination's URL.
 *
 * The third instance of the pattern in 0360 and 0410, and the differences are
 * the interesting part:
 *
 *   WHAT IS SEALED is a JSON document, {url, signingSecret}, not a bare string.
 *   The two are useless apart and are rewritten together, so one envelope keeps
 *   the crypto surface to one seal and one open.
 *
 *   WHO CAN READ IT is helm_worker, not helm_auth. Delivering a notification is
 *   a background job rather than a pre-authentication step. helm_worker is a
 *   MEMBER of helm_app and membership runs one way — helm_worker inherits
 *   helm_app's privileges, not the reverse — so this grant does not reach the
 *   request path.
 *
 *   WHY IT IS SEALED AT ALL is less obvious than for a password and worth
 *   saying: for Discord and Teams the URL *is* the authentication. Anyone
 *   holding it can post to that channel as Helm. 0110 stored it in plaintext in
 *   a table any tenant-wide role of rank 60 or more could read.
 */
import { createHash } from 'node:crypto';
import { openField, sealField, wipe, type Envelope, type SecretBinding } from '../crypto/envelope';
import type { EncryptionContext } from '../crypto/kek';
import { getKekProvider } from '../services';

/**
 * The encryption context this DEK is bound to.
 *
 * Distinct from the tenant, RADIUS and OIDC contexts, so a wrapped DEK copied
 * between tables fails to unwrap rather than quietly working.
 */
function webhookKeyContext(tenantId: string): EncryptionContext {
  return { 'helm:purpose': 'webhook-endpoint-url', 'helm:tenant': tenantId };
}

/**
 * The AAD binding.
 *
 * `secretId` is the ENDPOINT id, not the tenant id — unlike RADIUS and OIDC,
 * which are one row per tenant. A tenant has many destinations, so binding to
 * the tenant alone would let a row be copied between two of its own endpoints
 * and still open.
 */
function webhookBinding(tenantId: string, endpointId: string): SecretBinding {
  return { tenantId, secretId: endpointId, field: 'webhook_url', version: 1 };
}

/** What the sealed document holds. */
interface SealedDocument {
  url: string;
  signingSecret?: string;
}

export interface SealedWebhook {
  wrapProvider: string;
  kekId: string;
  wrappedDek: Buffer;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  aad: string;
  /** Plaintext, for display. Never the path or the token. */
  urlHost: string;
  urlDigest: string;
  signingSecretSet: boolean;
}

/**
 * The host, for a settings page to show.
 *
 * Host only — a Discord webhook path contains the token, so anything past the
 * host is the credential itself.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

/**
 * A short digest over the WHOLE url.
 *
 * Twelve hex characters: enough that an administrator can tell two hooks into
 * different channels of one Discord server apart, far too little to brute-force
 * back to a URL containing 68 bits of token.
 */
export function digestOf(url: string): string {
  return createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 12);
}

/** Seal a destination's URL and optional signing secret. */
export async function sealWebhook(
  tenantId: string,
  endpointId: string,
  url: string,
  signingSecret?: string,
): Promise<SealedWebhook> {
  const provider = getKekProvider();
  const dek = await provider.generateDek(webhookKeyContext(tenantId));
  const document: SealedDocument = signingSecret ? { url, signingSecret } : { url };
  const plaintext = Buffer.from(JSON.stringify(document), 'utf8');

  try {
    const envelope = sealField(dek.plaintext, plaintext, webhookBinding(tenantId, endpointId));
    return {
      wrapProvider: provider.provider,
      kekId: dek.kekId,
      wrappedDek: dek.wrapped,
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      tag: envelope.authTag,
      aad: envelope.aad,
      urlHost: hostOf(url),
      urlDigest: digestOf(url),
      signingSecretSet: Boolean(signingSecret),
    };
  } finally {
    wipe(plaintext, dek.plaintext);
  }
}

/** The envelope columns as the worker reads them back. */
export interface SealedColumns {
  wrap_provider: string;
  kek_id: string;
  wrapped_dek: Buffer;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_tag: Buffer;
  secret_aad: string;
}

/**
 * Open a destination's URL.
 *
 * Returns the plaintext to the caller, which holds it for the duration of one
 * fetch and writes it nowhere. Passing the expected binding makes openField
 * refuse a ciphertext whose AAD names a different tenant or endpoint — a row
 * copied between deployments fails here rather than posting a client's export
 * alerts into somebody else's channel.
 */
export async function openWebhook(
  tenantId: string,
  endpointId: string,
  row: SealedColumns,
): Promise<SealedDocument> {
  const provider = getKekProvider();
  const dek = await provider.unwrapDek(row.wrapped_dek, row.kek_id, webhookKeyContext(tenantId));

  try {
    const envelope: Envelope = {
      ciphertext: row.secret_ciphertext,
      nonce: row.secret_nonce,
      authTag: row.secret_tag,
      aad: row.secret_aad,
    };
    const plaintext = openField(dek, envelope, webhookBinding(tenantId, endpointId));
    try {
      const parsed = JSON.parse(plaintext.toString('utf8')) as SealedDocument;
      if (typeof parsed.url !== 'string' || parsed.url.length === 0) {
        throw new Error('sealed webhook document has no url');
      }
      return parsed;
    } finally {
      wipe(plaintext);
    }
  } finally {
    wipe(dek);
  }
}

/**
 * Whether a URL is one Helm will deliver to.
 *
 * https only, and said here as well as at the API boundary because this is the
 * last point before a request leaves the building. A notification names which
 * client has which expiring asset and who exported what; that is
 * reconnaissance, and an on-premises network is not a reason to put it on the
 * wire in clear.
 */
export function isDeliverable(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
