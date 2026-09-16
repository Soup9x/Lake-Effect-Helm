/**
 * On-premises master key custody.
 *
 * Helm runs on a customer's own server with no cloud KMS, so these two
 * providers are the entire root of the key hierarchy. The properties tested
 * here are the ones whose absence would not show up as a failing request — a
 * key ring that quietly wraps under the wrong version, a Vault key without
 * derivation that ignores the tenant binding, a file the whole box can read —
 * and would instead show up in an incident report.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HelmCryptoError } from '../../src/lib/crypto/errors';
import { serialiseContext, tenantKeyContext } from '../../src/lib/crypto/kek';
import {
  LocalMasterKekProvider,
  loadKeyRingFromFile,
  parseKeyRing,
  type MasterKeyRing,
} from '../../src/lib/crypto/kek-local';
import {
  AppRoleVaultToken,
  StaticVaultToken,
  VaultTransitKekProvider,
  vaultTokenSourceFromEnv,
  type HttpClientLike,
} from '../../src/lib/crypto/kek-vault';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';

const key = (): string => randomBytes(32).toString('base64');

const ring = (current: string, keys: Record<string, string>): MasterKeyRing =>
  parseKeyRing(JSON.stringify({ current, keys }), 'file', '/test/key');

// ---------------------------------------------------------------------------
// Local master key ring
// ---------------------------------------------------------------------------

describe('master key ring parsing', () => {
  it('accepts a bare base64 key as version v1', () => {
    const parsed = parseKeyRing(key(), 'environment');
    expect(parsed.current).toBe('v1');
    expect([...parsed.keys.keys()]).toEqual(['v1']);
  });

  it('accepts a versioned key ring', () => {
    const parsed = ring('v2', { v1: key(), v2: key() });
    expect(parsed.current).toBe('v2');
    expect([...parsed.keys.keys()].sort()).toEqual(['v1', 'v2']);
  });

  it('tolerates surrounding whitespace, which every key file has', () => {
    const k = key();
    expect(parseKeyRing(`  ${k}\n`, 'file', '/x').keys.get('v1')).toEqual(
      Buffer.from(k, 'base64'),
    );
  });

  it('refuses a key of the wrong length', () => {
    expect(() => parseKeyRing(randomBytes(16).toString('base64'), 'environment')).toThrow(
      /must be 32 raw bytes/,
    );
  });

  it('refuses a key that is not cleanly base64', () => {
    // Buffer.from(..., 'base64') silently discards junk rather than failing, so
    // a truncated key can still decode to 32 bytes. That must not pass.
    const truncated = `${randomBytes(48).toString('base64').slice(0, 43)}!!`;
    expect(() => parseKeyRing(truncated, 'environment')).toThrow(HelmCryptoError);
  });

  it('refuses an all-zero key', () => {
    expect(() => parseKeyRing(Buffer.alloc(32).toString('base64'), 'environment')).toThrow(
      /placeholder, not a key/,
    );
  });

  it('refuses a rotation that reuses the same bytes', () => {
    const same = key();
    expect(() => ring('v2', { v1: same, v2: same })).toThrow(/identical key material/);
  });

  it('refuses a current version that is not in the ring', () => {
    expect(() => ring('v3', { v1: key() })).toThrow(/no such version/);
  });

  it('refuses a version label that is not a short identifier', () => {
    expect(() => ring('../../etc/shadow', { '../../etc/shadow': key() })).toThrow(
      /not a short alphanumeric label/,
    );
  });

  it('refuses an empty key ring', () => {
    expect(() => parseKeyRing('   ', 'file', '/x')).toThrow(/is empty/);
  });

  it('names the file in the error, because that is what the operator must fix', () => {
    expect(() => parseKeyRing('{ not json', 'file', '/etc/helm/master.key')).toThrow(
      /\/etc\/helm\/master\.key/,
    );
  });
});

describe('master key file permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-kek-'));

  const writeKey = (name: string, mode: number, contents = key()): string => {
    const path = join(dir, name);
    writeFileSync(path, contents);
    chmodSync(path, mode);
    return path;
  };

  it('accepts a mode 0400 file', () => {
    const loaded = loadKeyRingFromFile(writeKey('ok.key', 0o400));
    expect(loaded.source).toBe('file');
  });

  it('accepts a mode 0600 file', () => {
    expect(() => loadKeyRingFromFile(writeKey('rw.key', 0o600))).not.toThrow();
  });

  it('refuses a group-readable file', () => {
    expect(() => loadKeyRingFromFile(writeKey('group.key', 0o440))).toThrow(/chmod 0400/);
  });

  it('refuses a world-readable file', () => {
    // 0444 is what `docker secret` mounts by default, which is precisely why
    // this check exists rather than being assumed.
    expect(() => loadKeyRingFromFile(writeKey('world.key', 0o444))).toThrow(
      /readable or writable by group or other/,
    );
  });

  it('refuses a directory', () => {
    expect(() => loadKeyRingFromFile(dir)).toThrow(/not a regular file/);
  });

  it('refuses a missing file with a message naming the path', () => {
    expect(() => loadKeyRingFromFile(join(dir, 'absent.key'))).toThrow(/absent\.key cannot be read/);
  });
});

describe('local master KEK provider', () => {
  it('round-trips a DEK', async () => {
    const provider = new LocalMasterKekProvider(ring('v1', { v1: key() }));
    const context = tenantKeyContext(TENANT, 1);
    const generated = await provider.generateDek(context);

    expect(generated.plaintext).toHaveLength(32);
    expect(generated.kekId).toBe('helm-master/v1');
    await expect(provider.unwrapDek(generated.wrapped, generated.kekId, context)).resolves.toEqual(
      generated.plaintext,
    );
  });

  it('reports the wrap provider the schema records', () => {
    expect(new LocalMasterKekProvider(ring('v1', { v1: key() })).provider).toBe('local-keyfile');
  });

  it('wraps to a self-describing fixed-length envelope', () => {
    // format(1) || nonce(12) || tag(16) || ciphertext(32)
    return new LocalMasterKekProvider(ring('v1', { v1: key() }))
      .generateDek(tenantKeyContext(TENANT, 1))
      .then((generated) => {
        expect(generated.wrapped).toHaveLength(61);
        expect(generated.wrapped[0]).toBe(0x01);
      });
  });

  it('refuses a wrapped blob in an unknown format', async () => {
    const provider = new LocalMasterKekProvider(ring('v1', { v1: key() }));
    const generated = await provider.generateDek(tenantKeyContext(TENANT, 1));
    const tampered = Buffer.from(generated.wrapped);
    tampered.writeUInt8(0x02, 0);

    await expect(
      provider.unwrapDek(tampered, generated.kekId, tenantKeyContext(TENANT, 1)),
    ).rejects.toThrow(/not in the local master key format/);
  });

  it('will not open another tenant’s DEK', async () => {
    const provider = new LocalMasterKekProvider(ring('v1', { v1: key() }));
    const generated = await provider.generateDek(tenantKeyContext(TENANT, 1));

    await expect(
      provider.unwrapDek(generated.wrapped, generated.kekId, tenantKeyContext(OTHER_TENANT, 1)),
    ).rejects.toThrow(/could not be unwrapped/);
  });

  it('will not open a DEK from another key generation', async () => {
    const provider = new LocalMasterKekProvider(ring('v1', { v1: key() }));
    const generated = await provider.generateDek(tenantKeyContext(TENANT, 1));

    await expect(
      provider.unwrapDek(generated.wrapped, generated.kekId, tenantKeyContext(TENANT, 2)),
    ).rejects.toThrow(/could not be unwrapped/);
  });

  it('detects a flipped bit anywhere in the envelope', async () => {
    const provider = new LocalMasterKekProvider(ring('v1', { v1: key() }));
    const context = tenantKeyContext(TENANT, 1);
    const generated = await provider.generateDek(context);

    for (let i = 1; i < generated.wrapped.length; i += 1) {
      const tampered = Buffer.from(generated.wrapped);
      tampered.writeUInt8(tampered.readUInt8(i) ^ 0x01, i);
      await expect(provider.unwrapDek(tampered, generated.kekId, context)).rejects.toThrow(
        HelmCryptoError,
      );
    }
  });

  describe('master key rotation', () => {
    const v1 = key();
    const v2 = key();

    it('keeps opening DEKs wrapped by an older version', async () => {
      const before = new LocalMasterKekProvider(ring('v1', { v1 }));
      const context = tenantKeyContext(TENANT, 1);
      const old = await before.generateDek(context);
      expect(old.kekId).toBe('helm-master/v1');

      // The operator adds v2 and points `current` at it. Every existing row
      // must still open, or the rotation is a data-loss event.
      const after = new LocalMasterKekProvider(ring('v2', { v1, v2 }));
      await expect(after.unwrapDek(old.wrapped, old.kekId, context)).resolves.toEqual(old.plaintext);

      const fresh = await after.generateDek(context);
      expect(fresh.kekId).toBe('helm-master/v2');
    });

    it('says which version is missing when an old key was dropped too early', async () => {
      const before = new LocalMasterKekProvider(ring('v1', { v1 }));
      const old = await before.generateDek(tenantKeyContext(TENANT, 1));

      const after = new LocalMasterKekProvider(ring('v2', { v2 }));
      await expect(
        after.unwrapDek(old.wrapped, old.kekId, tenantKeyContext(TENANT, 1)),
      ).rejects.toThrow(/version "v1" is not in this server's key ring/);
    });

    it('will not open a DEK wrapped under a different version label', async () => {
      const provider = new LocalMasterKekProvider(ring('v2', { v1, v2 }));
      const context = tenantKeyContext(TENANT, 1);
      const generated = await provider.generateDek(context);

      // Same ring, but claim the row was wrapped by v1. The KEK version is in
      // the AAD, so this fails even though the process holds both keys.
      await expect(provider.unwrapDek(generated.wrapped, 'helm-master/v1', context)).rejects.toThrow(
        /could not be unwrapped/,
      );
    });

    it('names the other key ring when a server is pointed at a foreign database', async () => {
      const provider = new LocalMasterKekProvider(ring('v1', { v1 }));
      await expect(
        provider.unwrapDek(Buffer.alloc(61), 'other-msp/v1', tenantKeyContext(TENANT, 1)),
      ).rejects.toThrow(/wrapped by key ring "other-msp"/);
    });
  });

  describe('fromEnv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helm-kek-env-'));

    it('prefers the file', () => {
      const path = join(dir, 'master.key');
      writeFileSync(path, key());
      chmodSync(path, 0o400);

      const provider = LocalMasterKekProvider.fromEnv({ HELM_KEK_FILE: path });
      expect(provider.describe().source).toBe('file');
    });

    it('accepts the environment variable', () => {
      const provider = LocalMasterKekProvider.fromEnv({ HELM_KEK_B64: key() });
      expect(provider.describe()).toMatchObject({ source: 'environment', current: 'helm-master/v1' });
    });

    it('refuses both at once, because one of them is stale', () => {
      expect(() =>
        LocalMasterKekProvider.fromEnv({ HELM_KEK_FILE: '/x', HELM_KEK_B64: key() }),
      ).toThrow(/unset one/);
    });

    it('refuses neither', () => {
      expect(() => LocalMasterKekProvider.fromEnv({})).toThrow(/requires HELM_KEK_FILE/);
    });

    it('takes the key ring label from HELM_KEK_ID', async () => {
      const provider = LocalMasterKekProvider.fromEnv({
        HELM_KEK_B64: key(),
        HELM_KEK_ID: 'lake-effect-prod',
      });
      const generated = await provider.generateDek(tenantKeyContext(TENANT, 1));
      expect(generated.kekId).toBe('lake-effect-prod/v1');
    });
  });
});

// ---------------------------------------------------------------------------
// Vault transit
// ---------------------------------------------------------------------------

/**
 * A fake Vault that behaves like the real transit engine in the ways this
 * provider depends on: derived keys, versioned ciphertext, context binding
 * enforced by the service rather than the client.
 */
