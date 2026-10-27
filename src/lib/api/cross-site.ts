/**
 * Refuse a state-changing request that another site made a browser send.
 *
 * The session cookie is `SameSite=Lax`, which keeps it off a POST from a
 * different SITE. It does not keep it off a POST from a different ORIGIN on
 * the same site: with Helm at helm.example.com, a page on any other
 * *.example.com (a marketing site, a forgotten staging box, a subdomain taken
 * over) is same-site, the browser attaches the cookie, and every JSON route
 * here parses a `text/plain` form body as readily as an `application/json`
 * one. Once Helm is on the internet under a company domain, that is the
 * realistic cross-site request forgery, and nothing else stood in its way.
 *
 * So every route wrapper asks the browser. `Sec-Fetch-Site` is set by the
 * browser itself, cannot be written by script, and says `same-origin` for
 * Helm's own pages, `none` for something the person did directly, and
 * `same-site` or `cross-site` for a request another page caused. The last two
 * are refused for anything but a read.
 *
 * What is NOT refused, and why:
 *
 *   * GET, HEAD, OPTIONS. Reads; a cross-site page cannot read the answer
 *     without CORS, which Helm never grants.
 *   * A request with a bearer token. The token, not a cookie, is what
 *     authenticates it (resolveIdentity prefers it), and a page cannot attach
 *     an Authorization header to another origin without a preflight Helm
 *     never answers. This is the browser extension and every integration.
 *   * A request with no `Sec-Fetch-Site` at all: a server — the UniFi
 *     webhook, curl, an RMM — or a browser too old to send it (Safari before
 *     16.4). Those still have SameSite=Lax, which is what they had before.
 *
 * Auth.js's own routes (/api/auth/[...nextauth]) carry their own CSRF token
 * and server actions are checked by Next, so neither passes through here.
 */
import { bearerFrom } from '../auth/tokens';
import { ApiError } from './errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function assertNotCrossSite(request: { method: string; headers: Headers }): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  if (bearerFrom(request.headers)) return;

  const site = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (site === 'cross-site' || site === 'same-site') {
    throw ApiError.forbidden('this request came from another site; make it from Helm itself');
  }
}
