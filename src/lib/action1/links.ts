/**
 * Links into Action1's console. Action1's pages are per organization, chosen
 * by ?org=, so a device links to its organization's endpoint list rather than
 * to a page of its own, which Action1 does not address by URL.
 *
 * The console lives on the same regional host as the API (1160).
 */
const ORG_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function action1OrganizationUrl(baseUrl: string, orgId: string | null | undefined): string | null {
  return orgId && ORG_ID.test(orgId) ? `${baseUrl}/console/dashboard?org=${encodeURIComponent(orgId)}` : null;
}

export function action1EndpointsUrl(baseUrl: string, orgId: string | null | undefined): string | null {
  return orgId && ORG_ID.test(orgId) ? `${baseUrl}/console/endpoints?org=${encodeURIComponent(orgId)}` : null;
}
