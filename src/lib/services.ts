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
import { AwsKmsKekProvider, LocalDevKekProvider, type KekProvider, type WrapProvider } from './crypto/kek';
import { LocalMasterKekProvider } from './crypto/kek-local';
import { VaultTransitKekProvider } from './crypto/kek-vault';
import { DocumentService } from './documents/service';
import { FlexibleAssetValidator } from './flexible/validator';
import { LinkEngine } from './graph/links';
import { TenantKeyService } from './secrets/keys';
import { SecretService } from './secrets/service';

let kekProvider: KekProvider | null = null;
let dekCache: DekCache | null = null;
let blindIndex: BlindIndex | null | undefined;
let secretService: SecretService | null = null;
let documentService: DocumentService | null = null;
let keyService: TenantKeyService | null = null;
let linkEngine: LinkEngine | null = null;
let validator: FlexibleAssetValidator | null = null;

/**
 * Key custody, as configured. Reported at start-up and by /api/health so that
 * "which key is protecting this deployment" is answerable without an SSH session.
 */
export interface KeyCustody {
  readonly provider: WrapProvider;
  /** Where the master key lives, in operator terms. */
  readonly custody: string;
  /** True when a compromise of this host yields the master key. */
  readonly hostHoldsMasterKey: boolean;
  readonly detail: Record<string, unknown>;
}

let keyCustody: KeyCustody | null = null;

/**
 * Build the KEK provider from HELM_KEK_PROVIDER.
 *
 * Helm is deployed on-premises, so the two supported production providers are
 * both on-premises ones:
 *
 *   vault-transit   the master key lives in HashiCorp Vault and never enters
 *                   this process. Preferred: revoking Helm's Vault token stops
 *                   decryption immediately, and every unwrap is in Vault's
 *                   audit log.
 *
 *   local-keyfile   the master key is held by this host, ideally as a mode-0400
 *                   file delivered by systemd LoadCredential=. Simpler, with no
 *                   second service to keep alive, and the honest trade is that
 *                   root on this box can read every secret in the database.
 *
 * `local-dev` remains refused in production. It is not a weaker production
 * option, it is a laptop convenience: a single unversioned key in an
 * environment variable, which makes rotating the master key a data-loss event
 * because nothing records which key wrapped which row. `local-keyfile` accepts
 * an environment variable too (HELM_KEK_B64) — the difference is that it
 * carries a version label, so the rotation path exists.
 *
 * The cloud providers stay in the tree because the `wrap_provider` column and
 * the KEK interface are provider-agnostic by design, and an MSP that later
 * moves Helm into a cloud tenancy should not have to re-derive this layer.
 */
