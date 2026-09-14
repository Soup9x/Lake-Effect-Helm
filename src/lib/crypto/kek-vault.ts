/**
 * HashiCorp Vault transit-engine KEK provider.
 *
 * This is the on-premises equivalent of a cloud KMS, and the reason to prefer
 * it over a master key file: the key material stays inside Vault, Helm only
 * ever holds wrapped DEKs and short-lived unwrapped ones, every wrap and unwrap
 * is a Vault audit-device entry, and revoking Helm's Vault token immediately
 * stops the application from opening anything — none of which is true when the
 * master key sits in the process.
 *
 * Expected Vault configuration:
 *
 *   vault secrets enable transit
 *   vault write -f transit/keys/helm-tenant-kek type=aes256-gcm96 derived=true
 *
 * `derived=true` is not optional and the provider refuses to run without it
 * (see #assertDerived). With derivation on, Vault mixes the per-call `context`
 * into a key derived from the master key, so a DEK wrapped for tenant A cannot
 * be unwrapped as tenant B even by a caller holding full transit privileges —
 * Vault's own AEAD tag fails. That is the same property KMS encryption context
 * gives us, enforced by the service rather than by application code somebody
 * might later "simplify". Without derivation, `context` is ignored entirely and
 * the binding silently disappears.
 *
 * Policy Helm needs, and nothing more:
 *
 *   path "transit/datakey/plaintext/helm-tenant-kek" { capabilities = ["update"] }
 *   path "transit/decrypt/helm-tenant-kek"           { capabilities = ["update"] }
 *   path "transit/keys/helm-tenant-kek"              { capabilities = ["read"] }
 *
 * Note there is no `encrypt` and no `keys/*` write: Helm cannot rewrap another
 * tenant's DEK of its own accord and cannot rotate or delete the KEK.
 *
 * One honest limitation: Vault returns the fresh DEK as base64 inside a JSON
 * response, so the plaintext passes through JavaScript strings that cannot be
 * wiped. The Buffer we hand back is wiped by the caller; the string copies are
 * at the mercy of the garbage collector. This is inherent to any HTTP KMS —
 * AWS KMS has the same property once the SDK has parsed the response — and is
 * the reason the DEK cache TTL is short.
 */
import { HelmCryptoError } from './errors';
import type { EnvLike } from './kek-local';
import {
  DEK_BYTES,
  serialiseContext,
  type EncryptionContext,
  type GeneratedDek,
  type RewrappedDek,
  type RewrappingKekProvider,
} from './kek';

/**
 * The slice of `fetch` this provider uses.
 *
 * Structural rather than an SDK import, for the same reasons as the KMS
 * provider: no vendor dependency in a package that is mostly schema, and the
 * provider is testable against a fake instead of a live Vault.
 */
export interface HttpResponseLike {
  readonly status: number;
  text(): Promise<string>;
}

export type HttpClientLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<HttpResponseLike>;

/**
 * Supplies the Vault token, and can be told the current one stopped working.
 *
 * Split out because a long-running Helm process outlives any sensible token
 * TTL: the interesting implementation is AppRole, which re-authenticates, and
 * a static token is the degenerate case.
 */
export interface VaultTokenSource {
  token(): Promise<string>;
  /** Called after Vault rejects the token, so the next call re-authenticates. */
  invalidate(): void;
}

/** A token handed to the process directly. Fine for a short-lived job; poor for a server. */
export class StaticVaultToken implements VaultTokenSource {
  constructor(private readonly value: string) {
    if (!value) throw new HelmCryptoError('kek_unavailable', 'VAULT_TOKEN is empty');
  }
  async token(): Promise<string> {
    return this.value;
  }
  invalidate(): void {
    // Nothing to renew. The next call will fail the same way, loudly, which is
    // the correct outcome: a static token that expired needs an operator.
  }
}

export interface AppRoleOptions {
  readonly addr: string;
  readonly roleId: string;
  readonly secretId: string;
  readonly mount?: string;
  readonly namespace?: string;
  readonly http?: HttpClientLike;
  readonly timeoutMs?: number;
  /** Re-login this many seconds before the lease actually expires. */
  readonly renewSkewSeconds?: number;
}

interface LoginResponse {
  auth?: { client_token?: string; lease_duration?: number };
}

