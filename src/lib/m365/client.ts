/**
 * A client for Microsoft Graph, reading one client's Microsoft 365 (0990).
 *
 * AUTHENTICATION is the OAuth 2.0 client-credentials grant against the
 * client's Entra tenant, with an app registration's client id and secret. The
 * app needs these APPLICATION permissions, admin-consented in that tenant:
 *
 *   Organization.Read.All   the tenant's name, and its subscriptions
 *   User.Read.All           users, for contacts
 *   Domain.Read.All         domains
 *
 * And one that is optional: without it the rest of the sync still runs, and
 * the run says what is missing.
 *
 *   GroupMember.Read.All    groups, and who is in each (1060)
 *
 * WHAT IS READ — the sync writes nothing:
 *
 *   POST login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *   GET  /v1.0/organization       the tenant's display name (the connection test)
 *   GET  /v1.0/users              paged by @odata.nextLink
 *   GET  /v1.0/subscribedSkus
 *   GET  /v1.0/domains
 *   GET  /v1.0/groups              and /v1.0/groups/{id}/members, both paged
 *
 * AND ONE THING IS SENT, only from the MSP's own connection and only when
 * email is set to go through Microsoft 365 (1010):
 *
 *   POST /v1.0/users/{mailbox}/sendMail    needs Mail.Send (application)
 *
 * THE TOKEN GOES TO GRAPH ONLY. A nextLink is followed only when it is a Graph
 * URL: a page that pointed somewhere else would otherwise receive the bearer.
 */

export const GRAPH_URL = 'https://graph.microsoft.com';
const LOGIN_URL = 'https://login.microsoftonline.com';

/** Stop a paging loop that never ends: 100 pages of 999 users. */
const MAX_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 20_000;

export const GRAPH_PERMISSIONS = ['Organization.Read.All', 'User.Read.All', 'Domain.Read.All'] as const;

/** Group memberships (1060). Optional: the rest of the sync runs without it. */
export const GROUP_PERMISSION = 'GroupMember.Read.All';

/** An Entra tenant: a GUID, or one of its domains. It goes into a URL path. */
export const ENTRA_TENANT = /^[A-Za-z0-9][A-Za-z0-9.-]{1,252}$/;

export class GraphError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'unauthorized' | 'forbidden' | 'not_found' | 'malformed' | 'http_error',
    readonly remedy?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

export interface GraphTarget {
  readonly tenant: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly timeoutMs?: number;
}

export interface GraphUser {
  id: string;
  displayName?: string | null;
  givenName?: string | null;
  surname?: string | null;
  jobTitle?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
  businessPhones?: string[] | null;
  mobilePhone?: string | null;
  accountEnabled?: boolean | null;
  userType?: string | null;
  assignedLicenses?: { skuId?: string }[] | null;
  department?: string | null;
  officeLocation?: string | null;
  companyName?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  /** `SMTP:` the primary address, `smtp:` an alias; other prefixes are not email. */
  proxyAddresses?: string[] | null;
}

export interface GraphGroup {
  id: string;
  displayName?: string | null;
  mail?: string | null;
  groupTypes?: string[] | null;
  mailEnabled?: boolean | null;
  securityEnabled?: boolean | null;
}

/** A group's member, which may be a user, a device, a contact or a group. */
export interface GraphMember {
  id: string;
  '@odata.type'?: string;
}

export interface GraphSku {
  skuId: string;
  skuPartNumber?: string;
  capabilityStatus?: string;
  consumedUnits?: number;
  prepaidUnits?: { enabled?: number; suspended?: number; warning?: number };
}

export interface GraphDomain {
  id: string;
  isVerified?: boolean;
  isDefault?: boolean;
  isInitial?: boolean;
}

/* ------------------------------------------------------------------------- *
 * Transport: fetch in production, replaceable in tests.
 * ------------------------------------------------------------------------- */

export interface GraphRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export type GraphTransport = (url: string, request: GraphRequest) => Promise<{ status: number; body: string }>;

const fetchTransport: GraphTransport = async (url, request) => {
  const response = await fetch(url, {
    method: request.method,
    headers: request.headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
    signal: AbortSignal.timeout(request.timeoutMs),
    redirect: 'error',
  });
  return { status: response.status, body: await response.text() };
};

