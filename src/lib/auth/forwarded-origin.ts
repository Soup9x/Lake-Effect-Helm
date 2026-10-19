/**
 * The request Auth.js sees, rebuilt on the address the browser used.
 *
 * Helm answers on any address that reaches it — its IP, a DNS name, a
 * tunnel's public name — so AUTH_URL is left unset rather than pinning every
 * sign-in to one of them. next-auth then hands Auth.js Next's own request URL,
 * and behind Caddy that is NOT the browser's: Next builds it from the address
 * it listens on, so it reads https://localhost:3000. Auth.js derives its
 * callback URLs, the OIDC redirect_uri and every post-sign-in and sign-out
 * redirect from that origin, and would send the browser to an address that
 * only exists inside the container.
 *
 * So the origin is replaced with the one Caddy forwards: X-Forwarded-Host
 * (Caddy sets it to the Host the browser sent) and X-Forwarded-Proto. Only
 * when AUTH_TRUST_HOST says a proxy that sets them is in front, and only when
 * AUTH_URL has not pinned an address deliberately. A forged header from a
 * client changes the redirects of that client's own request and nothing else:
 * the value never reaches another person's browser, an email or the database.
 */
import { NextRequest } from 'next/server';

/** host[:port], or a bracketed IPv6 literal with an optional port. Nothing else. */
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

function first(value: string | null): string | undefined {
  const v = value?.split(',')[0]?.trim();
  return v ? v : undefined;
}

export function withForwardedOrigin(request: NextRequest, env: Record<string, string | undefined> = process.env): NextRequest {
  if (env.AUTH_URL) return request;
  if (env.AUTH_TRUST_HOST !== 'true') return request;

  const host = first(request.headers.get('x-forwarded-host')) ?? first(request.headers.get('host'));
  if (!host || !HOST.test(host)) return request;
  const proto = first(request.headers.get('x-forwarded-proto')) === 'http' ? 'http' : 'https';

  // Built from parts, not by assigning url.host: a host without a port leaves
  // the old port in place, and Next's is :3000.
  const { pathname, search } = request.nextUrl;
  const url = new URL(`${proto}://${host}${pathname}${search}`);
  if (url.origin === request.nextUrl.origin) return request;
  return new NextRequest(url, request);
}
