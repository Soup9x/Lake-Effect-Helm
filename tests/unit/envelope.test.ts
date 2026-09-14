import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BlindIndex, scoreStrength } from '../../src/lib/crypto/blind-index';
import { DekCache } from '../../src/lib/crypto/dek-cache';
import {
  buildAad,
  openField,
  parseAad,
  sealField,
  wipe,
  type SecretBinding,
} from '../../src/lib/crypto/envelope';
import { HelmCryptoError } from '../../src/lib/crypto/errors';
import {
  AwsKmsKekProvider,
  LocalDevKekProvider,
  serialiseContext,
  tenantKeyContext,
  type EncryptionContext,
  type KekProvider,
} from '../../src/lib/crypto/kek';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
const SECRET = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** Flip one bit, written so noUncheckedIndexedAccess stays on. */
const flipBit = (buffer: Buffer, index = 0): Buffer => {
  buffer.writeUInt8(buffer.readUInt8(index) ^ 0x01, index);
  return buffer;
};

const binding = (over: Partial<SecretBinding> = {}): SecretBinding => ({
  tenantId: TENANT,
  secretId: SECRET,
  field: 'value',
  version: 1,
  ...over,
});

describe('field envelope', () => {
  const dek = randomBytes(32);

  it('round-trips a password', () => {
    const plaintext = Buffer.from('correct horse battery staple', 'utf8');
    const sealed = sealField(dek, plaintext, binding());
    expect(openField(dek, sealed, binding())).toEqual(plaintext);
  });

  it('produces the parameters the database schema requires', () => {
    const sealed = sealField(dek, Buffer.from('hunter2'), binding());
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.authTag).toHaveLength(16);
    expect(sealed.ciphertext.length).toBeGreaterThan(0);
  });

  it('never repeats a nonce across encryptions', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(sealField(dek, Buffer.from('same value'), binding()).nonce.toString('hex'));
    }
    expect(seen.size).toBe(500);
  });

  it('produces different ciphertext for the same plaintext', () => {
    // Deterministic ciphertext would let anyone with read access to the column
    // see which clients share a password.
    const a = sealField(dek, Buffer.from('shared password'), binding());
    const b = sealField(dek, Buffer.from('shared password'), binding());
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects a flipped bit in the ciphertext', () => {
    const sealed = sealField(dek, Buffer.from('hunter2'), binding());
    flipBit(sealed.ciphertext);
    expect(() => openField(dek, sealed, binding())).toThrow(HelmCryptoError);
  });

  it('rejects a tampered auth tag', () => {
    const sealed = sealField(dek, Buffer.from('hunter2'), binding());
    flipBit(sealed.authTag);
    expect(() => openField(dek, sealed, binding())).toThrow(HelmCryptoError);
  });

  it('rejects the wrong key', () => {
    const sealed = sealField(dek, Buffer.from('hunter2'), binding());
    expect(() => openField(randomBytes(32), sealed, binding())).toThrow(HelmCryptoError);
  });

  it('gives one indistinguishable message for every authentication failure', () => {
    // Distinct messages would tell an attacker whether they had the right key,
    // the right ciphertext, or the right binding.
    const sealed = sealField(dek, Buffer.from('hunter2'), binding());
    const wrongKey = (() => {
      try {
        openField(randomBytes(32), sealed);
        return null;
      } catch (e) {
        return (e as HelmCryptoError).message;
      }
    })();

    const tampered = { ...sealed, ciphertext: flipBit(Buffer.from(sealed.ciphertext)) };
    const wrongCiphertext = (() => {
      try {
        openField(dek, tampered);
        return null;
      } catch (e) {
        return (e as HelmCryptoError).message;
      }
    })();

    expect(wrongKey).toBe(wrongCiphertext);
  });
});

