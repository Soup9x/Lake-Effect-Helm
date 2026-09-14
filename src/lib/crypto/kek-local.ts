/**
 * On-premises master key provider.
 *
 * Helm's key hierarchy assumes the KEK lives somewhere the application cannot
 * read: an HSM, a cloud KMS, a Vault transit engine. On a single on-premises
 * server there may be no such boundary, and pretending otherwise would be
 * dishonest. This provider is the explicit, documented alternative: the master
 * key is held by the host, loaded into the Helm process at start-up, and used
 * to wrap per-tenant DEKs with AES-256-GCM.
 *
 * What that buys and what it does not:
 *
 *   * A database compromise alone — a stolen dump, a replica, a backup tape —
 *     yields wrapped DEKs and ciphertext, and nothing else. This is the threat
 *     the envelope scheme is really aimed at and it still holds.
 *
 *   * A compromise of the Helm process, or root on the Helm host, yields the
 *     master key. A cloud KMS or Vault would still require the attacker to keep
 *     calling the service — leaving an audit trail and giving you a revocation
 *     point. Here there is neither. Use HELM_KEK_PROVIDER=vault-transit if that
 *     difference matters to your threat model; see crypto/kek-vault.ts.
 *
 * Two things this provider takes seriously that a naive "read a base64 env var"
 * implementation does not:
 *
 *   1. A FILE is preferred over an environment variable. An environment
 *      variable is copied into crash dumps, container inspect output, the unit
 *      file or compose file that set it, the CI system that rendered that file,
 *      and /proc/<pid>/environ for anyone who can read it. A file can be mode
 *      0400 and delivered by systemd LoadCredential= into a tmpfs that is
 *      unmounted when the service stops. The env var is still supported,
 *      because it is what some deployments can actually do, but it is the
 *      weaker option and the start-up summary says so.
 *
 *   2. The key ring is VERSIONED. With a cloud KMS, rotating the KEK is a KMS
 *      operation and old ciphertext keeps working because the service retains
 *      previous versions. A single-key local file has no such property:
 *      replacing its contents makes every existing tenant DEK permanently
 *      unopenable. So the file holds a map of versions, new wraps use the one
 *      named `current`, and unwraps look up whichever version actually wrapped
 *      the row. Rotating the master key becomes: add a version, point `current`
 *      at it, restart, re-wrap at leisure, then drop the old version.
 *
 * Wrapped layout:  format(1) || nonce(12) || tag(16) || ciphertext(32)
 *
 * The leading format byte exists so that a future change of wrapping algorithm
 * is detectable rather than presenting as a corrupt key during an incident.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { HelmCryptoError } from './errors';
import {
  DEK_BYTES,
  serialiseContext,
  type EncryptionContext,
  type GeneratedDek,
  type RewrappedDek,
  type RewrappingKekProvider,
} from './kek';

const WRAP_FORMAT_V1 = 0x01;
const WRAP_NONCE_BYTES = 12;
const WRAP_TAG_BYTES = 16;
const WRAPPED_LENGTH = 1 + WRAP_NONCE_BYTES + WRAP_TAG_BYTES + DEK_BYTES;

/**
 * Just enough of `process.env` to read configuration from.
 *
 * Not `NodeJS.ProcessEnv`: Next.js augments that interface to require NODE_ENV,
 * which would mean every caller — tests especially — had to supply a value it
 * does not care about.
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Where the master key came from. Reported at start-up; never guessed later. */
export type MasterKeySource = 'file' | 'environment';

export interface MasterKeyRing {
  /** Version label whose key wraps all new DEKs. */
  readonly current: string;
  /** Every version this process can still unwrap with. */
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly source: MasterKeySource;
  /** Path, when loaded from a file. Used only in diagnostics. */
  readonly path?: string;
}

/**
 * A key ring file is JSON:
 *
 *   { "current": "v2",
 *     "keys": { "v1": "<base64 32 bytes>", "v2": "<base64 32 bytes>" } }
 *
 * A file containing nothing but a bare base64 key is also accepted and treated
 * as version "v1", because that is what someone who just ran
 * `openssl rand -base64 32 > helm-master.key` will have, and refusing it would
 * only encourage them to put the key in the environment instead.
 */
