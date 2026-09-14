/**
 * AES-256-GCM field encryption.
 *
 * This is the layer that produces exactly what secret_version stores:
 * ciphertext, a 96-bit nonce, a 128-bit tag, and the AAD string the database
 * keeps alongside them.
 *
 * Three things are load-bearing and easy to get subtly wrong:
 *
 * 1. THE AAD BINDS THE CIPHERTEXT TO ITS ROW. It covers tenant, secret, field
 *    and version. A blob lifted from one row and pasted into another fails
 *    authentication rather than decrypting to a different client's password.
 *    The format is versioned so it can change without silently invalidating
 *    everything written before.
 *
 * 2. NONCES ARE RANDOM AND UNIQUE PER KEY. 96-bit random nonces are safe well
 *    past any volume Helm will see, but "safe by argument" is not the same as
 *    "enforced", so the database carries UNIQUE (data_key_id, nonce) and this
 *    module retries on the resulting violation. Under GCM, nonce reuse is not
 *    degradation — it leaks the XOR of two plaintexts and enables tag forgery.
 *
 * 3. PLAINTEXT IS HANDLED AS Buffer, NOT string. A JS string cannot be
 *    overwritten and lives in the interned string pool; a Buffer at least can
 *    be zeroed. Conversion happens at the edges only.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HelmCryptoError } from './errors';

export const NONCE_BYTES = 12; // 96-bit, the only GCM nonce size with a clean proof
export const TAG_BYTES = 16; // 128-bit, full-strength authenticator
export const MAX_PLAINTEXT_BYTES = 64 * 1024; // matches the CHECK on secret_version

const AAD_VERSION = 'helm.v1';
const AAD_SEPARATOR = '|';

/**
 * Identifies precisely which value is being encrypted.
 *
 * `field` distinguishes multiple encrypted values belonging to one secret —
 * today `value` and `totp_seed`. Without it, the TOTP seed's ciphertext could
 * be swapped into the password slot and would still authenticate.
 */
export interface SecretBinding {
  tenantId: string;
  secretId: string;
  field: string;
  version: number;
}

export interface Envelope {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  aad: string;
}

/**
 * Canonical AAD string. Stored verbatim in secret_version.aad so a reader can
 * reconstruct and verify the binding without having to guess the format.
 */
export function buildAad(binding: SecretBinding): string {
  const { tenantId, secretId, field, version } = binding;
  if (field.includes(AAD_SEPARATOR)) {
    // A field name containing the separator could forge a different binding.
    throw new HelmCryptoError('invalid_envelope', `field name must not contain ${AAD_SEPARATOR}`);
  }
  return [AAD_VERSION, tenantId, secretId, field, String(version)].join(AAD_SEPARATOR);
}

export function parseAad(aad: string): SecretBinding & { aadVersion: string } {
  const parts = aad.split(AAD_SEPARATOR);
  if (parts.length !== 5) {
    throw new HelmCryptoError('invalid_envelope', 'AAD is not in the expected format');
  }
  const [aadVersion, tenantId, secretId, field, version] = parts as [
    string, string, string, string, string,
  ];
  return { aadVersion, tenantId, secretId, field, version: Number(version) };
}

/**
 * Encrypt one field.
 *
 * `dek` must be the 32-byte unwrapped key. `plaintext` is zeroed by the caller,
 * not here — this function does not own it.
 */
export function sealField(dek: Buffer, plaintext: Buffer, binding: SecretBinding): Envelope {
  if (dek.length !== 32) {
    throw new HelmCryptoError('invalid_envelope', `DEK must be 32 bytes, got ${dek.length}`);
  }
  if (plaintext.length === 0) {
    throw new HelmCryptoError('invalid_envelope', 'refusing to encrypt an empty value');
  }
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new HelmCryptoError(
      'invalid_envelope',
      `value exceeds ${MAX_PLAINTEXT_BYTES} bytes; the database will reject it`,
    );
  }

  const aad = buildAad(binding);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'), { plaintextLength: plaintext.length });

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), aad };
}

/**
 * Decrypt one field.
 *
 * `expected` is checked against the stored AAD *before* decryption. The GCM tag
 * would catch a mismatch anyway, but comparing first turns "someone moved a
 * ciphertext between rows" into a clear signal instead of a generic
 * authentication failure that looks like corruption.
 */
export function openField(dek: Buffer, envelope: Envelope, expected?: SecretBinding): Buffer {
  if (dek.length !== 32) {
    throw new HelmCryptoError('invalid_envelope', `DEK must be 32 bytes, got ${dek.length}`);
  }
  if (envelope.nonce.length !== NONCE_BYTES) {
    throw new HelmCryptoError('invalid_envelope', 'nonce is not 12 bytes');
  }
  if (envelope.authTag.length !== TAG_BYTES) {
    throw new HelmCryptoError('invalid_envelope', 'auth tag is not 16 bytes');
  }

  if (expected) {
    const wanted = buildAad(expected);
    if (wanted !== envelope.aad) {
      throw new HelmCryptoError(
        'invalid_envelope',
        'stored binding does not match the requested secret, field or version',
      );
    }
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, envelope.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(envelope.aad, 'utf8'), {
      plaintextLength: envelope.ciphertext.length,
    });
    decipher.setAuthTag(envelope.authTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
  } catch (cause) {
    throw HelmCryptoError.authenticationFailed(cause);
  }
}

/**
 * Best-effort overwrite of a plaintext buffer.
 *
 * Same caveat as the DEK cache: V8 may have copied the bytes, and this does
 * nothing about a core dump taken while the value was live. It shortens the
 * window; it does not close it.
 */
export function wipe(...buffers: (Buffer | undefined | null)[]): void {
  for (const buffer of buffers) {
    if (buffer && buffer.length > 0) buffer.fill(0);
  }
}