let transport: GraphTransport = fetchTransport;

/** For tests. `null` puts fetch back. */
export function useGraphTransport(next: GraphTransport | null): void {
  transport = next ?? fetchTransport;
}

async function send(url: string, request: GraphRequest) {
  try {
    return await transport(url, request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GraphError(`Microsoft did not answer (${reason})`, 'unreachable',
      'Check this server can reach login.microsoftonline.com and graph.microsoft.com.');
  }
}

function parse(response: { status: number; body: string }, what: string): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new GraphError(`Microsoft's answer for ${what} was not JSON`, 'malformed', undefined, response.status);
  }
}

/** Entra's own error text, which names the problem precisely (AADSTS…). */
function entraMessage(payload: unknown): string | null {
  const p = payload as { error_description?: unknown; error?: { message?: unknown } | unknown };
  if (typeof p?.error_description === 'string') return p.error_description.split('\r\n')[0]!.slice(0, 300);
  const inner = (p?.error as { message?: unknown } | undefined)?.message;
  return typeof inner === 'string' ? inner.slice(0, 300) : null;
}

/* ------------------------------------------------------------------------- */

export async function fetchToken(target: GraphTarget): Promise<string> {
  if (!ENTRA_TENANT.test(target.tenant)) {
    throw new GraphError(`${target.tenant} is not an Entra tenant id or domain`, 'malformed');
  }
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: target.clientId,
    client_secret: target.clientSecret,
    scope: `${GRAPH_URL}/.default`,
  });
  const response = await send(`${LOGIN_URL}/${encodeURIComponent(target.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (response.status >= 400 && response.status < 500) {
    const detail = entraMessage(safeParse(response.body));
    throw new GraphError(
      `Microsoft refused the sign-in${detail ? `: ${detail}` : ''}`,
      response.status === 400 && detail?.includes('AADSTS90002') ? 'not_found' : 'unauthorized',
      'Check the tenant, the application (client) ID and a current client secret value — the secret\'s Value, not its ID.',
      response.status,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new GraphError(`Microsoft answered ${response.status} to the sign-in`, 'http_error', undefined, response.status);
  }
  const token = (parse(response, 'the token') as { access_token?: unknown }).access_token;
  if (typeof token !== 'string' || token === '') throw new GraphError('Microsoft answered without a token', 'malformed');
  return token;
}

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function get(target: GraphTarget, token: string, url: string, what: string, permission: string): Promise<unknown> {
  const response = await send(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (response.status === 401 || response.status === 403) {
    throw new GraphError(
      `Microsoft 365 would not let the app read ${what}`,
      'forbidden',
      `Give the app the ${permission} application permission and grant admin consent in this client's tenant.`,
      response.status,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    const detail = entraMessage(safeParse(response.body));
    throw new GraphError(`Microsoft 365 answered ${response.status} for ${what}${detail ? `: ${detail}` : ''}`,
      'http_error', undefined, response.status);
  }
  return parse(response, what);
}

/** Every page of a Graph collection, following nextLink only within Graph. */
async function collect<T>(target: GraphTarget, token: string, path: string, what: string, permission: string): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = `${GRAPH_URL}${path}`;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const payload = await get(target, token, url, what, permission) as { value?: unknown; '@odata.nextLink'?: unknown };
    if (!Array.isArray(payload?.value)) {
      throw new GraphError(`Microsoft 365 returned ${what} in a shape Helm does not read`, 'malformed');
    }
    all.push(...(payload.value as T[]));
    const next = payload['@odata.nextLink'];
    if (typeof next !== 'string') return all;
    if (!next.startsWith(`${GRAPH_URL}/`)) {
      throw new GraphError(`Microsoft 365 pointed the next page of ${what} outside Graph`, 'malformed');
    }
    url = next;
  }
  if (url) throw new GraphError(`Microsoft 365 kept paging ${what} past ${MAX_PAGES} pages`, 'malformed');
  return all;
}