function fakeVault(options: { derived?: boolean; keyVersion?: number } = {}) {
  const derived = options.derived ?? true;
  const keyVersion = options.keyVersion ?? 1;
  const calls: { url: string; body: unknown; token: string | undefined }[] = [];
  let status = 200;
  let failNext: number | null = null;

  const http: HttpClientLike = async (url, init) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, body, token: init.headers['x-vault-token'] });

    if (failNext !== null) {
      const code = failNext;
      failNext = null;
      return { status: code, text: async () => JSON.stringify({ errors: ['permission denied'] }) };
    }
    if (status !== 200) {
      return { status, text: async () => JSON.stringify({ errors: ['permission denied'] }) };
    }

    if (url.includes('/keys/')) {
      return {
        status: 200,
        text: async () => JSON.stringify({ data: { derived, type: 'aes256-gcm96', latest_version: keyVersion } }),
      };
    }

    if (url.includes('/datakey/plaintext/')) {
      const plaintext = randomBytes(32);
      // Real transit binds the context into the ciphertext. The fake stores it
      // so decrypt can enforce the same thing.
      const blob = Buffer.concat([
        Buffer.from(String(body?.context ?? ''), 'utf8'),
        Buffer.from('|', 'utf8'),
        plaintext,
      ]).toString('base64');
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              plaintext: plaintext.toString('base64'),
              ciphertext: `vault:v${keyVersion}:${blob}`,
              key_version: keyVersion,
            },
          }),
      };
    }

    if (url.includes('/decrypt/')) {
      const raw = String(body?.ciphertext ?? '').replace(/^vault:v\d+:/, '');
      const decoded = Buffer.from(raw, 'base64');
      const separator = decoded.indexOf(0x7c);
      const boundContext = decoded.subarray(0, separator).toString('utf8');

      if (!derived || boundContext !== String(body?.context ?? '')) {
        return { status: 400, text: async () => JSON.stringify({ errors: ['unable to decrypt'] }) };
      }
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ data: { plaintext: decoded.subarray(separator + 1).toString('base64') } }),
      };
    }

    if (url.includes('/auth/')) {
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ auth: { client_token: `s.${calls.length}`, lease_duration: 3600 } }),
      };
    }

    return { status: 404, text: async () => JSON.stringify({ errors: ['unsupported path'] }) };
  };

  return {
    http,
    calls,
    failOnce: (code: number) => {
      failNext = code;
    },
    setStatus: (code: number) => {
      status = code;
    },
  };
}

