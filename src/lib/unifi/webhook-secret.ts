/**
 * The inbound webhook signing secret.
 *
 * Deliberately NOT in `secret` with the controller's API key, and the reason is
 * worth stating because 0430 was emphatic about the opposite for that one.
 *
 * helm.reveal_secret() needs an actor and a tenant context, and writes an audit
 * row. An inbound webhook has none of the first two — verifying the signature is
 * what establishes whose request it is — and an audit row per inbound event
 * would bury the threat records this integration exists to produce under
 * records of Helm reading its own key. 0420 reached the same conclusion for the
 * outbound signing secret, for the same reasons, and this follows its shape
 * exactly rather than inventing a third.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { openField, sealField, wipe, type Envelope, type SecretBinding } from '../crypto/envelope';
import type { EncryptionContext } from '../crypto/kek';
import { getKekProvider } from '../services';

/**
 * Distinct from the tenant, RADIUS, OIDC and outbound-webhook contexts, so a
 * wrapped DEK copied between tables fails to unwrap rather than quietly working.
 */
function webhookKeyContext(tenantId: string): EncryptionContext {
  return { 'helm:purpose': 'unifi-webhook-signing', 'helm:tenant': tenantId };
}

/**
 * Bound to the MAPPING, not the tenant. A tenant has many controllers, and
 * binding to the tenant alone would let one mapping's envelope be copied onto
 * another and still open — which would mean one client's controller could sign
 * events accepted as another's.
 */
function webhookBinding(tenantId: string, mappingId: string): SecretBinding {
  return { tenantId, secretId: mappingId, field: 'unifi_webhook_secret', version: 1 };
}

export interface SealedWebhookSecret {
  wrapProvider: string;
  kekId: string;
  wrappedDek: Buffer;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  aad: string;
}

/** The envelope columns as the receiver reads them back. */
export interface SealedSecretColumns {
  wrap_provider: string;
  kek_id: string;
  wrapped_dek: Buffer;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_tag: Buffer;
  secret_aad: string;
}

/**
 * A secret to paste into the controller.
 *
 * 32 bytes of CSPRNG, hex. Generated here rather than typed by an operator
 * because a signing secret somebody invented is a signing secret somebody can
 * guess, and there is no reason for a human to choose this value.
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

export async function sealWebhookSecret(
  tenantId: string,
  mappingId: string,
  secret: string,
): Promise<SealedWebhookSecret> {
  const provider = getKekProvider();
  const dek = await provider.generateDek(webhookKeyContext(tenantId));
  const plaintext = Buffer.from(secret, 'utf8');

  try {
    const envelope = sealField(dek.plaintext, plaintext, webhookBinding(tenantId, mappingId));
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

export async function openWebhookSecret(
  tenantId: string,
  mappingId: string,
  row: SealedSecretColumns,
): Promise<Buffer> {
  const provider = getKekProvider();
  const dek = await provider.unwrapDek(row.wrapped_dek, row.kek_id, webhookKeyContext(tenantId));

  try {
    const envelope: Envelope = {
      ciphertext: row.secret_ciphertext,
      nonce: row.secret_nonce,
      authTag: row.secret_tag,
      aad: row.secret_aad,
    };
    return openField(dek, envelope, webhookBinding(tenantId, mappingId));
  } finally {
    wipe(dek);
  }
}

/**
 * Header names a signature may arrive under.
 *
 * DOCUMENTED ASSUMPTION, and the honest version of it: the UniFi Integration
 * API's webhook signing format is not specified in the published documentation
 * for Network 9.x, and support varies by console. Helm therefore defines the
 * scheme it will verify — HMAC-SHA256 over the exact request body, hex — and
 * accepts it under any of these headers, with or without an algorithm prefix.
 *
 * That is stated in docs/architecture/11-network-integration.md rather than
 * inferred from a controller somebody happened to have. If a future console
 * signs differently, this list and `verifySignature` are the two things to
 * change, and the poll keeps working meanwhile.
 */
const SIGNATURE_HEADERS = [
  'x-unifi-signature',
  'x-ubnt-signature',
  'x-webhook-signature',
  'x-hub-signature-256',
  'x-signature',
] as const;

export function signatureFrom(headers: Headers): string | null {
  for (const name of SIGNATURE_HEADERS) {
    const value = headers.get(name);
    if (value) return value.trim();
  }
  return null;
}

/** What Helm would send, so a test or an operator can produce a valid one. */
export function signBody(secret: Buffer | string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * Constant-time verification.
 *
 * `sha256=` is stripped because several platforms prefix it and an operator
 * copying a working example from elsewhere should not be defeated by six
 * characters. The comparison itself is timingSafeEqual on equal-length buffers:
 * a length check first, because timingSafeEqual throws on a mismatch and a
 * thrown exception is its own timing signal.
 */
export function verifySignature(secret: Buffer, body: string, presented: string): boolean {
  const offered = presented.replace(/^sha256=/i, '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(offered)) return false;

  const expected = Buffer.from(signBody(secret, body), 'hex');
  const actual = Buffer.from(offered, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
