/**
 * How a backup archive is sealed: AES-256-GCM under a key derived from the
 * backup passphrase with scrypt, one fresh salt and nonce per file.
 *
 * Streamed, because a dump can be gigabytes. The file is: 8-byte magic,
 * 16-byte salt, 12-byte nonce, ciphertext, 16-byte tag. The scrypt parameters
 * are fixed here and recorded in the manifest so a future change can still
 * open an old archive.
 *
 * Node's own crypto, no gpg: the container that writes these is the migrate
 * image plus a Postgres client, and the thing that reads them back is this
 * same module, from `scripts/backup.ts decrypt`.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const MAGIC = Buffer.from('HELMBKP1');
export const KDF = { N: 2 ** 15, r: 8, p: 1, keyLength: 32 } as const;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KDF.keyLength, {
    N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024,
  });
}

/** Encrypt `source` into `target`; returns the ciphertext size. */
export async function encryptFile(source: string, target: string, passphrase: string): Promise<number> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  let bytes = 0;
  const count = new Transform({
    transform(chunk, _enc, cb) { bytes += (chunk as Buffer).length; cb(null, chunk); },
  });
  const out = createWriteStream(target, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, salt, nonce]));
  bytes += MAGIC.length + 28;
  await pipeline(createReadStream(source), cipher, count, out);
  // The tag is known only after the stream ends; append it.
  const tag = cipher.getAuthTag();
  await new Promise<void>((resolve, reject) => {
    const tail = createWriteStream(target, { flags: 'a' });
    tail.on('error', reject);
    tail.end(tag, () => resolve());
  });
  return bytes + tag.length;
}

/** Decrypt `source` into `target`; throws when the passphrase or the bytes are wrong. */
export async function decryptFile(source: string, target: string, passphrase: string): Promise<void> {
  const { stat, open } = await import('node:fs/promises');
  const size = (await stat(source)).size;
  const headerLength = MAGIC.length + 28;
  if (size < headerLength + 16) throw new Error('not a Helm backup archive');
  const handle = await open(source, 'r');
  try {
    const header = Buffer.alloc(headerLength);
    await handle.read(header, 0, headerLength, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a Helm backup archive');
    const salt = header.subarray(MAGIC.length, MAGIC.length + 16);
    const nonce = header.subarray(MAGIC.length + 16, headerLength);
    const tag = Buffer.alloc(16);
    await handle.read(tag, 0, 16, size - 16);
    const key = deriveKey(passphrase, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(source, { start: headerLength, end: size - 17 }),
      decipher,
      createWriteStream(target, { mode: 0o600 }),
    );
  } finally {
    await handle.close();
  }
}
