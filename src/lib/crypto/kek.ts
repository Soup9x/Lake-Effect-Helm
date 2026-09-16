/**
 * Key Encryption Key providers.
 *
 * The KEK never leaves its boundary. A provider does exactly two things: mint a
 * new DEK (returning it both in the clear, once, and wrapped), and unwrap a DEK
 * it previously wrapped.
 *
 * Encryption context is passed to every operation and is cryptographically
 * bound by the provider (KMS calls it "encryption context"; the local provider
 * uses it as GCM additional data). A wrapped DEK lifted from tenant A's row
 * therefore cannot be unwrapped as tenant B's, even by someone holding full KMS
 * permissions — the context will not match.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { HelmCryptoError } from './errors';

export const DEK_BYTES = 32; // AES-256
const WRAP_NONCE_BYTES = 12;
const WRAP_TAG_BYTES = 16;

/** Separator for canonical context serialisation: ASCII unit separator. */
const FIELD_SEPARATOR = String.fromCharCode(0x1f);

/**
 * What wrapped a given DEK, recorded per row in `tenant_data_key.wrap_provider`.
 *
 * `local-keyfile` and `local-dev` are deliberately distinct values even though
 * both are AES-256-GCM under a key this process holds. An auditor reading the
 * table needs to tell "the on-premises master key this deployment is built
 * around" from "a throwaway key someone's laptop generated"; collapsing them
 * would erase exactly the distinction they are looking for.
 */
export type WrapProvider =
  | 'aws-kms'
  | 'gcp-kms'
  | 'azure-keyvault'
  | 'vault-transit'
  | 'local-keyfile'
  | 'local-dev';

export interface EncryptionContext {
  readonly [key: string]: string;
}

export interface GeneratedDek {
  /** The DEK in the clear. Held only long enough to encrypt with; never stored. */
  readonly plaintext: Buffer;
  /** What goes into tenant_data_key.wrapped_dek. */
  readonly wrapped: Buffer;
  /** Identifies the KEK *including its version*, so rotation stays auditable. */
  readonly kekId: string;
}

export interface KekProvider {
  readonly provider: WrapProvider;
  generateDek(context: EncryptionContext): Promise<GeneratedDek>;
  unwrapDek(wrapped: Buffer, kekId: string, context: EncryptionContext): Promise<Buffer>;
}

/** What a re-wrap produced: the same DEK, sealed under a newer KEK version. */
export interface RewrappedDek {
  readonly wrapped: Buffer;
  readonly kekId: string;
}

/**
 * A provider that can move an existing DEK onto the current KEK version.
 *
 * This is what makes rotating the MASTER key an operation rather than an
 * outage. The DEK itself does not change, so no field ciphertext is touched:
 * rotating the KEK is an UPDATE of one column per tenant, where rotating a DEK
 * means re-encrypting every secret.
 *
 * Optional because not every provider can do it without being handed a
 * capability we would rather it did not have. Vault exposes `transit/rewrap`,
 * which never reveals the plaintext DEK to Helm at all; the local providers
 * unwrap and re-wrap in memory, which they can do because they hold the master
 * key anyway. A KMS provider using Encrypt would need a plaintext round-trip,
 * which is why this is not on the base interface.
 */
export interface RewrappingKekProvider extends KekProvider {
  rewrapDek(wrapped: Buffer, kekId: string, context: EncryptionContext): Promise<RewrappedDek>;
}

export function supportsRewrap(provider: KekProvider): provider is RewrappingKekProvider {
  return typeof (provider as Partial<RewrappingKekProvider>).rewrapDek === 'function';
}

/**
 * Canonical serialisation of an encryption context.
 *
 * Sorted by key, so two contexts with the same pairs in a different order
 * produce identical bytes. Without this, a DEK wrapped by one code path would
 * intermittently fail to unwrap in another — a bug that surfaces months later
 * as "sometimes we cannot decrypt".
 */
export function serialiseContext(context: EncryptionContext): Buffer {
  const parts = Object.keys(context)
    .sort()
    .map((k) => `${k}=${context[k]}`);
  return Buffer.from(parts.join(FIELD_SEPARATOR), 'utf8');
}

/**
 * The encryption context Helm binds every DEK to.
 *
 * Kept in one place because wrap and unwrap must agree exactly, and the failure
 * mode of disagreement is data that cannot be decrypted at all.
 */
export function tenantKeyContext(tenantId: string, generation: number): EncryptionContext {
  return {
    'helm:purpose': 'tenant-dek',
    'helm:tenant': tenantId,
    'helm:generation': String(generation),
  };
}

// ---------------------------------------------------------------------------
// Local development
// ---------------------------------------------------------------------------

/**
 * Wraps DEKs with a master key read from the environment.
 *
 * FOR DEVELOPMENT ONLY. The master key sits in a process environment variable:
 * visible in crash dumps, in the container spec, in whatever CI system rendered
 * the deployment, and on some systems in the process listing. The entire point
 * of a KEK is that it lives somewhere the application cannot read it, and this
 * provider gives that up so a laptop does not need a KMS.
 *
 * Wrapped layout: nonce(12) || tag(16) || ciphertext(32)
 */
export class LocalDevKekProvider implements KekProvider {
  readonly provider = 'local-dev' as const;
  readonly #masterKey: Buffer;
  readonly #kekId: string;

  constructor(masterKeyBase64: string, kekId = 'local-dev/v1') {
    const key = Buffer.from(masterKeyBase64, 'base64');
    if (key.length !== 32) {
      throw new HelmCryptoError(
        'kek_unavailable',
        `local KEK must be 32 bytes base64-encoded, got ${key.length}`,
      );
    }
    this.#masterKey = key;
    this.#kekId = kekId;
  }