/**
 * AppRole authentication with automatic re-login.
 *
 * Concurrent callers share one in-flight login. Without that, a burst of
 * requests arriving as the token expires produces one Vault login per request,
 * which shows up as a login storm in the Vault audit log and, with
 * `secret_id_num_uses` set, burns the SecretID.
 */
export class AppRoleVaultToken implements VaultTokenSource {
  readonly #options: Required<Omit<AppRoleOptions, 'namespace'>> & { namespace?: string };
  #cached: { token: string; expiresAt: number } | null = null;
  #inFlight: Promise<string> | null = null;

  constructor(options: AppRoleOptions) {
    if (!options.roleId || !options.secretId) {
      throw new HelmCryptoError('kek_unavailable', 'AppRole login needs both a role id and a secret id');
    }
    this.#options = {
      addr: options.addr.replace(/\/+$/, ''),
      roleId: options.roleId,
      secretId: options.secretId,
      mount: options.mount ?? 'approle',
      http: options.http ?? defaultHttp(),
      timeoutMs: options.timeoutMs ?? 5000,
      renewSkewSeconds: options.renewSkewSeconds ?? 60,
      ...(options.namespace ? { namespace: options.namespace } : {}),
    };
  }

  async token(): Promise<string> {
    const cached = this.#cached;
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    this.#inFlight ??= this.#login().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  invalidate(): void {
    this.#cached = null;
  }

  async #login(): Promise<string> {
    const { addr, mount, roleId, secretId, http, timeoutMs, namespace, renewSkewSeconds } = this.#options;
    const url = `${addr}/v1/auth/${encodeURIComponent(mount)}/login`;

    const body = await vaultCall<LoginResponse>(http, {
      url,
      // A login failure must not echo the request: the body contains the SecretID.
      operation: 'AppRole login',
      token: null,
      namespace,
      timeoutMs,
      payload: { role_id: roleId, secret_id: secretId },
    });

    const token = body.auth?.client_token;
    if (!token) {
      throw new HelmCryptoError('kek_unavailable', 'Vault AppRole login returned no client token');
    }

    // A root or never-expiring token reports lease_duration 0. Re-check it
    // every 10 minutes anyway rather than caching forever, so a revoked token
    // is noticed on a schedule instead of at the worst possible moment.
    const lease = body.auth?.lease_duration ?? 0;
    const ttlSeconds = lease > 0 ? Math.max(lease - renewSkewSeconds, 5) : 600;
    this.#cached = { token, expiresAt: Date.now() + ttlSeconds * 1000 };
    return token;
  }
}

export interface VaultTransitOptions {
  readonly addr: string;
  /** Transit mount path, without leading or trailing slashes. */
  readonly mount?: string;
  /** Transit key name. */
  readonly keyName: string;
  readonly tokens: VaultTokenSource;
  readonly namespace?: string;
  readonly http?: HttpClientLike;
  readonly timeoutMs?: number;
}

interface DataKeyResponse {
  data?: { plaintext?: string; ciphertext?: string; key_version?: number };
}

interface DecryptResponse {
  data?: { plaintext?: string };
}

interface KeyConfigResponse {
  data?: { derived?: boolean; type?: string; latest_version?: number; supports_decryption?: boolean };
}

export class VaultTransitKekProvider implements RewrappingKekProvider {
  readonly provider = 'vault-transit' as const;
  readonly #addr: string;
  readonly #mount: string;
  readonly #keyName: string;
  readonly #tokens: VaultTokenSource;
  readonly #http: HttpClientLike;
  readonly #timeoutMs: number;
  readonly #namespace: string | undefined;
  #derivedChecked = false;

  constructor(options: VaultTransitOptions) {
    if (!options.addr) throw new HelmCryptoError('kek_unavailable', 'VAULT_ADDR is not set');
    if (!options.keyName) throw new HelmCryptoError('kek_unavailable', 'HELM_VAULT_TRANSIT_KEY is not set');

    this.#addr = options.addr.replace(/\/+$/, '');
    this.#mount = (options.mount ?? 'transit').replace(/^\/+|\/+$/g, '');
    this.#keyName = options.keyName;
    this.#tokens = options.tokens;
    this.#http = options.http ?? defaultHttp();
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#namespace = options.namespace;
  }

