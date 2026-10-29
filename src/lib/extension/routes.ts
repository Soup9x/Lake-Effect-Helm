/**
 * The only routes an extension token reaches (1200).
 *
 * A token's scopes say what kind of thing it may do, and from 1200 an
 * extension's include writing credentials and assets, which every write route
 * in Helm accepts. So a signed request from a compromised browser profile
 * could otherwise reach any of them: archive a device, edit a document,
 * delete a credential. This list is what the extension itself calls and
 * nothing more, checked on every request before anything else runs, so
 * whatever a route's permissions say, an extension token never arrives at a
 * route that is not on it.
 *
 * Paths, not prefixes: `/api/secrets/<id>/reveal` is here and
 * `/api/secrets/<id>/rotate` is not; the extension updates a password through
 * its own route, which can only touch a login matched to the site.
 */
const UUID = '[0-9a-fA-F-]{36}';

const ROUTES: readonly [method: string, pattern: RegExp][] = [
  ['GET', /^\/api\/extension\/me$/],
  ['DELETE', /^\/api\/extension\/me$/],
  ['POST', /^\/api\/extension\/renew$/],
  ['POST', /^\/api\/extension\/match$/],
  ['POST', /^\/api\/extension\/search$/],
  ['GET', /^\/api\/extension\/destinations$/],
  ['POST', /^\/api\/extension\/check$/],
  ['POST', /^\/api\/extension\/logins$/],
  ['POST', /^\/api\/extension\/logins\/update$/],
  ['POST', new RegExp(`^/api/secrets/${UUID}/reveal$`)],
  ['POST', new RegExp(`^/api/assets/${UUID}/totp/code$`)],
  ['POST', new RegExp(`^/api/personal/vault/${UUID}/reveal$`)],
  ['POST', new RegExp(`^/api/personal/vault/${UUID}/code$`)],
];

export function extensionMayCall(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  return ROUTES.some(([routeMethod, pattern]) => routeMethod === m && pattern.test(pathname));
}
