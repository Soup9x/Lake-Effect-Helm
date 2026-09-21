/**
 * Encrypting a document.
 *
 * SAME ENVELOPE, DIFFERENT SIZE. Every sensitive value in this product is
 * AES-256-GCM under a per-tenant DEK that is itself wrapped by a KEK the
 * application server cannot read, with an AAD binding each ciphertext to the
 * row it belongs to. Documents are no exception, and this file does not invent
 * a second scheme — it reuses the nonce and tag sizes, the AAD format and the
 * binding shape from src/lib/crypto/envelope.ts.
 *
 * What it does not reuse is sealField() itself, and the reason is a hard limit
 * rather than a preference: sealField refuses anything over 64 KB, matching the
 * CHECK on secret_version. A 50 MB network diagram is not a secret_version. The
 * alternative — raising that constant — would quietly permit a 50 MB password.
 *
 * WHAT GOES ON DISK is nonce-free: ciphertext followed by the 16-byte GCM tag,
 * which is how every AEAD file format does it. The nonce is stored in the
 * database on attachment.encryption_nonce, where 0130 already put a column for
 * it with a CHECK that it is 12 bytes. So a stolen file is not decryptable
 * without the row, and a stolen row is not decryptable without the KEK.
 *
 * THE BINDING is the existing SecretBinding: tenant, the attachment id in the
 * `secretId` position, the field name 'document', version 1. There is no
 * version history on documents, so the version never moves; it is included
 * because the AAD format has the slot and leaving it out would fork the format.
 * Moving a ciphertext to another row, or another tenant, fails to open.
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { HelmCryptoError } from '../crypto/errors';
import { NONCE_BYTES, TAG_BYTES, buildAad, type SecretBinding } from '../crypto/envelope';

/** The field name every document ciphertext is bound to. */
export const DOCUMENT_FIELD = 'document';

export interface SealedDocument {
  /** ciphertext || tag, exactly as it is written to disk. */
  readonly body: Buffer;
  readonly nonce: Buffer;
  readonly aad: string;
}

export function documentBinding(tenantId: string, attachmentId: string): SecretBinding {
  return { tenantId, secretId: attachmentId, field: DOCUMENT_FIELD, version: 1 };
}

export function sealDocument(dek: Buffer, plaintext: Buffer, binding: SecretBinding): SealedDocument {
  if (dek.length !== 32) {
    throw new HelmCryptoError('invalid_envelope', `DEK must be 32 bytes, got ${dek.length}`);
  }
  if (plaintext.length === 0) {
    throw new HelmCryptoError('invalid_envelope', 'refusing to encrypt an empty file');
  }

  const aad = buildAad(binding);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'), { plaintextLength: plaintext.length });

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { body: Buffer.concat([ciphertext, cipher.getAuthTag()]), nonce, aad };
}

export function openDocument(
  dek: Buffer,
  body: Buffer,
  nonce: Buffer,
  binding: SecretBinding,
): Buffer {
  if (dek.length !== 32) {
    throw new HelmCryptoError('invalid_envelope', `DEK must be 32 bytes, got ${dek.length}`);
  }
  if (nonce.length !== NONCE_BYTES) {
    throw new HelmCryptoError('invalid_envelope', 'nonce is not 12 bytes');
  }
  // A file shorter than the tag cannot be a sealed document, and slicing it
  // would hand createDecipheriv a malformed tag rather than saying what is
  // wrong. Truncation is the realistic cause: a disk that filled mid-write.
  if (body.length <= TAG_BYTES) {
    throw new HelmCryptoError(
      'invalid_envelope',
      `stored document is ${body.length} bytes, too short to contain a GCM tag`,
    );
  }

  const ciphertext = body.subarray(0, body.length - TAG_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);
  const aad = buildAad(binding);

  const decipher = createDecipheriv('aes-256-gcm', dek, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'), { plaintextLength: ciphertext.length });
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    // GCM's whole point. A failure here means the bytes, the nonce or the
    // binding is not what sealed this file — a swapped file, a rewritten row,
    // or corruption — and none of those should produce plausible-looking output.
    throw new HelmCryptoError(
      'invalid_envelope',
      'the stored document failed authentication; it does not match this row',
      { cause },
    );
  }
}