export function parseKeyRing(raw: string, source: MasterKeySource, path?: string): MasterKeyRing {
  const text = raw.trim();
  if (!text) {
    throw new HelmCryptoError('kek_unavailable', `master key ${describe(source, path)} is empty`);
  }

  let current: string;
  let entries: [string, string][];

  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new HelmCryptoError(
        'kek_unavailable',
        `master key ${describe(source, path)} starts with '{' but is not valid JSON`,
        { cause },
      );
    }
    const doc = parsed as { current?: unknown; keys?: unknown };
    if (typeof doc.current !== 'string' || !doc.current) {
      throw new HelmCryptoError('kek_unavailable', 'master key ring has no "current" version label');
    }
    if (!doc.keys || typeof doc.keys !== 'object' || Array.isArray(doc.keys)) {
      throw new HelmCryptoError('kek_unavailable', 'master key ring has no "keys" object');
    }
    current = doc.current;
    entries = Object.entries(doc.keys as Record<string, unknown>).map(([version, value]) => {
      if (typeof value !== 'string') {
        throw new HelmCryptoError(
          'kek_unavailable',
          `master key ring version ${version} is not a base64 string`,
        );
      }
      return [version, value];
    });
  } else {
    current = 'v1';
    entries = [['v1', text]];
  }

  const keys = new Map<string, Buffer>();
  const seen = new Map<string, string>();

  for (const [version, encoded] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(version)) {
      throw new HelmCryptoError(
        'kek_unavailable',
        `master key version label ${JSON.stringify(version)} is not a short alphanumeric label`,
      );
    }
    const key = decodeKey(version, encoded, source, path);

    // Two versions holding the same bytes means a rotation that did not
    // actually rotate. Silently accepting it would leave the operator believing
    // they had re-keyed when nothing changed.
    const fingerprint = key.toString('base64');
    const duplicate = seen.get(fingerprint);
    if (duplicate) {
      throw new HelmCryptoError(
        'kek_unavailable',
        `master key versions ${duplicate} and ${version} hold identical key material; ` +
          'a rotation must introduce new random bytes',
      );
    }
    seen.set(fingerprint, version);
    keys.set(version, key);
  }

  if (!keys.has(current)) {
    throw new HelmCryptoError(
      'kek_unavailable',
      `master key ring names "${current}" as current but has no such version`,
    );
  }

  return { current, keys, source, ...(path ? { path } : {}) };
}

function decodeKey(
  version: string,
  encoded: string,
  source: MasterKeySource,
  path: string | undefined,
): Buffer {
  const trimmed = encoded.trim();
  const key = Buffer.from(trimmed, 'base64');

  if (key.length !== 32) {
    throw new HelmCryptoError(
      'kek_unavailable',
      `master key ${describe(source, path)} version ${version} decodes to ${key.length} bytes; ` +
        'it must be 32 raw bytes, base64-encoded (openssl rand -base64 32)',
    );
  }

  // Buffer.from(..., 'base64') discards anything it cannot decode rather than
  // failing, so a truncated or corrupted value can still produce 32 bytes. A
  // round-trip catches that before it becomes "we cannot decrypt anything".
  if (key.toString('base64') !== trimmed.replace(/\s+/g, '')) {
    throw new HelmCryptoError(
      'kek_unavailable',
      `master key ${describe(source, path)} version ${version} is not cleanly base64-encoded; ` +
        'check for truncation or stray characters',
    );
  }

  if (key.every((b) => b === 0)) {
    throw new HelmCryptoError(
      'kek_unavailable',
      `master key ${describe(source, path)} version ${version} is all zero bytes; ` +
        'this is a placeholder, not a key',
    );
  }

  return key;
}

function describe(source: MasterKeySource, path?: string): string {
  return source === 'file' ? `file ${path}` : 'from HELM_KEK_B64';
}

/**
 * Read the key ring from disk, refusing a file anyone else on the host can read.
 *
 * The mode check is the whole point of preferring a file: a 0644 key file is
 * strictly worse than an environment variable, because it survives on the disk
 * image and in every backup of it.
 */
