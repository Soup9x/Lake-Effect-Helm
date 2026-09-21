/**
 * A document is sealed the same way every other sensitive value is.
 *
 * sealField() refuses anything over 64 KB, matching the CHECK on
 * secret_version, so documents get their own pair of functions rather than a
 * raised constant that would quietly permit a 50 MB password. What must NOT
 * differ is the scheme: same AES-256-GCM, same 12-byte nonce, same 16-byte tag,
 * same AAD format binding a ciphertext to its row.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NONCE_BYTES, TAG_BYTES, buildAad } from '../../src/lib/crypto/envelope';
import { documentBinding, openDocument, sealDocument } from '../../src/lib/documents/crypto';
import { HelmCryptoError } from '../../src/lib/crypto/errors';

const DEK = randomBytes(32);
const TENANT = '11111111-1111-1111-1111-111111111111';
const DOC = '1d000000-0000-0000-0000-0000000000aa';
const binding = documentBinding(TENANT, DOC);

describe('sealDocument / openDocument', () => {
  it('round-trips a file', () => {
    const plaintext = Buffer.from('network diagram, not really');
    const sealed = sealDocument(DEK, plaintext, binding);

    expect(openDocument(DEK, sealed.body, sealed.nonce, binding).equals(plaintext)).toBe(true);
  });

  it('round-trips something larger than a secret is allowed to be', () => {
    // The whole reason this module exists: sealField() would refuse this.
    const plaintext = randomBytes(256 * 1024);
    const sealed = sealDocument(DEK, plaintext, binding);

    expect(openDocument(DEK, sealed.body, sealed.nonce, binding).equals(plaintext)).toBe(true);
  });

  it('uses the same envelope parameters as every other sealed value', () => {
    const sealed = sealDocument(DEK, Buffer.from('x'), binding);

    expect(sealed.nonce).toHaveLength(NONCE_BYTES);
    // ciphertext || tag, which is what goes on disk.
    expect(sealed.body).toHaveLength(1 + TAG_BYTES);
    expect(sealed.aad).toBe(buildAad(binding));
  });

  it('uses a fresh nonce every time, which is what GCM security rests on', () => {
    const one = sealDocument(DEK, Buffer.from('same bytes'), binding);
    const two = sealDocument(DEK, Buffer.from('same bytes'), binding);

    expect(one.nonce.equals(two.nonce)).toBe(false);
    expect(one.body.equals(two.body)).toBe(false);
  });

  it('refuses an empty file rather than sealing nothing', () => {
    expect(() => sealDocument(DEK, Buffer.alloc(0), binding)).toThrow(HelmCryptoError);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => sealDocument(randomBytes(16), Buffer.from('x'), binding)).toThrow(HelmCryptoError);
  });
});

describe('what authentication is actually for', () => {
  const plaintext = Buffer.from('an install note with a PSK in it');
  const sealed = sealDocument(DEK, plaintext, binding);

  it('refuses a ciphertext moved to another row', () => {
    const otherRow = documentBinding(TENANT, '1d000000-0000-0000-0000-0000000000bb');
    expect(() => openDocument(DEK, sealed.body, sealed.nonce, otherRow)).toThrow(HelmCryptoError);
  });

  it('refuses a ciphertext moved to another tenant', () => {
    const otherTenant = documentBinding('22222222-2222-2222-2222-222222222222', DOC);
    expect(() => openDocument(DEK, sealed.body, sealed.nonce, otherTenant)).toThrow(HelmCryptoError);
  });

  it('refuses the wrong key', () => {
    expect(() => openDocument(randomBytes(32), sealed.body, sealed.nonce, binding)).toThrow(
      HelmCryptoError,
    );
  });

  it('refuses a flipped bit', () => {
    const tampered = Buffer.from(sealed.body);
    tampered[0] = tampered[0]! ^ 0x01;
    expect(() => openDocument(DEK, tampered, sealed.nonce, binding)).toThrow(HelmCryptoError);
  });

  it('refuses a stripped tag', () => {
    const truncated = sealed.body.subarray(0, sealed.body.length - TAG_BYTES);
    expect(() => openDocument(DEK, truncated, sealed.nonce, binding)).toThrow(HelmCryptoError);
  });

  it('says what is wrong with a file too short to be a sealed document', () => {
    // The realistic cause is a disk that filled mid-write, and a generic
    // authentication failure would read as corruption of the wrong kind.
    expect(() => openDocument(DEK, Buffer.alloc(4), sealed.nonce, binding)).toThrow(
      /too short to contain a GCM tag/,
    );
  });

  it('refuses a nonce that is not 12 bytes', () => {
    expect(() => openDocument(DEK, sealed.body, randomBytes(8), binding)).toThrow(HelmCryptoError);
  });
});