describe('AAD binds ciphertext to its row', () => {
  const dek = randomBytes(32);

  it('refuses a ciphertext replayed into another tenant', () => {
    const sealed = sealField(dek, Buffer.from('acme domain admin'), binding());
    // Simulate lifting the blob into another tenant's row, AAD and all.
    const replayed = { ...sealed, aad: buildAad(binding({ tenantId: OTHER_TENANT })) };
    expect(() => openField(dek, replayed)).toThrow(HelmCryptoError);
  });

  it('refuses a ciphertext replayed into another secret', () => {
    const sealed = sealField(dek, Buffer.from('acme domain admin'), binding());
    const replayed = {
      ...sealed,
      aad: buildAad(binding({ secretId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })),
    };
    expect(() => openField(dek, replayed)).toThrow(HelmCryptoError);
  });

  it('refuses the TOTP seed swapped into the password slot', () => {
    const sealed = sealField(dek, Buffer.from('seedseedseed'), binding({ field: 'totp_seed' }));
    const replayed = { ...sealed, aad: buildAad(binding({ field: 'value' })) };
    expect(() => openField(dek, replayed)).toThrow(HelmCryptoError);
  });

  it('refuses a rolled-back version', () => {
    const sealed = sealField(dek, Buffer.from('old password'), binding({ version: 1 }));
    const replayed = { ...sealed, aad: buildAad(binding({ version: 2 })) };
    expect(() => openField(dek, replayed)).toThrow(HelmCryptoError);
  });

  it('reports a mismatch clearly when the caller states what it expected', () => {
    const sealed = sealField(dek, Buffer.from('hunter2'), binding());
    expect(() => openField(dek, sealed, binding({ version: 2 }))).toThrow(
      /does not match the requested secret/,
    );
  });

  it('round-trips the AAD format', () => {
    const parsed = parseAad(buildAad(binding({ field: 'totp_seed', version: 7 })));
    expect(parsed).toEqual({
      aadVersion: 'helm.v1',
      tenantId: TENANT,
      secretId: SECRET,
      field: 'totp_seed',
      version: 7,
    });
  });

  it('refuses a field name that could forge a different binding', () => {
    expect(() => buildAad(binding({ field: 'value|1|evil' }))).toThrow(HelmCryptoError);
  });
});

describe('input validation', () => {
  const dek = randomBytes(32);

  it('refuses a short key', () => {
    expect(() => sealField(randomBytes(16), Buffer.from('x'), binding())).toThrow(/32 bytes/);
  });

  it('refuses an empty value', () => {
    // An empty password is almost always a bug upstream, and it encrypts to a
    // ciphertext indistinguishable from a real one.
    expect(() => sealField(dek, Buffer.alloc(0), binding())).toThrow(/empty/);
  });

  it('refuses a value the database column would reject anyway', () => {
    expect(() => sealField(dek, randomBytes(65 * 1024), binding())).toThrow(/exceeds/);
  });

  it('refuses a malformed envelope', () => {
    const sealed = sealField(dek, Buffer.from('x'), binding());
    expect(() => openField(dek, { ...sealed, nonce: randomBytes(8) })).toThrow(/12 bytes/);
    expect(() => openField(dek, { ...sealed, authTag: randomBytes(8) })).toThrow(/16 bytes/);
  });
});

