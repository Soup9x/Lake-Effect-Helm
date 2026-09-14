/**
 * Composition root.
 *
 * One place where environment configuration becomes wired objects. Routes
 * import from here and never construct a KEK provider, a cache or a validator
 * themselves — otherwise "which KEK is this route using" becomes a question you
 * have to answer by reading every route.
 *
 * Everything is lazy and memoised per process. A Next.js server reuses the
 * module across requests, so the DEK cache and compiled schema cache survive and
 * actually earn their keep; a serverless deployment gets a cold instance per
 * container, which is correct but means a lower cache hit rate.
 */
import { BlindIndex } from './crypto/blind-index';
import { DekCache } from './crypto/dek-cache';
import { HelmCryptoError } from './crypto/errors';
import { AwsKmsKekProvider, LocalDevKekProvider, type KekProvider } from './crypto/kek';
import { FlexibleAssetValidator } from './flexible/validator';
import { LinkEngine } from './graph/links';
import { TenantKeyService } from './secrets/keys';
import { SecretService } from './secrets/service';

let kekProvider: KekProvider | null = null;
let dekCache: DekCache | null = null;
let blindIndex: BlindIndex | null | undefined;
let secretService: SecretService | null = null;
let keyService: TenantKeyService | null = null;
let linkEngine: LinkEngine | null = null;
let validator: FlexibleAssetValidator | null = null;

/**
 * Build the KEK provider from HELM_KEK_PROVIDER.
 *
 * `local-dev` is refused in production rather than warned about. It keeps the
 * master key in an environment variable — visible in crash dumps, container
 * specs and CI logs — and a warning in a log nobody reads is not a control.
 */
export function getKekProvider(): KekProvider {
  if (kekProvider) return kekProvider;

  const provider = process.env.HELM_KEK_PROVIDER ?? 'local-dev';

  if (provider === 'local-dev') {
    if (process.env.NODE_ENV === 'production') {
      throw new HelmCryptoError(
        'kek_unavailable',
        'HELM_KEK_PROVIDER=local-dev keeps the master key in an environment ' +
          'variable and must not be used in production; configure a KMS provider',
      );
    }
    kekProvider = LocalDevKekProvider.fromEnv();
    return kekProvider;
  }

  if (provider === 'aws-kms') {
    // The SDK is not a dependency of this package — see crypto/kek.ts. Wiring it
    // is a deployment decision, made here rather than scattered through routes.
    throw new HelmCryptoError(
      'kek_unavailable',
      'the AWS KMS provider needs @aws-sdk/client-kms wired in at the composition ' +
        'root: new AwsKmsKekProvider(new KMSClient({}), { GenerateDataKeyCommand, ' +
        'DecryptCommand }, process.env.HELM_KEK_ID!)',
    );
  }

  throw new HelmCryptoError('kek_unavailable', `unknown HELM_KEK_PROVIDER: ${provider}`);
}

/** Override the provider. For tests and for deployments that wire a KMS SDK. */
export function setKekProvider(provider: KekProvider): void {
  kekProvider = provider;
  // The cache holds keys unwrapped by the previous provider; they are no longer
  // meaningful and must not be served.
  dekCache?.clear();
  dekCache = null;
  secretService = null;
  keyService = null;
}

export function getDekCache(): DekCache {
  dekCache ??= new DekCache(getKekProvider());
  return dekCache;
}

export function getBlindIndex(): BlindIndex | null {
  // `undefined` means "not yet resolved"; `null` is a resolved "not configured".
  if (blindIndex === undefined) blindIndex = BlindIndex.fromEnv();
  return blindIndex;
}

export function getSecretService(): SecretService {
  secretService ??= new SecretService({
    dekCache: getDekCache(),
    blindIndex: getBlindIndex(),
  });
  return secretService;
}

export function getKeyService(): TenantKeyService {
  keyService ??= new TenantKeyService(getKekProvider());
  return keyService;
}

export function getLinkEngine(): LinkEngine {
  linkEngine ??= new LinkEngine();
  return linkEngine;
}

export function getFlexibleAssetValidator(): FlexibleAssetValidator {
  validator ??= new FlexibleAssetValidator();
  return validator;
}

/** Drop every memoised service. Tests only. */
export function resetServices(): void {
  dekCache?.clear();
  kekProvider = null;
  dekCache = null;
  blindIndex = undefined;
  secretService = null;
  keyService = null;
  linkEngine = null;
  validator = null;
}

export { AwsKmsKekProvider };