export function loadKeyRingFromFile(path: string): MasterKeyRing {
  let stat;
  try {
    stat = statSync(path);
  } catch (cause) {
    throw new HelmCryptoError('kek_unavailable', `master key file ${path} cannot be read`, { cause });
  }

  if (!stat.isFile()) {
    throw new HelmCryptoError('kek_unavailable', `master key file ${path} is not a regular file`);
  }

  const mode = stat.mode & 0o777;
  if (mode & 0o077) {
    throw new HelmCryptoError(
      'kek_unavailable',
      `master key file ${path} is mode ${mode.toString(8).padStart(4, '0')}; it must not be ` +
        `readable or writable by group or other — run: chmod 0400 ${path}`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new HelmCryptoError('kek_unavailable', `master key file ${path} cannot be read`, { cause });
  }

  return parseKeyRing(raw, 'file', path);
}

export function loadKeyRingFromEnv(value: string): MasterKeyRing {
  return parseKeyRing(value, 'environment');
}

export interface LocalMasterKekOptions {
  /**
   * Names the key ring in `tenant_data_key.kek_id`, which is recorded as
   * `<label>/<version>`. Change it only if you run more than one independent
   * Helm key ring; changing it after keys exist makes their kek_id unresolvable.
   */
  readonly label?: string;
}

/**
 * Wraps per-tenant DEKs with a master key held by this host.
 *
 * `provider` is reported as `local-keyfile` even when the key came from the
 * environment. The distinction that matters to an auditor reading
 * tenant_data_key months later is "an on-premises master key" versus "a
 * developer laptop key" (`local-dev`) versus "a KMS"; where the operator put
 * the bytes on that host is an operational detail recorded at start-up, not a
 * property of the ciphertext.
 */
export class LocalMasterKekProvider implements RewrappingKekProvider {
  readonly provider = 'local-keyfile' as const;
  readonly #ring: MasterKeyRing;
  readonly #label: string;

  constructor(ring: MasterKeyRing, options: LocalMasterKekOptions = {}) {
    const label = options.label ?? 'helm-master';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) {
      throw new HelmCryptoError('kek_unavailable', `invalid master key label ${JSON.stringify(label)}`);
    }
    this.#ring = ring;
    this.#label = label;
  }

  /**
   * Build from the environment: HELM_KEK_FILE wins, HELM_KEK_B64 is the
   * fallback. Setting both is a configuration mistake worth failing on — the
   * operator does not know which key is in use, and one of them is stale.
   */
  static fromEnv(env: EnvLike = process.env): LocalMasterKekProvider {
    const file = env.HELM_KEK_FILE?.trim();
    const inline = env.HELM_KEK_B64?.trim();

    if (file && inline) {
      throw new HelmCryptoError(
        'kek_unavailable',
        'both HELM_KEK_FILE and HELM_KEK_B64 are set; unset one so it is unambiguous ' +
          'which master key is in use',
      );
    }
    if (!file && !inline) {
      throw new HelmCryptoError(
        'kek_unavailable',
        'HELM_KEK_PROVIDER=local-keyfile requires HELM_KEK_FILE (preferred) or ' +
          'HELM_KEK_B64; generate a key with `openssl rand -base64 32`',
      );
    }

    const ring = file ? loadKeyRingFromFile(file) : loadKeyRingFromEnv(inline!);
    const label = env.HELM_KEK_ID?.trim();
    return new LocalMasterKekProvider(ring, label ? { label } : {});
  }

  /** For the start-up summary and the /api/health key-custody report. */
  describe(): { provider: string; source: MasterKeySource; current: string; versions: string[] } {
    return {
      provider: this.provider,
      source: this.#ring.source,
      current: this.#kekId(this.#ring.current),
      versions: [...this.#ring.keys.keys()].sort(),
    };
  }

  async generateDek(context: EncryptionContext): Promise<GeneratedDek> {
    const version = this.#ring.current;
    const kekId = this.#kekId(version);
    const plaintext = randomBytes(DEK_BYTES);

    const nonce = randomBytes(WRAP_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key(version, kekId), nonce);
    cipher.setAAD(this.#aad(context, kekId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return {
      plaintext,
      wrapped: Buffer.concat([Buffer.of(WRAP_FORMAT_V1), nonce, cipher.getAuthTag(), ciphertext]),
      kekId,
    };
  }

  async unwrapDek(wrapped: Buffer, kekId: string, context: EncryptionContext): Promise<Buffer> {
    const version = this.#version(kekId);
    const key = this.#key(version, kekId);

    if (wrapped.length !== WRAPPED_LENGTH || wrapped[0] !== WRAP_FORMAT_V1) {
      throw new HelmCryptoError(
        'invalid_envelope',
        'wrapped DEK is not in the local master key format',
      );
    }

    const nonce = wrapped.subarray(1, 1 + WRAP_NONCE_BYTES);
    const tag = wrapped.subarray(1 + WRAP_NONCE_BYTES, 1 + WRAP_NONCE_BYTES + WRAP_TAG_BYTES);
    const ciphertext = wrapped.subarray(1 + WRAP_NONCE_BYTES + WRAP_TAG_BYTES);

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(this.#aad(context, kekId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (cause) {
      throw new HelmCryptoError('dek_unwrap_failed', 'DEK could not be unwrapped', { cause });
    }
  }

  /**
   * Move a DEK onto the current master key version without changing the DEK.
   *
   * This is the second half of a master key rotation: after `current` points at
   * the new version, every existing row is re-wrapped, and only then may the
   * old version be removed from the key ring. The plaintext DEK exists in this
   * process for the duration of the call and is wiped before returning — it is
   * the same exposure as an ordinary unwrap, which this host does on every
   * secret read anyway.
   */
  async rewrapDek(
    wrapped: Buffer,
    kekId: string,
    context: EncryptionContext,
  ): Promise<RewrappedDek> {
    const targetKekId = this.#kekId(this.#ring.current);
    if (kekId === targetKekId) return { wrapped, kekId };

    const dek = await this.unwrapDek(wrapped, kekId, context);
    try {
      const nonce = randomBytes(WRAP_NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', this.#key(this.#ring.current, targetKekId), nonce);
      cipher.setAAD(this.#aad(context, targetKekId));
      const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
      return {
        wrapped: Buffer.concat([Buffer.of(WRAP_FORMAT_V1), nonce, cipher.getAuthTag(), ciphertext]),
        kekId: targetKekId,
      };
    } finally {
      dek.fill(0);
    }
  }

  #kekId(version: string): string {
    return `${this.#label}/${version}`;
  }

  /**
   * kek_id is `<label>/<version>`. A row naming a different label belongs to a
   * different key ring, and saying so beats a bare authentication failure —
   * which is what an operator would otherwise see after pointing a new server
   * at an old database.
   */
  #version(kekId: string): string {
    const separator = kekId.lastIndexOf('/');
    const label = separator === -1 ? '' : kekId.slice(0, separator);
    if (label !== this.#label) {
      throw new HelmCryptoError(
        'dek_unwrap_failed',
        `this DEK was wrapped by key ring "${label || kekId}"; this server holds "${this.#label}"`,
      );
    }
    return kekId.slice(separator + 1);
  }

  #key(version: string, kekId: string): Buffer {
    const key = this.#ring.keys.get(version);
    if (!key) {
      throw new HelmCryptoError(
        'dek_unwrap_failed',
        `master key version "${version}" is not in this server's key ring, so DEKs wrapped ` +
          `as ${kekId} cannot be opened; restore that version before retiring it`,
      );
    }
    return key;
  }

  /**
   * Bind the KEK version into the AAD alongside the tenant context.
   *
   * Looking the key up by version already means a swapped kek_id yields the
   * wrong key, but binding it makes that an authentication failure by
   * construction rather than by coincidence — and keeps the guarantee if the
   * key ring is ever changed to derive per-version keys from one root.
   */
  #aad(context: EncryptionContext, kekId: string): Buffer {
    return serialiseContext({ ...context, 'helm:kek': kekId });
  }
}