describe('KEK wrapping', () => {
  const masterKey = randomBytes(32).toString('base64');

  it('wraps and unwraps a DEK', async () => {
    const kek = new LocalDevKekProvider(masterKey);
    const context = tenantKeyContext(TENANT, 1);
    const { plaintext, wrapped, kekId } = await kek.generateDek(context);

    expect(plaintext).toHaveLength(32);
    expect(await kek.unwrapDek(wrapped, kekId, context)).toEqual(plaintext);
  });

  it('refuses to unwrap under a different tenant context', async () => {
    // This is the property that makes a stolen wrapped_dek row useless: the
    // encryption context is bound, so it only opens as the tenant it was minted
    // for.
    const kek = new LocalDevKekProvider(masterKey);
    const { wrapped, kekId } = await kek.generateDek(tenantKeyContext(TENANT, 1));
    await expect(kek.unwrapDek(wrapped, kekId, tenantKeyContext(OTHER_TENANT, 1))).rejects.toThrow(
      /could not be unwrapped/,
    );
  });

  it('refuses to unwrap under a different key generation', async () => {
    const kek = new LocalDevKekProvider(masterKey);
    const { wrapped, kekId } = await kek.generateDek(tenantKeyContext(TENANT, 1));
    await expect(kek.unwrapDek(wrapped, kekId, tenantKeyContext(TENANT, 2))).rejects.toThrow();
  });

  it('refuses a DEK wrapped by a different KEK', async () => {
    const a = new LocalDevKekProvider(masterKey, 'local-dev/v1');
    const b = new LocalDevKekProvider(randomBytes(32).toString('base64'), 'local-dev/v2');
    const context = tenantKeyContext(TENANT, 1);
    const { wrapped, kekId } = await a.generateDek(context);
    await expect(b.unwrapDek(wrapped, kekId, context)).rejects.toThrow(/this provider holds/);
  });

  it('refuses a master key of the wrong length', () => {
    expect(() => new LocalDevKekProvider(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('serialises encryption context independently of key order', () => {
    const a: EncryptionContext = { b: '2', a: '1', c: '3' };
    const b: EncryptionContext = { c: '3', a: '1', b: '2' };
    expect(serialiseContext(a)).toEqual(serialiseContext(b));
  });
});

describe('KMS provider', () => {
  /** Minimal stand-in so the provider is testable without the AWS SDK. */
  class FakeKms {
    readonly calls: { type: string; input: Record<string, unknown> }[] = [];
    constructor(private readonly dek = randomBytes(32)) {}
    async send(command: unknown): Promise<unknown> {
      const { type, input } = command as { type: string; input: Record<string, unknown> };
      this.calls.push({ type, input });
      if (type === 'generate') {
        return {
          Plaintext: this.dek,
          CiphertextBlob: Buffer.concat([Buffer.from('wrapped:'), this.dek]),
          KeyId: 'arn:aws:kms:us-east-2:1234:key/abcd-1234',
        };
      }
      return { Plaintext: this.dek };
    }
  }

  const commands = {
    GenerateDataKeyCommand: class {
      readonly type = 'generate';
      constructor(readonly input: Record<string, unknown>) {}
    },
    DecryptCommand: class {
      readonly type = 'decrypt';
      constructor(readonly input: Record<string, unknown>) {}
    },
  } as never;

  it('prefers the resolved key ARN over the configured alias', async () => {
    // An alias moves during rotation; storing it would later name the wrong key.
    const kms = new FakeKms();
    const provider = new AwsKmsKekProvider(kms, commands, 'alias/helm-tenant-kek');
    const { kekId } = await provider.generateDek(tenantKeyContext(TENANT, 1));
    expect(kekId).toBe('arn:aws:kms:us-east-2:1234:key/abcd-1234');
  });

  it('passes the encryption context to KMS on both wrap and unwrap', async () => {
    const kms = new FakeKms();
    const provider = new AwsKmsKekProvider(kms, commands, 'alias/k');
    const context = tenantKeyContext(TENANT, 1);
    const { wrapped, kekId } = await provider.generateDek(context);
    await provider.unwrapDek(wrapped, kekId, context);

    expect(kms.calls).toHaveLength(2);
    for (const call of kms.calls) {
      expect(call.input.EncryptionContext).toEqual({
        'helm:purpose': 'tenant-dek',
        'helm:tenant': TENANT,
        'helm:generation': '1',
      });
    }
  });

  it('surfaces a KMS outage as kek_unavailable, not a generic error', async () => {
    const provider = new AwsKmsKekProvider(
      { send: async () => Promise.reject(new Error('throttled')) },
      commands,
      'alias/k',
    );
    await expect(provider.generateDek(tenantKeyContext(TENANT, 1))).rejects.toMatchObject({
      code: 'kek_unavailable',
    });
  });
});

describe('DEK cache', () => {
  /**
   * A KekProvider that delegates to a real one but counts unwraps.
   *
   * Built explicitly rather than by spreading the instance: LocalDevKekProvider
   * keeps its methods on the prototype, so `{ ...kek }` yields an object with no
   * methods at all — which happens to pass these tests (they never call
   * generateDek on it) while being a lie the type checker correctly rejects.
   */
  const makeProvider = () => {
    const kek = new LocalDevKekProvider(randomBytes(32).toString('base64'));
    const spy = vi.fn(kek.unwrapDek.bind(kek));
    const provider: KekProvider = {
      provider: kek.provider,
      generateDek: kek.generateDek.bind(kek),
      unwrapDek: spy,
    };
    return { kek, spy, provider };
  };

  it('unwraps once and serves the rest from memory', async () => {
    const { kek, spy, provider } = makeProvider();
    const context = tenantKeyContext(TENANT, 1);
    const { wrapped, kekId, plaintext } = await kek.generateDek(context);
    const cache = new DekCache(provider);

    const request = { dataKeyId: 'key-1', wrappedDek: wrapped, kekId, context };
    expect(await cache.get(request)).toEqual(plaintext);
    expect(await cache.get(request)).toEqual(plaintext);
    expect(await cache.get(request)).toEqual(plaintext);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(cache.stats).toMatchObject({ hits: 2, misses: 1 });
  });

  it('collapses concurrent unwraps of the same key into one call', async () => {
    // Opening a client page touches many secrets at once; without this, each
    // one is a separate KMS request.
    const { kek, spy, provider } = makeProvider();
    const context = tenantKeyContext(TENANT, 1);
    const { wrapped, kekId, plaintext } = await kek.generateDek(context);
    const cache = new DekCache(provider);

    const request = { dataKeyId: 'key-1', wrappedDek: wrapped, kekId, context };
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.get(request)));

    expect(spy).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toEqual(plaintext);
  });

  it('re-unwraps after the TTL expires', async () => {
    const { kek, spy, provider } = makeProvider();
    const context = tenantKeyContext(TENANT, 1);
    const { wrapped, kekId } = await kek.generateDek(context);

    let now = 1_000_000;
    const cache = new DekCache(provider, { ttlMs: 60_000, now: () => now });
    const request = { dataKeyId: 'key-1', wrappedDek: wrapped, kekId, context };

    await cache.get(request);
    now += 59_000;
    await cache.get(request);
    expect(spy).toHaveBeenCalledTimes(1);

    now += 2_000;
    await cache.get(request);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure', async () => {
    // A transient KMS outage must not poison the entry for the whole TTL.
    const kek = new LocalDevKekProvider(randomBytes(32).toString('base64'));
    const context = tenantKeyContext(TENANT, 1);
    const { wrapped, kekId, plaintext } = await kek.generateDek(context);

    let failNext = true;
    const provider = {
      provider: kek.provider,
      generateDek: kek.generateDek.bind(kek),
      unwrapDek: async (w: Buffer, k: string, c: EncryptionContext) => {
        if (failNext) {
          failNext = false;
          throw new Error('KMS throttled');
        }
        return kek.unwrapDek(w, k, c);
      },
    };

    const cache = new DekCache(provider);
    const request = { dataKeyId: 'key-1', wrappedDek: wrapped, kekId, context };

    await expect(cache.get(request)).rejects.toThrow(/throttled/);
    expect(await cache.get(request)).toEqual(plaintext);
  });

  it('zeroes and drops a key on invalidate', async () => {
    const { kek, spy, provider } = makeProvider();
    const context = tenantKeyContext(TENANT, 1);
    const { wrapped, kekId } = await kek.generateDek(context);
    const cache = new DekCache(provider);
    const request = { dataKeyId: 'key-1', wrappedDek: wrapped, kekId, context };

    const first = await cache.get(request);
    cache.invalidate('key-1');
    // The cache's copy is zeroed on eviction; a caller that squirrelled it away
    // sees that, which is the intended signal not to hold DEKs.
    expect(first.every((b) => b === 0)).toBe(true);

    await cache.get(request);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry when full', async () => {
    const { kek, provider } = makeProvider();
    const cache = new DekCache(provider, { maxEntries: 2 });

    for (const id of ['a', 'b', 'c']) {
      const context = tenantKeyContext(id, 1);
      const { wrapped, kekId } = await kek.generateDek(context);
      await cache.get({ dataKeyId: id, wrappedDek: wrapped, kekId, context });
    }
    expect(cache.stats.size).toBeLessThanOrEqual(2);
  });
});

describe('blind index', () => {
  const key = randomBytes(32).toString('base64');

  it('produces equal indexes for equal plaintexts in one tenant', () => {
    const index = new BlindIndex(key);
    const a = index.compute(TENANT, Buffer.from('Summer2024!'));
    const b = index.compute(TENANT, Buffer.from('Summer2024!'));
    expect(index.matches(a, b)).toBe(true);
  });

  it('produces different indexes across tenants for the same plaintext', () => {
    // Stops tenant A's captured index being used as a dictionary against B.
    const index = new BlindIndex(key);
    const a = index.compute(TENANT, Buffer.from('Summer2024!'));
    const b = index.compute(OTHER_TENANT, Buffer.from('Summer2024!'));
    expect(index.matches(a, b)).toBe(false);
  });

  it('produces a 32-byte value, matching the column CHECK', () => {
    expect(new BlindIndex(key).compute(TENANT, Buffer.from('x'))).toHaveLength(32);
  });

  it('is disabled rather than fatal when unconfigured', () => {
    const saved = process.env.HELM_BLIND_INDEX_KEY_B64;
    delete process.env.HELM_BLIND_INDEX_KEY_B64;
    expect(BlindIndex.fromEnv()).toBeNull();
    if (saved !== undefined) process.env.HELM_BLIND_INDEX_KEY_B64 = saved;
  });

  it('refuses a short key', () => {
    expect(() => new BlindIndex(randomBytes(16).toString('base64'))).toThrow(/at least 32/);
  });
});

describe('strength scoring', () => {
  it('ranks obviously weak passwords low', () => {
    for (const weak of ['abc', 'password', '123456', 'aaaaaaaa']) {
      expect(scoreStrength(weak)).toBeLessThanOrEqual(1);
    }
  });

  it('ranks long mixed passwords high', () => {
    expect(scoreStrength('7Kq!zR2m#Vb9wLx4')).toBeGreaterThanOrEqual(3);
    expect(scoreStrength('correct-horse-battery-staple-9271')).toBeGreaterThanOrEqual(3);
  });

  it('stays inside the range the column accepts', () => {
    for (const p of ['', 'a', 'x'.repeat(200), '7Kq!zR2m#Vb9wLx4']) {
      const score = scoreStrength(p);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(4);
    }
  });
});

describe('wipe', () => {
  it('overwrites buffers and tolerates nullish entries', () => {
    const a = Buffer.from('sensitive');
    wipe(a, undefined, null);
    expect(a.every((b) => b === 0)).toBe(true);
  });
});