export function getKekProvider(): KekProvider {
  if (kekProvider) return kekProvider;

  const configured = process.env.HELM_KEK_PROVIDER?.trim();
  const isProduction = process.env.NODE_ENV === 'production';

  if (!configured) {
    if (isProduction) {
      throw new HelmCryptoError(
        'kek_unavailable',
        'HELM_KEK_PROVIDER is not set; choose vault-transit or local-keyfile ' +
          '(see docs/architecture/03-crypto-operations.md)',
      );
    }
    kekProvider = LocalDevKekProvider.fromEnv();
    keyCustody = {
      provider: 'local-dev',
      custody: 'development key in HELM_LOCAL_KEK_B64',
      hostHoldsMasterKey: true,
      detail: {},
    };
    return kekProvider;
  }

  switch (configured) {
    case 'vault-transit': {
      const provider = VaultTransitKekProvider.fromEnv();
      kekProvider = provider;
      keyCustody = {
        provider: 'vault-transit',
        custody: `HashiCorp Vault transit engine at ${process.env.VAULT_ADDR}`,
        hostHoldsMasterKey: false,
        detail: {
          mount: process.env.HELM_VAULT_TRANSIT_MOUNT ?? 'transit',
          key: process.env.HELM_VAULT_TRANSIT_KEY ?? 'helm-tenant-kek',
          auth: process.env.VAULT_ROLE_ID ? 'approle' : 'static-token',
        },
      };
      return kekProvider;
    }

    case 'local-keyfile': {
      const provider = LocalMasterKekProvider.fromEnv();
      const described = provider.describe();

      // Not a refusal — an environment-held master key is a deployment the
      // operator may have no way around, and refusing it would push them back
      // to local-dev, which is worse. But it is said once, at start-up, where
      // an operator reading logs after a deploy will see it.
      if (isProduction && described.source === 'environment') {
        console.warn(
          '[helm] master key loaded from HELM_KEK_B64. An environment variable is ' +
            'readable from crash dumps, container inspection and /proc; prefer ' +
            'HELM_KEK_FILE with mode 0400 (systemd LoadCredential=).',
        );
      }

      kekProvider = provider;
      keyCustody = {
        provider: 'local-keyfile',
        custody:
          described.source === 'file'
            ? 'master key file on this host'
            : 'master key in this process environment',
        hostHoldsMasterKey: true,
        detail: { current: described.current, versions: described.versions },
      };
      return kekProvider;
    }

    case 'local-dev': {
      if (isProduction) {
        throw new HelmCryptoError(
          'kek_unavailable',
          'HELM_KEK_PROVIDER=local-dev is a development-only key with no version ' +
            'label, so the master key could never be rotated without stranding every ' +
            'tenant DEK; use local-keyfile for an on-premises master key, or ' +
            'vault-transit to keep it out of this process entirely',
        );
      }
      kekProvider = LocalDevKekProvider.fromEnv();
      keyCustody = {
        provider: 'local-dev',
        custody: 'development key in HELM_LOCAL_KEK_B64',
        hostHoldsMasterKey: true,
        detail: {},
      };
      return kekProvider;
    }

    case 'aws-kms':
      // The SDK is not a dependency of this package — see crypto/kek.ts. Wiring
      // it is a deployment decision, made here rather than scattered through routes.
      throw new HelmCryptoError(
        'kek_unavailable',
        'the AWS KMS provider needs @aws-sdk/client-kms wired in at the composition ' +
          'root: setKekProvider(new AwsKmsKekProvider(new KMSClient({}), ' +
          '{ GenerateDataKeyCommand, DecryptCommand }, process.env.HELM_KEK_ID!))',
      );

    case 'gcp-kms':
    case 'azure-keyvault':
      throw new HelmCryptoError(
        'kek_unavailable',
        `HELM_KEK_PROVIDER=${configured} is a recognised wrap provider but has no ` +
          'implementation in this tree; implement KekProvider and install it with ' +
          'setKekProvider() at start-up',
      );

    default:
      throw new HelmCryptoError(
        'kek_unavailable',
        `unknown HELM_KEK_PROVIDER: ${configured} (expected vault-transit, local-keyfile or local-dev)`,
      );
  }
}

/**
 * What is protecting the tenant DEKs right now.
 *
 * Resolves the provider as a side effect, which is deliberate: calling this at
 * start-up turns a misconfigured key into a boot failure instead of a 500 on
 * the first secret read of the day.
 */
export function describeKeyCustody(): KeyCustody {
  getKekProvider();
  if (!keyCustody) throw new HelmCryptoError('kek_unavailable', 'key custody was not recorded');
  return keyCustody;
}

/** Override the provider. For tests and for deployments that wire a KMS SDK. */
export function setKekProvider(provider: KekProvider, custody?: KeyCustody): void {
  kekProvider = provider;
  keyCustody = custody ?? {
    provider: provider.provider,
    custody: 'installed programmatically at the composition root',
    hostHoldsMasterKey: provider.provider === 'local-dev' || provider.provider === 'local-keyfile',
    detail: {},
  };
  // The cache holds keys unwrapped by the previous provider; they are no longer
  // meaningful and must not be served.
  dekCache?.clear();
  dekCache = null;
  secretService = null;
  documentService = null;
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

/**
 * Client documents. Shares the DEK cache with secrets deliberately: a document
 * and a credential belonging to the same client are sealed under the same
 * per-tenant key, so a KEK rotation moves both and there is one answer to
 * "which key is protecting this client's material".
 */
export function getDocumentService(): DocumentService {
  documentService ??= new DocumentService({ dekCache: getDekCache() });
  return documentService;
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
  keyCustody = null;
  dekCache = null;
  blindIndex = undefined;
  secretService = null;
  documentService = null;
  keyService = null;
  linkEngine = null;
  validator = null;
}

export { AwsKmsKekProvider, LocalMasterKekProvider, VaultTransitKekProvider };
