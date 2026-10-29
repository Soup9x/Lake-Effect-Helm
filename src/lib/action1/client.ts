/**
 * A client for the Action1 REST API (3.0).
 *
 * Written from Action1's published OpenAPI specification (3.1.0) and its
 * PSAction1 PowerShell module; not yet tried against a live account.
 *
 * AUTHENTICATION is an API credential made in Action1 under Configuration →
 * API Credentials: a client id (it looks like an email address) and a secret.
 * Helm posts both to /oauth2/token and sends the token back as a bearer. A
 * token lasts an hour and a sync takes seconds, so it is fetched per sync.
 *
 * WHAT IS READ
 *
 *   POST /api/3.0/oauth2/token                  the token
 *   GET  /api/3.0/organizations                 every organization, so a person
 *                                               can say which client each is
 *   GET  /api/3.0/endpoints/managed/all         every managed endpoint of every
 *        ?fields=*                              organization, with hardware,
 *                                               missing-update counts and
 *                                               statuses, paged by offset:
 *                                               `from` and `limit`, until
 *                                               `total_items` is reached
 *
 * When an endpoint comes back without organization_id (the specification
 * says it is there, but a field missing from a live answer is the usual way
 * these things go wrong) Helm reads each mapped organization's own list
 * instead, /endpoints/managed/{orgId}, and knows the organization from that.
 *
 * Read-only: Helm never writes to Action1. A credential whose role can only
 * view is enough.
 *
 * RATE. Action1 asks for fewer than 30 requests a minute per account and
 * answers 429 above it. A sync of a few thousand endpoints is a handful of
 * requests; a 429 is waited out (Retry-After, else 20 seconds) up to three
 * times before the run fails.
 *
 * REGIONS. Each Action1 account lives in one data centre, and a credential
 * made in one does not work in another. The list is fixed here and in the
 * database (helm.action1_base_url_allowed) because the secret is posted to
 * whatever host the connection names.
 */

export const ACTION1_REGIONS = [
  { url: 'https://app.action1.com', label: 'North America (app.action1.com)' },
  { url: 'https://app.na-2.action1.com', label: 'North America 2 (app.na-2.action1.com)' },
  { url: 'https://app.eu.action1.com', label: 'Europe (app.eu.action1.com)' },
  { url: 'https://app.uk.action1.com', label: 'United Kingdom (app.uk.action1.com)' },
  { url: 'https://app.au.action1.com', label: 'Australia (app.au.action1.com)' },
] as const;

export type Action1RegionUrl = (typeof ACTION1_REGIONS)[number]['url'];
export const ACTION1_REGION_URLS = ACTION1_REGIONS.map((r) => r.url) as unknown as readonly [Action1RegionUrl, ...Action1RegionUrl[]];

const API = '/api/3.0';

/** Endpoints per page. 200 is the largest PSAction1 asks for. */
const PAGE_SIZE = 200;

/** Stop a pagination loop that never ends: 500 pages of 200 is 100,000 endpoints. */
const MAX_PAGES = 500;

const DEFAULT_TIMEOUT_MS = 30_000;

const MAX_RATE_LIMIT_WAITS = 3;

export class Action1Error extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'malformed' | 'http_error',
    /** What a person should change. Shown next to the failure. */
    readonly remedy?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'Action1Error';
  }
}

export interface Action1Target {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly timeoutMs?: number;
}

export interface Action1Organization {
  id: string;
  name?: string;
  description?: string;
}

/**
 * The parts of an Endpoint Helm reads, as the specification names them.
 * Everything is optional: Action1 omits what it does not know, and the counts
 * arrive as strings in some answers and numbers in others.
 */
export interface Action1Endpoint {
  id: string;
  organization_id?: string;
  name?: string;
  device_name?: string;
  address?: string;
  external_address?: string;
  MAC?: string;
  OS?: string;
  platform?: string;
  architecture?: string;
  agent_version?: string;
  last_seen?: string;
  last_boot_time?: string;
  user?: string;
  manufacturer?: string;
  serial?: string;
  CPU_name?: string;
  CPU_size?: string;
  RAM?: string;
  disk?: string;
  AD_organization_unit?: string;
  status?: string;
  online_status?: string;
  reboot_required?: string;
  update_status?: string;
  vulnerability_status?: string;
  subscription_status?: string;
  missing_updates?: { critical?: number | string; other?: number | string };
  missing_critical_updates?: number | string;
  missing_other_updates?: number | string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------------- *
 * Transport — one replaceable function, so the tests can answer as Action1
 * without a certificate for action1.com. In production it is fetch.
 * ------------------------------------------------------------------------- */

export interface Action1Request {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export type Action1Transport = (url: string, request: Action1Request) =>
  Promise<{ status: number; body: string; retryAfter?: string | null }>;

const fetchTransport: Action1Transport = async (url, request) => {
  const response = await fetch(url, {
    method: request.method,
    headers: request.headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
    signal: AbortSignal.timeout(request.timeoutMs),
    redirect: 'error',
  });
  return { status: response.status, body: await response.text(), retryAfter: response.headers.get('retry-after') };
};

let transport: Action1Transport = fetchTransport;
let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** For tests. `null` puts fetch back. */
export function useAction1Transport(next: Action1Transport | null, wait?: (ms: number) => Promise<void>): void {
  transport = next ?? fetchTransport;
  sleep = wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

async function send(url: string, request: Action1Request) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await transport(url, request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Action1Error(
        `Action1 did not answer (${reason})`,
        'unreachable',
        'Check the region is the one your Action1 address uses, and that this server can reach it.',
      );
    }
    if (response.status !== 429) return response;
    if (attempt >= MAX_RATE_LIMIT_WAITS) {
      throw new Action1Error(
        'Action1 kept answering "too many requests"',
        'rate_limited',
        'Something else is using the same Action1 account heavily; the next sync will try again.',
        429,
      );
    }
    const seconds = Number(response.retryAfter);
    await sleep(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 120) * 1000 : 20_000);
  }
}

