/**
 * A stub Entra sign-in and Microsoft Graph, answering in-process through
 * useGraphTransport(). Requests keep their real URLs, so a test can assert on
 * exactly what Helm would have sent where.
 */
import type { GraphTransport } from '../../src/lib/m365/client';

export interface FakeGraphTenant {
  clientSecret: string;
  displayName: string;
  users: Record<string, unknown>[];
  skus: Record<string, unknown>[];
  domains: Record<string, unknown>[];
  /** Graph paths answered 403, as an app missing a permission. */
  forbidden?: string[];
}

export interface FakeGraphRequest {
  method: string;
  url: string;
  authorization: string | null;
  form: Record<string, string> | null;
}

export class FakeGraph {
  readonly tenants = new Map<string, FakeGraphTenant>();
  readonly requests: FakeGraphRequest[] = [];
  /** Users per page, to exercise nextLink. */
  pageSize = 999;
  /** When set, the users nextLink points here instead of Graph. */
  hostileNextLink: string | null = null;

  reset(): void {
    this.tenants.clear();
    this.requests.length = 0;
    this.pageSize = 999;
    this.hostileNextLink = null;
  }

  transport(): GraphTransport {
    return async (url, request) => {
      const form = request.body ? Object.fromEntries(new URLSearchParams(request.body)) : null;
      this.requests.push({ method: request.method, url, authorization: request.headers.authorization ?? null, form });
      const parsed = new URL(url);
      const json = (status: number, payload: unknown) => ({ status, body: JSON.stringify(payload) });

      if (parsed.host === 'login.microsoftonline.com') {
        const tenantKey = decodeURIComponent(parsed.pathname.split('/')[1] ?? '');
        const tenant = this.tenants.get(tenantKey);
        if (!tenant) {
          return json(400, { error: 'invalid_request', error_description: `AADSTS90002: Tenant '${tenantKey}' not found.` });
        }
        if (form?.client_secret !== tenant.clientSecret || form?.grant_type !== 'client_credentials') {
          return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
        }
        return json(200, { access_token: `token-for-${tenantKey}`, token_type: 'Bearer', expires_in: 3599 });
      }

      if (parsed.host !== 'graph.microsoft.com') return json(404, { error: 'unknown host' });

      const tokenKey = (request.headers.authorization ?? '').replace(/^Bearer token-for-/, '');
      const tenant = this.tenants.get(tokenKey);
      if (!tenant) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } });
      if (tenant.forbidden?.some((p) => parsed.pathname.startsWith(p))) {
        return json(403, { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } });
      }

      switch (parsed.pathname) {
        case '/v1.0/organization':
          return json(200, { value: [{ id: 'org-guid', displayName: tenant.displayName }] });
        case '/v1.0/subscribedSkus':
          return json(200, { value: tenant.skus });
        case '/v1.0/domains':
          return json(200, { value: tenant.domains });
        case '/v1.0/users': {
          const skip = Number(parsed.searchParams.get('$skiptoken') ?? 0);
          const page = tenant.users.slice(skip, skip + this.pageSize);
          const more = skip + this.pageSize < tenant.users.length;
          return json(200, {
            value: page,
            ...(more ? {
              '@odata.nextLink': this.hostileNextLink
                ?? `https://graph.microsoft.com/v1.0/users?$skiptoken=${skip + this.pageSize}`,
            } : {}),
          });
        }
        default:
          return json(404, { error: { code: 'Request_ResourceNotFound', message: 'not found' } });
      }
    };
  }
}
