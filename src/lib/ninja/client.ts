/**
 * A client for the NinjaOne public API (v2).
 *
 * AUTHENTICATION is an OAuth 2.0 client-credentials app, created in NinjaOne
 * under Administration → Apps → API with the "Client Credentials" grant and
 * the Monitoring scope. Helm asks for a token with the client id and secret,
 * and sends the token as a bearer on each request. A token lasts about an hour
 * and one sync takes seconds, so it is fetched per sync rather than cached.
 *
 * WHAT IS READ
 *
 *   POST /ws/oauth/token              the token
 *   GET  /api/v2/organizations        every organisation, so a person can say
 *                                     which client each is
 *   GET  /api/v2/devices-detailed     every device, paged by id: `after` is the
 *                                     last id of the previous page, and a page
 *                                     shorter than asked for is the last one
 *   GET  /api/v2/locations            every location, paged the same way; they
 *                                     become the clients' sites
 *   GET  /api/v2/queries/antivirus-status
 *   GET  /api/v2/queries/os-patches   per-device reports for the device's
 *                                     "From NinjaOne" card, paged by cursor.
 *                                     Optional: an instance or app that cannot
 *                                     read them still syncs everything else
 *
 * Read-only, and the Monitoring scope cannot do anything else. Helm never
 * writes to NinjaOne.
 *
 * REGIONS. Each NinjaOne instance lives at one regional host, and an app made
 * on one does not authenticate on another. The list is fixed here and in the
 * database (helm.ninja_base_url_allowed) because the client secret is posted to
 * whatever host the connection names.
 */

export const NINJA_REGIONS = [
  { url: 'https://app.ninjarmm.com', label: 'United States (app.ninjarmm.com)' },
  { url: 'https://us2.ninjarmm.com', label: 'United States 2 (us2.ninjarmm.com)' },
  { url: 'https://ca.ninjarmm.com', label: 'Canada (ca.ninjarmm.com)' },
  { url: 'https://eu.ninjarmm.com', label: 'Europe (eu.ninjarmm.com)' },
  { url: 'https://oc.ninjarmm.com', label: 'Oceania (oc.ninjarmm.com)' },
] as const;

export type NinjaRegionUrl = (typeof NINJA_REGIONS)[number]['url'];
export const NINJA_REGION_URLS = NINJA_REGIONS.map((r) => r.url) as unknown as readonly [NinjaRegionUrl, ...NinjaRegionUrl[]];

/** Devices per page. NinjaOne accepts up to 1000; smaller pages fail less. */
const PAGE_SIZE = 500;

/** Stop a pagination loop that never ends: 200 pages of 500 is 100,000 devices. */
const MAX_PAGES = 200;

const DEFAULT_TIMEOUT_MS = 20_000;

export class NinjaError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'unauthorized' | 'forbidden' | 'malformed' | 'http_error',
    /** What a person should change. Shown next to the failure. */
    readonly remedy?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'NinjaError';
  }
}

export interface NinjaTarget {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly timeoutMs?: number;
}

export interface NinjaOrganization {
  id: number | string;
  name?: string;
  description?: string;
}

/** The parts of a devices-detailed record Helm reads. Everything is optional: NinjaOne omits what it does not know. */
export interface NinjaLocation {
  id: number | string;
  organizationId?: number | string;
  name?: string;
  address?: string;
  description?: string;
}

/** One row of a /queries/ report. Every report names its device. */
export interface NinjaQueryRow {
  deviceId?: number | string;
  [key: string]: unknown;
}