/* ------------------------------------------------------------------------- */

export async function fetchToken(target: Action1Target): Promise<string> {
  const response = await send(`${target.baseUrl}${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: target.clientId, client_secret: target.clientSecret }),
    timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new Action1Error(
      'Action1 refused the client id and secret',
      'unauthorized',
      'Check both were copied from the API Credentials page in Action1, that the credential ' +
        'is not expired or disabled, and that the region is the one you sign in at.',
      response.status,
    );
  }
  const payload = parse(response, 'token');
  const token = (payload as { access_token?: unknown }).access_token;
  if (typeof token !== 'string' || token === '') {
    throw new Action1Error('Action1 answered without a token', 'malformed');
  }
  return token;
}

async function get(target: Action1Target, token: string, path: string): Promise<unknown> {
  const response = await send(`${target.baseUrl}${API}${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (response.status === 401) {
    throw new Action1Error('Action1 refused the token', 'unauthorized', undefined, 401);
  }
  if (response.status === 403) {
    throw new Action1Error(
      'Action1 says this credential may not read that',
      'forbidden',
      'Give the API credential a role that can view endpoints in every organization Helm imports.',
      403,
    );
  }
  return parse(response, path.split('?')[0]!);
}

function parse(response: { status: number; body: string }, what: string): unknown {
  if (response.status < 200 || response.status >= 300) {
    throw new Action1Error(`Action1 answered ${response.status} for ${what}`, 'http_error', undefined, response.status);
  }
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Action1Error(`Action1's answer for ${what} was not JSON`, 'malformed');
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasId = (v: unknown): v is { id: string } =>
  isObject(v) && (typeof v.id === 'string' || typeof v.id === 'number') && String(v.id) !== '';

/**
 * Every item of a ResultPage collection, by offset. A page with fewer items
 * than asked for, or reaching total_items, is the last one.
 */
async function listPaged<T extends { id: string }>(
  target: Action1Target, token: string, path: string, query: Record<string, string>, what: string,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // The first page without `from`: PSAction1 notes some collections treat
    // an explicit from=0 differently, and none needs it.
    const params = new URLSearchParams({ ...query, ...(from > 0 ? { from: String(from) } : {}), limit: String(PAGE_SIZE) });
    const payload = await get(target, token, `${path}?${params}`);
    // Some collections answer a bare array; the ResultPage is the norm.
    const items = Array.isArray(payload) ? payload : isObject(payload) ? payload.items : undefined;
    if (!Array.isArray(items)) throw new Action1Error(`Action1 returned ${what} in a shape Helm does not read`, 'malformed');

    const rows = items.filter(hasId).map((r) => ({ ...r, id: String(r.id) }) as unknown as T);
    all.push(...rows);

    const total = isObject(payload) ? Number(payload.total_items) : Number.NaN;
    from += items.length;
    if (items.length === 0 || items.length < PAGE_SIZE || Array.isArray(payload)) return all;
    if (Number.isFinite(total) && from >= total) return all;
  }
  throw new Action1Error(`Action1 kept paging past ${MAX_PAGES * PAGE_SIZE} ${what}`, 'malformed');
}

export async function listOrganizations(target: Action1Target, token: string): Promise<Action1Organization[]> {
  return listPaged<Action1Organization>(target, token, '/organizations', {}, 'organizations');
}

/** Every managed endpoint the credential can see, across organizations. */
export async function listAllEndpoints(target: Action1Target, token: string): Promise<Action1Endpoint[]> {
  return listPaged<Action1Endpoint>(target, token, '/endpoints/managed/all', { fields: '*' }, 'endpoints');
}

/** One organization's managed endpoints, each stamped with that organization. */
export async function listOrganizationEndpoints(
  target: Action1Target, token: string, orgId: string,
): Promise<Action1Endpoint[]> {
  const rows = await listPaged<Action1Endpoint>(
    target, token, `/endpoints/managed/${encodeURIComponent(orgId)}`, { fields: '*' }, 'endpoints');
  return rows.map((r) => ({ ...r, organization_id: orgId }));
}