  static fromEnv(): LocalDevKekProvider {
    const raw = process.env.HELM_LOCAL_KEK_B64;
    if (!raw) {
      throw new HelmCryptoError(
        'kek_unavailable',
        'HELM_LOCAL_KEK_B64 is not set; generate one with `openssl rand -base64 32`',
      );
    }
    return new LocalDevKekProvider(raw);
  }

  async generateDek(context: EncryptionContext): Promise<GeneratedDek> {
    const plaintext = randomBytes(DEK_BYTES);
    return {
      plaintext,
      wrapped: this.#wrap(plaintext, context),
      kekId: this.#kekId,
    };
  }

  async unwrapDek(wrapped: Buffer, kekId: string, context: EncryptionContext): Promise<Buffer> {
    if (kekId !== this.#kekId) {
      throw new HelmCryptoError(
        'dek_unwrap_failed',
        `DEK was wrapped by KEK ${kekId}; this provider holds ${this.#kekId}`,
      );
    }
    if (wrapped.length !== WRAP_NONCE_BYTES + WRAP_TAG_BYTES + DEK_BYTES) {
      throw new HelmCryptoError('invalid_envelope', 'wrapped DEK has an unexpected length');
    }

    const nonce = wrapped.subarray(0, WRAP_NONCE_BYTES);
    const tag = wrapped.subarray(WRAP_NONCE_BYTES, WRAP_NONCE_BYTES + WRAP_TAG_BYTES);
    const ciphertext = wrapped.subarray(WRAP_NONCE_BYTES + WRAP_TAG_BYTES);

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#masterKey, nonce);
      decipher.setAAD(serialiseContext(context));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (cause) {
      throw new HelmCryptoError('dek_unwrap_failed', 'DEK could not be unwrapped', { cause });
    }
  }

  #wrap(dek: Buffer, context: EncryptionContext): Buffer {
    const nonce = randomBytes(WRAP_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#masterKey, nonce);
    cipher.setAAD(serialiseContext(context));
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }
}

// ---------------------------------------------------------------------------
// AWS KMS
// ---------------------------------------------------------------------------

/**
 * The slice of @aws-sdk/client-kms this provider needs.
 *
 * Declared structurally rather than by importing the SDK: it keeps a large
 * cloud dependency out of a package that is mostly schema, and it makes the
 * provider testable with a fake instead of against live KMS.
 */
export interface KmsClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface KmsCommandFactory {
  GenerateDataKeyCommand: new (input: {
    KeyId: string;
    KeySpec: 'AES_256';
    EncryptionContext: Record<string, string>;
  }) => unknown;
  DecryptCommand: new (input: {
    CiphertextBlob: Uint8Array;
    KeyId?: string;
    EncryptionContext: Record<string, string>;
  }) => unknown;
}

interface GenerateDataKeyResult {
  Plaintext?: Uint8Array;
  CiphertextBlob?: Uint8Array;
  KeyId?: string;
}

interface DecryptResult {
  Plaintext?: Uint8Array;
}

/**
 * Wraps DEKs with AWS KMS.
 *
 * Wire it up at the composition root:
 *
 *   import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
 *   new AwsKmsKekProvider(new KMSClient({}), { GenerateDataKeyCommand, DecryptCommand },
 *                         process.env.HELM_KEK_ID!);
 *
 * The encryption context goes to KMS on both wrap and unwrap, and KMS enforces
 * the match itself — so a wrapped DEK copied between tenants is refused by KMS
 * rather than by application logic somebody might later "simplify".
 */
export class AwsKmsKekProvider implements KekProvider {
  readonly provider = 'aws-kms' as const;

  constructor(
    private readonly client: KmsClientLike,
    private readonly commands: KmsCommandFactory,
    private readonly keyId: string,
  ) {}

  async generateDek(context: EncryptionContext): Promise<GeneratedDek> {
    let result: GenerateDataKeyResult;
    try {
      result = (await this.client.send(
        new this.commands.GenerateDataKeyCommand({
          KeyId: this.keyId,
          KeySpec: 'AES_256',
          EncryptionContext: { ...context },
        }),
      )) as GenerateDataKeyResult;
    } catch (cause) {
      throw new HelmCryptoError('kek_unavailable', 'KMS GenerateDataKey failed', { cause });
    }

    if (!result.Plaintext || !result.CiphertextBlob) {
      throw new HelmCryptoError('kek_unavailable', 'KMS returned an incomplete data key');
    }

    return {
      plaintext: Buffer.from(result.Plaintext),
      wrapped: Buffer.from(result.CiphertextBlob),
      // Prefer the resolved key ARN over the configured alias: an alias moves
      // during rotation, and a stored alias would then name the wrong key.
      kekId: result.KeyId ?? this.keyId,
    };
  }

  async unwrapDek(wrapped: Buffer, kekId: string, context: EncryptionContext): Promise<Buffer> {
    let result: DecryptResult;
    try {
      result = (await this.client.send(
        new this.commands.DecryptCommand({
          CiphertextBlob: wrapped,
          KeyId: kekId,
          EncryptionContext: { ...context },
        }),
      )) as DecryptResult;
    } catch (cause) {
      throw new HelmCryptoError('dek_unwrap_failed', 'KMS Decrypt failed', { cause });
    }

    if (!result.Plaintext) {
      throw new HelmCryptoError('dek_unwrap_failed', 'KMS returned no plaintext');
    }
    return Buffer.from(result.Plaintext);
  }
}

/** Constant-time comparison that tolerates a length mismatch (length is not secret). */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
