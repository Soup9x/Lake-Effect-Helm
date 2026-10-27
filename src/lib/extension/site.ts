/**
 * Which site a browser tab is on, as the server matches it.
 *
 * The extension sends the tab's URL as the browser reported it; the server
 * works out the host and the registrable domain itself (0070's rule: the
 * extension never supplies a pattern). `new URL()` gives the host lowercased
 * and in punycode, so a Unicode lookalike never equals an ASCII host, and the
 * Public Suffix List (with its private section, so `foo.github.io` is its own
 * site) gives the registrable domain.
 */
import { getDomain } from 'tldts';

export interface Site {
  /** `admin.acme.com`, `10.0.0.1`, `[::1]`. */
  host: string;
  /** `acme.com`; null for an IP address, `localhost` or a bare intranet name. */
  registrableDomain: string | null;
}

export function siteOf(raw: string): Site | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  const domain = getDomain(host, { allowPrivateDomains: true });
  return { host, registrableDomain: domain && domain !== '' ? domain.toLowerCase() : null };
}