  static fromEnv(env: EnvLike = process.env, http?: HttpClientLike): VaultTransitKekProvider {
    const addr = env.VAULT_ADDR?.trim();
    if (!addr) {
      throw new HelmCryptoError(
        'kek_unavailable',
        'HELM_KEK_PROVIDER=vault-transit requires VAULT_ADDR (for example https://vault.internal:8200)',
      );
    }
    if (addr.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(addr)) {
      throw new HelmCryptoError(
        'kek_unavailable',
        'VAULT_ADDR uses plain http to a non-loopback address; the Vault token and every ' +
          'unwrapped DEK would cross the network in the clear',
      );
    }

    const namespace = env.VAULT_NAMESPACE?.trim();
    const timeoutMs = Number(env.HELM_VAULT_TIMEOUT_MS ?? 5000);

    return new VaultTransitKekProvider({
      addr,
      keyName: env.HELM_VAULT_TRANSIT_KEY?.trim() || 'helm-tenant-kek',
      mount: env.HELM_VAULT_TRANSIT_MOUNT?.trim() || 'transit',
      tokens: vaultTokenSourceFromEnv(env, http),
      ...(namespace ? { namespace } : {}),
      ...(http ? { http } : {}),
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
    });
  }

  async generateDek(context: EncryptionContext): Promise<GeneratedDek> {
    await this.#assertDerived();

    const body = await this.#call<DataKeyResponse>(
      `datakey/plaintext/${encodeURIComponent(this.#keyName)}`,
      'Vault transit datakey',
      { context: this.#context(context), bits: DEK_BYTES * 8 },
    );

    const plaintextB64 = body.data?.plaintext;
    const ciphertext = body.data?.ciphertext;
    if (!plaintextB64 || !ciphertext) {
      throw new HelmCryptoError('kek_unavailable', 'Vault returned an incomplete data key');
    }

    const plaintext = Buffer.from(plaintextB64, 'base64');
    if (plaintext.length !== DEK_BYTES) {
      throw new HelmCryptoError(
        'kek_unavailable',
        `Vault returned a ${plaintext.length}-byte data key; expected ${DEK_BYTES}`,
      );
    }

    return {
      plaintext,
      // The transit ciphertext is the ASCII string "vault:v<n>:<base64>". It goes
      // into the bytea column verbatim; Vault is the only thing that parses it.
      wrapped: Buffer.from(ciphertext, 'utf8'),
      kekId: this.#kekId(body.data?.key_version ?? versionFromCiphertext(ciphertext)),
    };
  }

  async unwrapDek(wrapped: Buffer, kekId: string, context: EncryptionContext): Promise<Buffer> {
    const prefix = `${this.#mount}/${this.#keyName}/`;
    if (!kekId.startsWith(prefix)) {
      throw new HelmCryptoError(
        'dek_unwrap_failed',
        `this DEK was wrapped by Vault key "${kekId}"; this server is configured for "${prefix}*"`,
      );
    }

    const ciphertext = wrapped.toString('utf8');
    if (!ciphertext.startsWith('vault:')) {
      throw new HelmCryptoError('invalid_envelope', 'wrapped DEK is not a Vault transit ciphertext');
    }

    const body = await this.#call<DecryptResponse>(
      `decrypt/${encodeURIComponent(this.#keyName)}`,
      'Vault transit decrypt',
      { ciphertext, context: this.#context(context) },
      // A decrypt failure is the expected outcome of a swapped ciphertext or a
      // mismatched context, so it is mapped to the same error the local
      // providers raise rather than to "Vault is unavailable".
      'dek_unwrap_failed',
    );

    const plaintextB64 = body.data?.plaintext;
    if (!plaintextB64) {
      throw new HelmCryptoError('dek_unwrap_failed', 'Vault returned no plaintext');
    }
    const plaintext = Buffer.from(plaintextB64, 'base64');
    if (plaintext.length !== DEK_BYTES) {
      throw new HelmCryptoError('dek_unwrap_failed', 'Vault returned a data key of the wrong length');
    }
    return plaintext;
  }

