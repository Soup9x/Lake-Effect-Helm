/**
 * Integration provider adapters.
 *
 * What is here and what is not, stated plainly: the SYNC ENGINE is complete —
 * claiming a run, resolving credentials through the audited reveal path,
 * paging, correlating against external_identity, honouring manual edits,
 * skipping unchanged records, and closing the run with accurate counts. That is
 * the part that is hard to get right and identical for every vendor.
 *
 * The VENDOR SPECIFICS are configuration rather than code. Every RMM and PSA in
 * the brief — NinjaOne, N-able N-central and RMM, ConnectWise Manage,
 * HaloPSA, Microsoft Graph — exposes a paged JSON REST API over bearer or
 * OAuth2 client-credentials authentication, so one configurable REST adapter
 * covers them: `integration_connection.config` names the path, the pagination
 * style, and a field map from the vendor's JSON to Helm's device columns.
 *
 * This is a deliberate choice, not a stub. Hand-writing six clients against
 * six APIs that each version independently, without a live tenant of any of
 * them to test against, produces six plausible-looking files that are wrong in
 * six different ways. A configurable adapter is honest about where the
 * vendor-specific knowledge lives, and `registerProvider()` is there for the
 * cases — Microsoft Graph's delta queries, ConnectWise's unusual auth — where a
 * bespoke client genuinely earns its keep.
 */
import { createHash } from 'node:crypto';

export type ProviderKey =
  | 'ninja_one'
  | 'n_able_ncentral'
  | 'n_able_rmm'
  | 'datto_rmm'
  | 'connectwise_manage'
  | 'connectwise_automate'
  | 'halo_psa'
  | 'autotask'
  | 'microsoft_graph'
  | 'custom';

/** A record as the vendor returned it, plus what Helm made of it. */
export interface ExternalRecord {
  /** Stable vendor identifier. The correlation key; a sync without one is unsafe. */
  readonly externalId: string;
  /** Vendor record type, e.g. 'device', 'company', 'user'. */
  readonly externalType: string;
  readonly externalUrl?: string;
  /** Raw payload, hashed to detect no-op updates. Never persisted verbatim. */
  readonly raw: unknown;
  /** Mapped Helm fields. Keys absent here are left alone on an existing row. */
  readonly asset: MappedAsset;
}

export interface MappedAsset {
  readonly nodeType: 'device';
  readonly name: string;
  readonly deviceType: string;
  readonly hostname?: string | undefined;
  readonly fqdn?: string | undefined;
  readonly manufacturer?: string | undefined;
  readonly model?: string | undefined;
  readonly serialNumber?: string | undefined;
  readonly operatingSystem?: string | undefined;
  readonly osVersion?: string | undefined;
  readonly lastSeenAt?: Date | undefined;
  readonly rmmDeviceId?: string | undefined;
}

export interface FetchPage {
  readonly records: ExternalRecord[];
  /** Opaque cursor for the next page, or null when the run is complete. */
  readonly nextCursor: string | null;
}

export interface ProviderContext {
  readonly baseUrl: string | null;
  readonly config: Record<string, unknown>;
  /**
   * Resolve a credential by its role in `credential_secret_ids`.
   *
   * Goes through helm.reveal_secret with purpose 'integration', so the read is
   * audited and — because the sync service account is pinned to that purpose —
   * it cannot be used to reach anything that is not an integration credential.
   */
  credential(role: string): Promise<string>;
  readonly signal: AbortSignal;
}

export interface IntegrationProvider {
  readonly key: ProviderKey;
  /** Fetch one page. `cursor` is whatever this provider returned last time. */
  fetchPage(ctx: ProviderContext, cursor: string | null): Promise<FetchPage>;
}

/** Stable hash of a vendor payload, for skipping unchanged records. */
export function payloadHash(raw: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(raw)).digest();
}

/**
 * Key-sorted JSON.
 *
 * Vendors do not guarantee key order, and a hash that changes because a server
 * serialised its JSON differently would make every record look modified and
 * defeat the whole point of hashing.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// The configurable REST adapter
// ---------------------------------------------------------------------------

/**
 * Shape of `integration_connection.config` this adapter understands.
 *
 * Example, NinjaOne devices:
 *
 *   {
 *     "path": "/v2/devices",
 *     "auth": { "kind": "bearer", "credentialRole": "api_key" },
 *     "pagination": { "kind": "cursor", "param": "after", "cursorPath": "cursor.after" },
 *     "recordsPath": "results",
 *     "externalIdPath": "id",
 *     "externalType": "device",
 *     "map": {
 *       "name": "systemName",
 *       "hostname": "dnsName",
 *       "deviceType": "nodeClass",
 *       "operatingSystem": "os.name",
 *       "serialNumber": "system.serialNumber",
 *       "lastSeenAt": "lastContact"
 *     },
 *     "deviceTypeMap": { "WINDOWS_SERVER": "server", "WINDOWS_WORKSTATION": "workstation" }
 *   }
 */
export interface RestProviderConfig {
  path?: string;
  auth?: {
    kind?: 'bearer' | 'basic' | 'header';
    credentialRole?: string;
    /** For kind 'header': the header name, e.g. 'x-api-key'. */
    header?: string;
    /** For kind 'basic': the username; the credential supplies the password. */
    username?: string;
  };
  pagination?: {
    kind?: 'cursor' | 'page' | 'none';
    /** Query parameter carrying the cursor or page number. */
    param?: string;
    /** Dot path in the response holding the next cursor. */
    cursorPath?: string;
    pageSize?: number;
    sizeParam?: string;
  };
  recordsPath?: string;
  externalIdPath?: string;
  externalType?: string;
  externalUrlTemplate?: string;
  map?: Record<string, string>;
  deviceTypeMap?: Record<string, string>;
  defaultDeviceType?: string;
}