export interface NinjaDevice {
  id: number | string;
  organizationId?: number | string;
  locationId?: number | string;
  nodeClass?: string;
  displayName?: string;
  systemName?: string;
  dnsName?: string;
  offline?: boolean;
  lastContact?: number;
  ipAddresses?: string[];
  macAddresses?: string[];
  os?: {
    name?: string; buildNumber?: string; releaseId?: string; manufacturer?: string;
    architecture?: string; lastBootTime?: number; needsReboot?: boolean;
  };
  system?: {
    domain?: string;
    manufacturer?: string;
    model?: string;
    serialNumber?: string;
    biosSerialNumber?: string;
    chassisType?: string;
    virtualMachine?: boolean;
  };
  processors?: { name?: string }[];
  memory?: { capacity?: number };
  volumes?: { name?: string; label?: string; capacity?: number; freeSpace?: number; deviceType?: string }[];
  lastLoggedInUser?: string;
  publicIP?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------------- *
 * Transport
 *
 * One function, replaceable, so the tests can answer as NinjaOne without a
 * certificate for ninjarmm.com — the same seam the session resolver uses. In
 * production it is fetch, which verifies the certificate against the system
 * store like any browser.
 * ------------------------------------------------------------------------- */

export interface NinjaRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export type NinjaTransport = (url: string, request: NinjaRequest) => Promise<{ status: number; body: string }>;

const fetchTransport: NinjaTransport = async (url, request) => {
  const response = await fetch(url, {
    method: request.method,
    headers: request.headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
    signal: AbortSignal.timeout(request.timeoutMs),
    redirect: 'error',
  });
  return { status: response.status, body: await response.text() };
};

let transport: NinjaTransport = fetchTransport;

/** For tests. `null` puts fetch back. */
export function useNinjaTransport(next: NinjaTransport | null): void {
  transport = next ?? fetchTransport;
}

async function send(url: string, request: NinjaRequest): Promise<{ status: number; body: string }> {
  try {
    return await transport(url, request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new NinjaError(
      `NinjaOne did not answer (${reason})`,
      'unreachable',
      'Check the region is the one your NinjaOne address uses, and that this server can reach it.',
    );
  }
}

/* ------------------------------------------------------------------------- */

export async function fetchToken(target: NinjaTarget): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: target.clientId,
    client_secret: target.clientSecret,
    scope: 'monitoring',
  });

  const response = await send(`${target.baseUrl}/ws/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (response.status === 400 || response.status === 401) {
    throw new NinjaError(
      'NinjaOne refused the client id and secret',
      'unauthorized',
      'Check both were copied from the API app in NinjaOne, that the app allows the Client ' +
        'Credentials grant with the Monitoring scope, and that the region matches.',
      response.status,
    );
  }
  const payload = parse(response, 'token');
  const token = (payload as { access_token?: unknown }).access_token;
  if (typeof token !== 'string' || token === '') {
    throw new NinjaError('NinjaOne answered without a token', 'malformed');
  }
  return token;
}

async function get(target: NinjaTarget, token: string, path: string): Promise<unknown> {
  const response = await send(`${target.baseUrl}${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (response.status === 401) {
    throw new NinjaError('NinjaOne refused the token', 'unauthorized', undefined, 401);
  }
  if (response.status === 403) {
    throw new NinjaError(
      'NinjaOne says this app may not read that',
      'forbidden',
      'Give the API app the Monitoring scope.',
      403,
    );
  }
  return parse(response, path);
}

function parse(response: { status: number; body: string }, what: string): unknown {
  if (response.status < 200 || response.status >= 300) {
    throw new NinjaError(`NinjaOne answered ${response.status} for ${what}`, 'http_error', undefined, response.status);
  }
  try {
    return JSON.parse(response.body);
  } catch {
    throw new NinjaError(`NinjaOne's answer for ${what} was not JSON`, 'malformed');
  }
}

export async function listOrganizations(target: NinjaTarget, token: string): Promise<NinjaOrganization[]> {
  const payload = await get(target, token, '/api/v2/organizations');
  if (!Array.isArray(payload)) throw new NinjaError('NinjaOne returned organisations in a shape Helm does not read', 'malformed');
  return payload.filter((o): o is NinjaOrganization => o !== null && typeof o === 'object' && 'id' in o);
}

export async function listDevices(target: NinjaTarget, token: string): Promise<NinjaDevice[]> {
  return listPagedById<NinjaDevice>(target, token, '/api/v2/devices-detailed', 'devices');
}

export async function listLocations(target: NinjaTarget, token: string): Promise<NinjaLocation[]> {
  return listPagedById<NinjaLocation>(target, token, '/api/v2/locations', 'locations');
}

async function listPagedById<T extends { id: number | string }>(
  target: NinjaTarget, token: string, path: string, what: string,
): Promise<T[]> {
  const all: T[] = [];
  let after: string | number | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    if (after !== null) query.set('after', String(after));
    const payload = await get(target, token, `${path}?${query}`);
    if (!Array.isArray(payload)) throw new NinjaError(`NinjaOne returned ${what} in a shape Helm does not read`, 'malformed');

    const rows = payload.filter((d): d is T => d !== null && typeof d === 'object' && 'id' in d);
    all.push(...rows);
    if (payload.length < PAGE_SIZE || rows.length === 0) return all;

    const last = rows[rows.length - 1]!.id;
    if (last === after) return all;
    after = last;
  }
  throw new NinjaError(`NinjaOne kept paging past ${MAX_PAGES * PAGE_SIZE} ${what}`, 'malformed');
}

/**
 * Every row of a /queries/ report. These page by a cursor NinjaOne names in
 * each answer, and a page shorter than asked for is the last one.
 */
export async function listQuery(target: NinjaTarget, token: string, report: string): Promise<NinjaQueryRow[]> {
  const all: NinjaQueryRow[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    if (cursor !== null) query.set('cursor', cursor);
    const payload = await get(target, token, `/api/v2/queries/${report}?${query}`) as
      { results?: unknown; cursor?: { name?: unknown } } | null;
    const results = payload?.results;
    if (!Array.isArray(results)) throw new NinjaError(`NinjaOne returned ${report} in a shape Helm does not read`, 'malformed');

    all.push(...results.filter((r): r is NinjaQueryRow => r !== null && typeof r === 'object'));
    const next = typeof payload?.cursor?.name === 'string' && payload.cursor.name !== '' ? payload.cursor.name : null;
    if (results.length < PAGE_SIZE || next === null || next === cursor) return all;
    cursor = next;
  }
  throw new NinjaError(`NinjaOne kept paging past ${MAX_PAGES * PAGE_SIZE} rows of ${report}`, 'malformed');
}