  /**
   * Move a DEK onto the transit key's latest version.
   *
   * `transit/rewrap` decrypts and re-encrypts inside Vault: the plaintext DEK
   * never enters this process, so rotating the master key does not briefly
   * expose every tenant key to the application host. It is the single best
   * argument for vault-transit over a local key file.
   *
   * Needs one more policy line than the rest of this provider:
   *
   *   path "transit/rewrap/helm-tenant-kek" { capabilities = ["update"] }
   *
   * Grant it to the rotation job's role, not to the web tier.
   */
  async rewrapDek(
    wrapped: Buffer,
    kekId: string,
    context: EncryptionContext,
  ): Promise<RewrappedDek> {
    const prefix = `${this.#mount}/${this.#keyName}/`;
    if (!kekId.startsWith(prefix)) {
      throw new HelmCryptoError(
        'dek_unwrap_failed',
        `this DEK was wrapped by Vault key "${kekId}"; this server is configured for "${prefix}*"`,
      );
    }

    const body = await this.#call<DataKeyResponse>(
      `rewrap/${encodeURIComponent(this.#keyName)}`,
      'Vault transit rewrap',
      { ciphertext: wrapped.toString('utf8'), context: this.#context(context) },
    );

    const ciphertext = body.data?.ciphertext;
    if (!ciphertext) {
      throw new HelmCryptoError('kek_unavailable', 'Vault rewrap returned no ciphertext');
    }

    return {
      wrapped: Buffer.from(ciphertext, 'utf8'),
      kekId: this.#kekId(body.data?.key_version ?? versionFromCiphertext(ciphertext)),
    };
  }

  /** For the start-up summary. Cheap: it is the same read used to check derivation. */
  async describe(): Promise<{ provider: string; mount: string; key: string; latestVersion: number }> {
    const config = await this.#readKeyConfig();
    return {
      provider: this.provider,
      mount: this.#mount,
      key: this.#keyName,
      latestVersion: config.data?.latest_version ?? 0,
    };
  }

  /**
   * Refuse to run against a non-derived transit key.
   *
   * Vault accepts and ignores `context` on a key created without
   * `derived=true`. Every wrap would succeed, every unwrap would succeed, and
   * the tenant binding the rest of Helm relies on would not exist — a failure
   * that is invisible until someone tests whether tenant A's wrapped DEK opens
   * as tenant B's. Checked once per process, on first use.
   */
  async #assertDerived(): Promise<void> {
    if (this.#derivedChecked) return;
    const config = await this.#readKeyConfig();

    if (config.data?.derived !== true) {
      throw new HelmCryptoError(
        'kek_unavailable',
        `Vault transit key ${this.#mount}/${this.#keyName} was not created with derived=true, ` +
          'so the per-tenant encryption context would be silently ignored; recreate it as ' +
          `\`vault write -f ${this.#mount}/keys/${this.#keyName} type=aes256-gcm96 derived=true\``,
      );
    }
    this.#derivedChecked = true;
  }

  async #readKeyConfig(): Promise<KeyConfigResponse> {
    return this.#call<KeyConfigResponse>(
      `keys/${encodeURIComponent(this.#keyName)}`,
      'Vault transit key read',
      undefined,
    );
  }

  #kekId(version: number): string {
    return `${this.#mount}/${this.#keyName}/v${version}`;
  }

  #context(context: EncryptionContext): string {
    return serialiseContext(context).toString('base64');
  }

  /**
   * One Vault call, with a single retry when the token is rejected.
   *
   * A 403 mid-flight is routine rather than exceptional: it is what an expired
   * AppRole lease looks like. Retrying once after invalidating the cached token
   * turns a user-visible failure into a re-login. Anything else is surfaced.
   */
  async #call<T>(
    path: string,
    operation: string,
    payload: Record<string, unknown> | undefined,
    failureCode: 'kek_unavailable' | 'dek_unwrap_failed' = 'kek_unavailable',
  ): Promise<T> {
    const url = `${this.#addr}/v1/${this.#mount}/${path}`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.#tokens.token();
      try {
        return await vaultCall<T>(this.#http, {
          url,
          operation,
          token,
          namespace: this.#namespace,
          timeoutMs: this.#timeoutMs,
          payload,
          failureCode,
        });
      } catch (error) {
        const retriable =
          attempt === 0 && error instanceof VaultHttpError && (error.status === 401 || error.status === 403);
        if (!retriable) throw error;
        this.#tokens.invalidate();
      }
    }

    // Unreachable: the loop either returns or throws.
    throw new HelmCryptoError(failureCode, `${operation} failed`);
  }
}