const vaultProvider = (vault: ReturnType<typeof fakeVault>, over: Record<string, unknown> = {}) =>
  new VaultTransitKekProvider({
    addr: 'https://vault.internal:8200',
    keyName: 'helm-tenant-kek',
    tokens: new StaticVaultToken('s.test'),
    http: vault.http,
    ...over,
  });

describe('Vault transit KEK provider', () => {
  it('round-trips a DEK and records the key version in the kek id', async () => {
    const vault = fakeVault({ keyVersion: 3 });
    const provider = vaultProvider(vault);
    const context = tenantKeyContext(TENANT, 1);

    const generated = await provider.generateDek(context);
    expect(generated.kekId).toBe('transit/helm-tenant-kek/v3');
    expect(generated.plaintext).toHaveLength(32);

    await expect(provider.unwrapDek(generated.wrapped, generated.kekId, context)).resolves.toEqual(
      generated.plaintext,
    );
  });

  it('refuses a transit key created without derived=true', async () => {
    // Without derivation Vault accepts and IGNORES the context, so every wrap
    // and unwrap would succeed and the per-tenant binding would not exist.
    const provider = vaultProvider(fakeVault({ derived: false }));
    await expect(provider.generateDek(tenantKeyContext(TENANT, 1))).rejects.toThrow(
      /derived=true/,
    );
  });

  it('checks derivation once per process, not once per wrap', async () => {
    const vault = fakeVault();
    const provider = vaultProvider(vault);
    await provider.generateDek(tenantKeyContext(TENANT, 1));
    await provider.generateDek(tenantKeyContext(TENANT, 2));

    expect(vault.calls.filter((c) => c.url.includes('/keys/'))).toHaveLength(1);
  });

  it('sends the tenant context so Vault enforces the binding', async () => {
    const vault = fakeVault();
    const provider = vaultProvider(vault);
    const context = tenantKeyContext(TENANT, 4);
    await provider.generateDek(context);

    const call = vault.calls.find((c) => c.url.includes('/datakey/'));
    expect((call?.body as { context: string }).context).toBe(
      serialiseContext(context).toString('base64'),
    );
  });

  it('will not open another tenant’s DEK', async () => {
    const provider = vaultProvider(fakeVault());
    const generated = await provider.generateDek(tenantKeyContext(TENANT, 1));

    await expect(
      provider.unwrapDek(generated.wrapped, generated.kekId, tenantKeyContext(OTHER_TENANT, 1)),
    ).rejects.toThrow(HelmCryptoError);
  });

  it('reports an unwrap failure as dek_unwrap_failed, not as Vault being down', async () => {
    const provider = vaultProvider(fakeVault());
    const generated = await provider.generateDek(tenantKeyContext(TENANT, 1));

    await expect(
      provider.unwrapDek(generated.wrapped, generated.kekId, tenantKeyContext(OTHER_TENANT, 1)),
    ).rejects.toMatchObject({ code: 'dek_unwrap_failed' });
  });

  it('refuses a kek id belonging to a different Vault key', async () => {
    const provider = vaultProvider(fakeVault());
    await expect(
      provider.unwrapDek(Buffer.from('vault:v1:x'), 'transit/other-key/v1', tenantKeyContext(TENANT, 1)),
    ).rejects.toThrow(/configured for "transit\/helm-tenant-kek\/\*"/);
  });

  it('refuses a wrapped blob that is not a transit ciphertext', async () => {
    const provider = vaultProvider(fakeVault());
    await expect(
      provider.unwrapDek(randomBytes(61), 'transit/helm-tenant-kek/v1', tenantKeyContext(TENANT, 1)),
    ).rejects.toThrow(/not a Vault transit ciphertext/);
  });

  it('re-authenticates once when Vault rejects the token mid-flight', async () => {
    const vault = fakeVault();
    const tokens = new AppRoleVaultToken({
      addr: 'https://vault.internal:8200',
      roleId: 'role',
      secretId: 'secret',
      http: vault.http,
    });
    const provider = vaultProvider(vault, { tokens });

    await provider.generateDek(tenantKeyContext(TENANT, 1));
    const logins = () => vault.calls.filter((c) => c.url.includes('/auth/')).length;
    expect(logins()).toBe(1);

    vault.failOnce(403);
    await expect(provider.generateDek(tenantKeyContext(TENANT, 2))).resolves.toBeDefined();
    expect(logins()).toBe(2);
  });

  it('gives up after one re-authentication rather than looping', async () => {
    const vault = fakeVault();
    const provider = vaultProvider(vault);
    vault.setStatus(403);

    await expect(provider.generateDek(tenantKeyContext(TENANT, 1))).rejects.toThrow(/403/);
  });

  it('passes a bounded Vault error message through, without the request body', async () => {
    const vault = fakeVault();
    const provider = vaultProvider(vault);
    vault.setStatus(403);

    await expect(provider.generateDek(tenantKeyContext(TENANT, 1))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('surfaces a network failure as kek_unavailable', async () => {
    const provider = vaultProvider(fakeVault(), {
      http: (() => Promise.reject(new Error('ECONNREFUSED'))) as HttpClientLike,
    });
    await expect(provider.generateDek(tenantKeyContext(TENANT, 1))).rejects.toMatchObject({
      code: 'kek_unavailable',
    });
  });
});

describe('Vault configuration', () => {
  it('refuses plain http to a remote Vault', () => {
    expect(() =>
      VaultTransitKekProvider.fromEnv({ VAULT_ADDR: 'http://vault.internal:8200', VAULT_TOKEN: 't' }),
    ).toThrow(/in the clear/);
  });

  it('permits plain http to loopback, which is how a dev Vault runs', () => {
    expect(() =>
      VaultTransitKekProvider.fromEnv({ VAULT_ADDR: 'http://127.0.0.1:8200', VAULT_TOKEN: 't' }),
    ).not.toThrow();
  });

  it('requires VAULT_ADDR', () => {
    expect(() => VaultTransitKekProvider.fromEnv({ VAULT_TOKEN: 't' })).toThrow(/VAULT_ADDR/);
  });

  it('prefers AppRole when both it and a static token are configured', () => {
    const source = vaultTokenSourceFromEnv({
      VAULT_ADDR: 'https://vault.internal:8200',
      VAULT_ROLE_ID: 'r',
      VAULT_SECRET_ID: 's',
      VAULT_TOKEN: 't',
    });
    expect(source).toBeInstanceOf(AppRoleVaultToken);
  });

  it('refuses to run with no Vault authentication at all', () => {
    expect(() => vaultTokenSourceFromEnv({ VAULT_ADDR: 'https://vault.internal:8200' })).toThrow(
      /VAULT_ROLE_ID/,
    );
  });
});

describe('AppRole token source', () => {
  let vault: ReturnType<typeof fakeVault>;

  beforeEach(() => {
    vault = fakeVault();
  });

  const source = () =>
    new AppRoleVaultToken({
      addr: 'https://vault.internal:8200',
      roleId: 'role',
      secretId: 'secret',
      http: vault.http,
    });

  it('caches the token across calls', async () => {
    const tokens = source();
    await tokens.token();
    await tokens.token();
    expect(vault.calls).toHaveLength(1);
  });

  it('shares one login between concurrent callers', async () => {
    // A burst arriving as the lease expires must not become one login per
    // request: that is a login storm in Vault's audit log, and with
    // secret_id_num_uses set it burns the SecretID.
    const tokens = source();
    await Promise.all(Array.from({ length: 20 }, () => tokens.token()));
    expect(vault.calls).toHaveLength(1);
  });

  it('re-authenticates after invalidation', async () => {
    const tokens = source();
    const first = await tokens.token();
    tokens.invalidate();
    const second = await tokens.token();

    expect(second).not.toBe(first);
    expect(vault.calls).toHaveLength(2);
  });

  it('re-authenticates before the lease expires', async () => {
    vi.useFakeTimers();
    try {
      const tokens = source();
      await tokens.token();
      // lease_duration is 3600 with a 60s skew, so 3540s is the cliff.
      vi.setSystemTime(Date.now() + 3541_000);
      await tokens.token();
      expect(vault.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not put the secret id in an error message', async () => {
    vault.setStatus(400);
    const tokens = source();
    await expect(tokens.token()).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret') as unknown as string }),
    );
  });

  it('refuses an incomplete AppRole configuration', () => {
    expect(
      () => new AppRoleVaultToken({ addr: 'https://v', roleId: 'r', secretId: '', http: vault.http }),
    ).toThrow(/role id and a secret id/);
  });
});