/** The tenant's display name: what the connection test shows. */
export async function readOrganization(target: GraphTarget, token: string): Promise<{ id: string; displayName: string }> {
  const [org] = await collect<{ id: string; displayName?: string }>(
    target, token, '/v1.0/organization?$select=id,displayName', 'the organisation', 'Organization.Read.All');
  if (!org) throw new GraphError('Microsoft 365 returned no organisation', 'malformed');
  return { id: org.id, displayName: org.displayName ?? org.id };
}

export function listUsers(target: GraphTarget, token: string): Promise<GraphUser[]> {
  const select = [
    'id', 'displayName', 'givenName', 'surname', 'jobTitle', 'mail', 'userPrincipalName',
    'businessPhones', 'mobilePhone', 'accountEnabled', 'userType', 'assignedLicenses',
    'department', 'officeLocation', 'companyName', 'streetAddress', 'city', 'state', 'postalCode', 'country',
    'proxyAddresses',
  ].join(',');
  return collect<GraphUser>(target, token, `/v1.0/users?$select=${select}&$top=999`, 'users', 'User.Read.All');
}

export function listSubscribedSkus(target: GraphTarget, token: string): Promise<GraphSku[]> {
  return collect<GraphSku>(target, token, '/v1.0/subscribedSkus', 'subscriptions', 'Organization.Read.All');
}

export function listDomains(target: GraphTarget, token: string): Promise<GraphDomain[]> {
  return collect<GraphDomain>(target, token, '/v1.0/domains', 'domains', 'Domain.Read.All');
}

export function listGroups(target: GraphTarget, token: string): Promise<GraphGroup[]> {
  const select = 'id,displayName,mail,groupTypes,mailEnabled,securityEnabled';
  return collect<GraphGroup>(target, token, `/v1.0/groups?$select=${select}&$top=999`, 'groups', GROUP_PERMISSION);
}

/** Direct members only: a person in a nested group is shown in the group they were added to. */
export function listGroupMembers(target: GraphTarget, token: string, groupId: string): Promise<GraphMember[]> {
  return collect<GraphMember>(target, token, `/v1.0/groups/${encodeURIComponent(groupId)}/members?$select=id&$top=999`,
    'group members', GROUP_PERMISSION);
}

/** One plain-text message, as EmailBatch hands it over. */
export interface GraphMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Send one message as `mailbox`, which must be a user or shared mailbox in
 * this tenant. Graph answers 202 with no body; nothing is kept in Sent Items,
 * because a notification is not a conversation.
 *
 * Only `X-` headers may be set through Graph, so Auto-Submitted cannot be;
 * X-Auto-Response-Suppress is Exchange's own way of saying "do not answer
 * this", which is what Auto-Submitted is for on the relay path.
 */
export async function sendMail(target: GraphTarget, token: string, mailbox: string, mail: GraphMail): Promise<void> {
  const response = await send(`${GRAPH_URL}/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      message: {
        subject: mail.subject,
        body: { contentType: 'Text', content: mail.text },
        toRecipients: [{ emailAddress: { address: mail.to } }],
        internetMessageHeaders: [
          { name: 'X-Helm-Notification', value: '1' },
          { name: 'X-Auto-Response-Suppress', value: 'All' },
        ],
      },
      saveToSentItems: false,
    }),
    timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (response.status === 202 || response.status === 200) return;

  const detail = entraMessage(safeParse(response.body));
  if (response.status === 401 || response.status === 403) {
    throw new GraphError(
      `Microsoft 365 would not let the app send as ${mailbox}${detail ? `: ${detail}` : ''}`,
      'forbidden',
      'Give the app the Mail.Send application permission and grant admin consent; if an application access '
        + 'policy limits the app, include this mailbox in it.',
      response.status,
    );
  }
  if (response.status === 404) {
    throw new GraphError(
      `Microsoft 365 has no mailbox for ${mailbox}${detail ? `: ${detail}` : ''}`,
      'not_found',
      'The sending address must be a licensed user or a shared mailbox in your Microsoft 365 tenant.',
      response.status,
    );
  }
  throw new GraphError(`Microsoft 365 answered ${response.status} to sendMail${detail ? `: ${detail}` : ''}`,
    'http_error', undefined, response.status);
}