/**
 * Carries the HTTP status so the caller can distinguish "token expired" from
 * "this ciphertext does not authenticate". Never escapes this module: every
 * public entry point converts it to a HelmCryptoError.
 */
class VaultHttpError extends HelmCryptoError {
  readonly status: number;
  constructor(
    status: number,
    code: 'kek_unavailable' | 'dek_unwrap_failed',
    message: string,
  ) {
    super(code, message);
    this.name = 'VaultHttpError';
    this.status = status;
  }
}

interface VaultCallOptions {
  url: string;
  operation: string;
  token: string | null;
  namespace: string | undefined;
  timeoutMs: number;
  payload: Record<string, unknown> | undefined;
  failureCode?: 'kek_unavailable' | 'dek_unwrap_failed';
}

async function vaultCall<T>(http: HttpClientLike, options: VaultCallOptions): Promise<T> {
  const failureCode = options.failureCode ?? 'kek_unavailable';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers['x-vault-token'] = options.token;
  if (options.namespace) headers['x-vault-namespace'] = options.namespace;
  if (options.payload) headers['content-type'] = 'application/json';

  let response: HttpResponseLike;
  try {
    response = await http(options.url, {
      method: options.payload ? 'POST' : 'GET',
      headers,
      ...(options.payload ? { body: JSON.stringify(options.payload) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (cause) {
    // Network-level failure. The message deliberately does not include the
    // request body, which for a login holds the SecretID.
    throw new HelmCryptoError(failureCode, `${options.operation} could not reach Vault`, { cause });
  }

  const raw = await response.text();

  if (response.status < 200 || response.status >= 300) {
    throw new VaultHttpError(
      response.status,
      failureCode,
      `${options.operation} failed: Vault returned ${response.status} ${summariseVaultError(raw)}`.trim(),
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new HelmCryptoError(failureCode, `${options.operation} returned a non-JSON response`, { cause });
  }
}

/**
 * Vault error bodies are `{"errors":["..."]}`. Pass along a short, bounded
 * summary — enough to tell "permission denied" from "unsupported path" — and
 * nothing that could carry key material.
 */
function summariseVaultError(raw: string): string {
  try {
    const body = JSON.parse(raw) as { errors?: unknown };
    if (Array.isArray(body.errors) && body.errors.length) {
      return `(${body.errors.filter((e) => typeof e === 'string').join('; ').slice(0, 200)})`;
    }
  } catch {
    // Not JSON — a proxy error page, most likely. Say nothing rather than
    // splicing an arbitrary HTML document into a log line.
  }
  return '';
}

function versionFromCiphertext(ciphertext: string): number {
  const match = /^vault:v(\d+):/.exec(ciphertext);
  if (!match) {
    throw new HelmCryptoError(
      'kek_unavailable',
      'Vault transit ciphertext did not carry a key version prefix',
    );
  }
  return Number(match[1]);
}

/** AppRole when both parts are present, otherwise a token from VAULT_TOKEN. */
export function vaultTokenSourceFromEnv(
  env: EnvLike = process.env,
  http?: HttpClientLike,
): VaultTokenSource {
  const roleId = env.VAULT_ROLE_ID?.trim();
  const secretId = env.VAULT_SECRET_ID?.trim();
  const namespace = env.VAULT_NAMESPACE?.trim();

  if (roleId && secretId) {
    return new AppRoleVaultToken({
      addr: env.VAULT_ADDR!.trim(),
      roleId,
      secretId,
      mount: env.VAULT_APPROLE_MOUNT?.trim() || 'approle',
      ...(namespace ? { namespace } : {}),
      ...(http ? { http } : {}),
    });
  }

  const token = env.VAULT_TOKEN?.trim();
  if (token) return new StaticVaultToken(token);

  throw new HelmCryptoError(
    'kek_unavailable',
    'Vault authentication is not configured: set VAULT_ROLE_ID and VAULT_SECRET_ID for ' +
      'AppRole (recommended for a long-running server), or VAULT_TOKEN for a static token',
  );
}

function defaultHttp(): HttpClientLike {
  const f = globalThis.fetch;
  if (typeof f !== 'function') {
    throw new HelmCryptoError('kek_unavailable', 'no global fetch available for Vault calls');
  }
  return (url, init) => f(url, init as RequestInit);
}