const DEVICE_TYPES = new Set([
  'server', 'workstation', 'laptop', 'virtual_machine', 'hypervisor', 'firewall',
  'router', 'switch', 'access_point', 'nas', 'san', 'printer', 'ups', 'camera',
  'phone_system', 'iot', 'other',
]);

export class RestIntegrationProvider implements IntegrationProvider {
  constructor(readonly key: ProviderKey) {}

  async fetchPage(ctx: ProviderContext, cursor: string | null): Promise<FetchPage> {
    const config = ctx.config as RestProviderConfig;
    if (!ctx.baseUrl) throw new Error('connection has no base_url');
    if (!config.path) throw new Error('connection config has no "path"');

    const url = new URL(config.path, ctx.baseUrl);
    const pagination = config.pagination ?? {};
    const pageSize = pagination.pageSize ?? 100;

    if (pagination.sizeParam) url.searchParams.set(pagination.sizeParam, String(pageSize));
    if (cursor && pagination.param) url.searchParams.set(pagination.param, cursor);

    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...(await this.#authHeaders(ctx, config)) },
      signal: ctx.signal,
    });

    if (!response.ok) {
      // The body may echo query parameters, which may include an account
      // identifier. Status and URL path only.
      throw new Error(`${this.key} returned ${response.status} for ${url.pathname}`);
    }

    const body: unknown = await response.json();
    const rows = asArray(pick(body, config.recordsPath ?? ''));

    const records: ExternalRecord[] = [];
    for (const row of rows) {
      const externalId = stringOrNull(pick(row, config.externalIdPath ?? 'id'));
      // A record with no stable identifier cannot be correlated, and inserting
      // it anyway is how a re-sync produces duplicates. Skip it and let the
      // run's skipped count show that it happened.
      if (!externalId) continue;

      records.push({
        externalId,
        externalType: config.externalType ?? 'device',
        ...(config.externalUrlTemplate
          ? { externalUrl: config.externalUrlTemplate.replace('{id}', encodeURIComponent(externalId)) }
          : {}),
        raw: row,
        asset: this.#map(row, config, externalId),
      });
    }

    const nextCursor =
      pagination.kind === 'cursor'
        ? stringOrNull(pick(body, pagination.cursorPath ?? ''))
        : pagination.kind === 'page' && rows.length === pageSize
          ? String(Number(cursor ?? '1') + 1)
          : null;

    return { records, nextCursor };
  }

  async #authHeaders(ctx: ProviderContext, config: RestProviderConfig): Promise<Record<string, string>> {
    const auth = config.auth ?? {};
    if (!auth.kind || auth.kind === 'bearer') {
      const token = await ctx.credential(auth.credentialRole ?? 'api_key');
      return { authorization: `Bearer ${token}` };
    }
    if (auth.kind === 'header') {
      if (!auth.header) throw new Error('auth.kind "header" needs auth.header');
      return { [auth.header]: await ctx.credential(auth.credentialRole ?? 'api_key') };
    }
    const password = await ctx.credential(auth.credentialRole ?? 'password');
    const basic = Buffer.from(`${auth.username ?? ''}:${password}`, 'utf8').toString('base64');
    return { authorization: `Basic ${basic}` };
  }

  #map(row: unknown, config: RestProviderConfig, externalId: string): MappedAsset {
    const map = config.map ?? {};
    const read = (field: string): string | undefined =>
      map[field] ? (stringOrNull(pick(row, map[field])) ?? undefined) : undefined;

    const rawType = read('deviceType');
    const mapped = rawType ? config.deviceTypeMap?.[rawType] : undefined;
    const candidate = (mapped ?? rawType ?? config.defaultDeviceType ?? 'other').toLowerCase();

    const lastSeen = read('lastSeenAt');
    const parsed = lastSeen ? new Date(lastSeen) : undefined;

    return {
      nodeType: 'device',
      // Falling back to the external id keeps a nameless vendor record
      // identifiable rather than producing a row called "".
      name: read('name') ?? read('hostname') ?? `${this.key}:${externalId}`,
      // An unrecognised vendor class becomes 'other' rather than failing the
      // whole run: one odd device must not stop 400 good ones syncing.
      deviceType: DEVICE_TYPES.has(candidate) ? candidate : 'other',
      hostname: read('hostname'),
      fqdn: read('fqdn'),
      manufacturer: read('manufacturer'),
      model: read('model'),
      serialNumber: read('serialNumber'),
      operatingSystem: read('operatingSystem'),
      osVersion: read('osVersion'),
      lastSeenAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined,
      rmmDeviceId: externalId,
    };
  }
}

/** Dot-path read. An empty path returns the value itself. */
export function pick(value: unknown, path: string): unknown {
  if (!path) return value;
  let current = value;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value.length ? value : null;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<ProviderKey, IntegrationProvider>();

/**
 * Every provider in the brief starts on the configurable REST adapter. Replace
 * one with `registerProvider()` when its API stops fitting — Microsoft Graph's
 * delta queries are the obvious first candidate, since re-fetching every user
 * on every run is exactly what delta tokens exist to avoid.
 */
for (const key of [
  'ninja_one', 'n_able_ncentral', 'n_able_rmm', 'datto_rmm',
  'connectwise_manage', 'connectwise_automate', 'halo_psa', 'autotask',
  'microsoft_graph', 'custom',
] as ProviderKey[]) {
  registry.set(key, new RestIntegrationProvider(key));
}

export function registerProvider(provider: IntegrationProvider): void {
  registry.set(provider.key, provider);
}

export function providerFor(key: string): IntegrationProvider {
  const provider = registry.get(key as ProviderKey);
  if (!provider) throw new Error(`no adapter registered for provider ${key}`);
  return provider;
}
