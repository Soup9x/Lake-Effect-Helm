/**
 * Packaging and encrypting an export.
 *
 * A bundle is a small uncompressed archive holding the JSON rendering, the PDF
 * rendering, and a manifest naming both with their digests. Written in-tree
 * rather than shelling out to zip or adding an archive library: the format is
 * a length-prefixed concatenation, it is read back by the download route in
 * this same codebase, and the manifest is what a recipient verifies against.
 *
 * ENCRYPTION. A bundle carrying credentials is encrypted with AES-256-GCM under
 * a key derived by scrypt from a passphrase generated at render time. The
 * passphrase is returned to the requester ONCE and is never stored — not in
 * export_job, not in the audit log, not in the storage backend. That is the
 * point: the artefact at rest is useless to anyone who has only the file, which
 * includes anyone who later gains access to the storage directory or a backup
 * of it.
 *
 * The cost is real and worth stating: lose the passphrase and the bundle is
 * gone. That is preferable to a handover archive sitting on disk in the clear
 * because someone wanted it to be re-downloadable.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';

const MAGIC = Buffer.from('HELMBNDL', 'latin1');
const FORMAT_V1 = 1;

/** scrypt parameters. N=2^15 is ~90ms and ~32MB, which is right for a passphrase. */
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface BundleEntry {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

export interface BundleManifest {
  readonly schema: 'lake-effect-helm/bundle/v1';
  readonly createdAt: string;
  readonly encrypted: boolean;
  readonly entries: { name: string; contentType: string; bytes: number; sha256: string }[];
}

export interface PackedBundle {
  readonly bytes: Buffer;
  readonly sha256: Buffer;
  readonly encryptionMethod: string | null;
  /**
   * Shown to the requester exactly once. Null for a bundle with no credentials,
   * which is not encrypted because there is nothing in it that a reader who is
   * already authorised to download it should not see.
   */
  readonly passphrase: string | null;
}

/**
 * Pack entries into one archive.
 *
 * Layout: MAGIC | version(1) | manifestLength(4 BE) | manifest JSON | entries,
 * each entry being length(4 BE) followed by its bytes, in manifest order.
 */
export function packBundle(entries: readonly BundleEntry[], encrypt: boolean): PackedBundle {
  const manifest: BundleManifest = {
    schema: 'lake-effect-helm/bundle/v1',
    createdAt: new Date().toISOString(),
    encrypted: encrypt,
    entries: entries.map((entry) => ({
      name: entry.name,
      contentType: entry.contentType,
      bytes: entry.bytes.length,
      sha256: createHash('sha256').update(entry.bytes).digest('hex'),
    })),
  };

  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifestBytes.length, 0);

  const parts: Buffer[] = [MAGIC, Buffer.of(FORMAT_V1), header, manifestBytes];
  for (const entry of entries) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(entry.bytes.length, 0);
    parts.push(length, entry.bytes);
  }

  const plain = Buffer.concat(parts);

  if (!encrypt) {
    return {
      bytes: plain,
      sha256: createHash('sha256').update(plain).digest(),
      encryptionMethod: null,
      passphrase: null,
    };
  }

  const passphrase = generatePassphrase();
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = deriveKey(passphrase, salt);

  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    // The scrypt parameters are authenticated, so a file whose header was edited
    // to claim cheaper parameters fails to open rather than opening weakly.
    const aad = Buffer.from(`helm-bundle-v1|${SCRYPT_N}|${SCRYPT_R}|${SCRYPT_P}`, 'utf8');
    cipher.setAAD(aad);

    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const sealed = Buffer.concat([
      MAGIC,
      Buffer.of(FORMAT_V1 | 0x80), // high bit marks an encrypted bundle
      salt,
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]);

    return {
      bytes: sealed,
      // The digest is of the SEALED bytes: it is what the download route and the
      // recipient can both check without the passphrase.
      sha256: createHash('sha256').update(sealed).digest(),
      encryptionMethod: `AES-256-GCM/scrypt(N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P})`,
      passphrase,
    };
  } finally {
    key.fill(0);
  }
}

export interface UnpackedBundle {
  readonly manifest: BundleManifest;
  readonly entries: BundleEntry[];
}

export function isEncryptedBundle(bytes: Buffer): boolean {
  return bytes.length > MAGIC.length && bytes.subarray(0, MAGIC.length).equals(MAGIC)
    ? (bytes[MAGIC.length] ?? 0) === (FORMAT_V1 | 0x80)
    : false;
}

export function unpackBundle(bytes: Buffer, passphrase?: string): UnpackedBundle {
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a Helm bundle');
  }

  const version = bytes[MAGIC.length] ?? 0;
  let plain: Buffer;

  if (version === (FORMAT_V1 | 0x80)) {
    if (!passphrase) throw new Error('this bundle is encrypted; a passphrase is required');

    let offset = MAGIC.length + 1;
    const salt = bytes.subarray(offset, (offset += SALT_BYTES));
    const nonce = bytes.subarray(offset, (offset += NONCE_BYTES));
    const tag = bytes.subarray(offset, (offset += TAG_BYTES));
    const ciphertext = bytes.subarray(offset);

    const key = deriveKey(passphrase, salt);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(`helm-bundle-v1|${SCRYPT_N}|${SCRYPT_R}|${SCRYPT_P}`, 'utf8'));
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (cause) {
      // Wrong passphrase and tampered file are indistinguishable, by design.
      throw new Error('the bundle could not be opened: wrong passphrase, or it was modified', { cause });
    } finally {
      key.fill(0);
    }
  } else if (version === FORMAT_V1) {
    plain = bytes;
  } else {
    throw new Error(`unsupported Helm bundle version ${version}`);
  }

  let offset = MAGIC.length + 1;
  const manifestLength = plain.readUInt32BE(offset);
  offset += 4;
  const manifest = JSON.parse(plain.subarray(offset, offset + manifestLength).toString('utf8')) as BundleManifest;
  offset += manifestLength;

  const entries: BundleEntry[] = [];
  for (const declared of manifest.entries) {
    const length = plain.readUInt32BE(offset);
    offset += 4;
    const entryBytes = plain.subarray(offset, offset + length);
    offset += length;

    const digest = createHash('sha256').update(entryBytes).digest('hex');
    if (digest !== declared.sha256) {
      throw new Error(`bundle entry ${declared.name} does not match its manifest digest`);
    }

    entries.push({ name: declared.name, contentType: declared.contentType, bytes: entryBytes });
  }

  return { manifest, entries };
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * A passphrase a human can read off a screen and type into a colleague's
 * terminal without a transcription error.
 *
 * Six groups of five characters from an alphabet with no 0/O, 1/l/I. That is
 * 30 characters from a 30-symbol alphabet — about 147 bits — which is well past
 * the point where scrypt's cost matters, and the grouping is what makes it
 * actually get transferred correctly rather than being pasted into a chat
 * window because it was too fiddly to read.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generatePassphrase(groups = 6, size = 5): string {
  const out: string[] = [];
  for (let g = 0; g < groups; g += 1) {
    let group = '';
    // Rejection sampling: `% ALPHABET.length` on a byte would make the first
    // few symbols measurably more likely.
    while (group.length < size) {
      for (const byte of randomBytes(size * 2)) {
        if (byte >= 248) continue; // 248 = 31 * 8, the largest multiple below 256
        group += ALPHABET[byte % ALPHABET.length];
        if (group.length === size) break;
      }
    }
    out.push(group);
  }
  return out.join('-');
}
