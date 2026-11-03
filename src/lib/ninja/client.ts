/**
 * A client for the NinjaOne public API (v2).
 *
 * AUTHENTICATION is an OAuth 2.0 client-credentials app, created in NinjaOne
 * under Administration → Apps → API with the "Client Credentials" grant and
 * the Monitoring scope. Helm asks for a token with the client id and secret,
 * and sends the token as a bearer on each request. A token lasts about an hour
 * and one sync takes seconds, so it is fetched per sync rather than cached; if
 * NinjaOne refuses it partway, it is fetched again once (NinjaAuth). A request
 * NinjaOne does not answer is tried three times before the run fails.
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

/**
 * Waits before each retry of a request NinjaOne did not answer, or answered
 * "busy" (502, 503, 504). A blip — a dropped connection, a regional host
 * restarting during one of NinjaOne's release windows — should cost a few
 * seconds, not a failed run and hours of backoff.
 */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000];
let retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS;

/** For tests. `null` puts the default back. */
export function useNinjaRetryDelays(next: readonly number[] | null): void {
  retryDelaysMs = next ?? DEFAULT_RETRY_DELAYS_MS;
}

const BUSY = new Set([502, 503, 504]);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * @param step what Helm was doing, for the message: "getting a token",
 *   "reading /api/v2/organizations".
 */
async function send(url: string, request: NinjaRequest, step: string): Promise<{ status: number; body: string }> {
  let reason = '';
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await transport(url, request);
      if (!BUSY.has(response.status) || attempt >= retryDelaysMs.length) return response;
      reason = `answered ${response.status}`;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      if (attempt >= retryDelaysMs.length) {
        const tries = attempt + 1;
        throw new NinjaError(
          `NinjaOne did not answer at ${hostOf(url)} while ${step} (${reason}${tries > 1 ? `, ${tries} tries` : ''})`,
          'unreachable',
          'Check the region is the one your NinjaOne address uses, and that this server can reach it. ' +
            'If it worked before and nothing changed, NinjaOne may be down or in a release window ' +
            '(status.ninjaone.com); the next sync will try again.',
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
  }
}

/** NinjaOne's own words for a refusal, when it gave any. Never echoes a token. */
function refusalDetail(body: string): string | null {
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    for (const key of ['error_description', 'resultCode', 'message', 'error']) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 200);
    }
  } catch {
    // Not JSON: say nothing rather than paste a page of HTML.
  }
  return null;
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
  }, 'getting a token');

  if (response.status === 400 || response.status === 401) {
    const detail = refusalDetail(response.body);
    throw new NinjaError(
      `NinjaOne refused the client id and secret${detail ? ` (${detail})` : ''}`,
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

/**
 * A token that can be fetched again. A sync signs in once with signIn(); when
 * NinjaOne refuses the token partway (it was revoked, or NinjaOne restarted
 * and forgot it), the request is tried once more with a fresh one instead of
 * failing the whole run. A bare string is a token that cannot be renewed.
 */
export interface NinjaAuth {
  token: string;
  /** Set once a renewal has been tried, so a refusal cannot loop. */
  renewed: boolean;
}

export async function signIn(target: NinjaTarget): Promise<NinjaAuth> {
  return { token: await fetchToken(target), renewed: false };
}

async function get(target: NinjaTarget, auth: string | NinjaAuth, path: string): Promise<unknown> {
  const step = `reading ${path.split('?')[0]}`;
  const request = (token: string) => send(`${target.baseUrl}${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }, step);

  let response = await request(typeof auth === 'string' ? auth : auth.token);
  if (response.status === 401 && typeof auth !== 'string' && !auth.renewed) {
    auth.renewed = true;
    auth.token = await fetchToken(target);
    response = await request(auth.token);
  }
  if (response.status === 401) {
    const detail = refusalDetail(response.body);
    throw new NinjaError(
      `NinjaOne gave Helm a token and then refused it while ${step}${detail ? ` (${detail})` : ''}`,
      'unauthorized',
      'The client id and secret still work, so check the API app in NinjaOne (Administration → Apps → API): ' +
        'that it is still enabled, still has the Monitoring scope, and that nobody restricted it since. ' +
        'If it looks right, this was likely NinjaOne\'s side; turn the sync back on and press Sync now.',
      401,
    );
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

export async function listOrganizations(target: NinjaTarget, token: string | NinjaAuth): Promise<NinjaOrganization[]> {
  const payload = await get(target, token, '/api/v2/organizations');
  if (!Array.isArray(payload)) throw new NinjaError('NinjaOne returned organisations in a shape Helm does not read', 'malformed');
  return payload.filter((o): o is NinjaOrganization => o !== null && typeof o === 'object' && 'id' in o);
}

export async function listDevices(target: NinjaTarget, token: string | NinjaAuth): Promise<NinjaDevice[]> {
  return listPagedById<NinjaDevice>(target, token, '/api/v2/devices-detailed', 'devices');
}

export async function listLocations(target: NinjaTarget, token: string | NinjaAuth): Promise<NinjaLocation[]> {
  return listPagedById<NinjaLocation>(target, token, '/api/v2/locations', 'locations');
}

async function listPagedById<T extends { id: number | string }>(
  target: NinjaTarget, token: string | NinjaAuth, path: string, what: string,
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
export async function listQuery(target: NinjaTarget, token: string | NinjaAuth, report: string): Promise<NinjaQueryRow[]> {
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
