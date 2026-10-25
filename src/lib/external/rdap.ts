/**
 * When a domain's registration expires, according to the registry.
 *
 * RDAP (RFC 9082/9083) is the JSON successor to WHOIS, and the one fact this
 * needs is in a well-specified place: an `events` array carrying an entry whose
 * `eventAction` is "expiration". Everything else in an RDAP response —
 * entities, nameservers, statuses — is deliberately ignored here, because a
 * parser that reads ten fields fails in ten ways and Helm already has somewhere
 * for a human to record the rest.
 *
 * THE ENDPOINT IS A SETTING, NOT A CONSTANT. Enabling this sends a client's
 * domain names to whoever answers; 0670 keeps that URL in
 * external_check_setting with a visible default so nobody has to read the
 * source to find out where their clients' names are going.
 *
 * NO REDIRECT TO PLAIN HTTP, EVER. The answer here is a date somebody will act
 * on, so a hop that drops to http — where anything on the path can rewrite it —
 * is refused rather than followed. Redirects within https ARE followed, because
 * the whole point of a redirector like rdap.org is to forward to the
 * authoritative registry for the TLD.
 *
 * A NAMED USER-AGENT ON EVERY HOP. Node's fetch otherwise sends `node`, and
 * public RDAP services sit behind bot filtering that can answer a generic
 * client with 403 — which read on screen as "the registry answered 403" and was
 * never retried, when the registry may not have been asked at all.
 */

const HEADERS = {
  accept: 'application/rdap+json, application/json',
  'user-agent': 'lake-effect-helm/1 (+domain-expiry)',
};

export interface RdapExpiry {
  /** The registry's expiry, when it gave one. */
  expiresAt: Date;
  /** The event date exactly as served, for an error message worth reading. */
  raw: string;
}

export class RdapError extends Error {
  readonly reason: 'unreachable' | 'not_found' | 'unsupported' | 'unreadable';

  constructor(message: string, reason: RdapError['reason']) {
    super(message);
    this.name = 'RdapError';
    this.reason = reason;
  }
}

interface RdapEvent {
  eventAction?: unknown;
  eventDate?: unknown;
}

/**
 * Pull the expiration event out of an RDAP document.
 *
 * Exported and pure so the parsing can be tested against real response shapes
 * without a socket — which matters because the shapes differ between
 * registries far more than the specification suggests.
 */
export function expiryFromRdap(document: unknown): RdapExpiry {
  if (document === null || typeof document !== 'object') {
    throw new RdapError('the registry did not return an object', 'unreadable');
  }

  const events = (document as { events?: unknown }).events;
  if (!Array.isArray(events)) {
    // A valid RDAP document for a domain that simply has no expiry event: some
    // ccTLDs publish none at all. That is 'unsupported', not a failure — there
    // is nothing to retry and nothing for anybody to fix.
    throw new RdapError('the registry published no events for this domain', 'unsupported');
  }

  const expiry = (events as RdapEvent[]).find(
    (event) => typeof event?.eventAction === 'string'
      && event.eventAction.toLowerCase() === 'expiration',
  );
  if (!expiry) {
    throw new RdapError('the registry published no expiration event', 'unsupported');
  }

  const raw = expiry.eventDate;
  if (typeof raw !== 'string') {
    throw new RdapError('the expiration event carried no date', 'unreadable');
  }

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new RdapError(`could not read the expiry date (${raw})`, 'unreadable');
  }

  return { expiresAt: new Date(parsed), raw };
}

/**
 * Ask the configured RDAP service about one domain.
 *
 * The caller passes the base URL from the tenant's setting, so this function
 * holds no opinion about where to ask — and a test points it at a local server.
 */
export async function lookupDomainExpiry(
  baseUrl: string,
  domainName: string,
  options: { timeoutMs?: number } = {},
): Promise<RdapExpiry> {
  const timeoutMs = options.timeoutMs ?? 10_000;

  const base = new URL(baseUrl);
  if (base.protocol !== 'https:') {
    throw new RdapError(`the RDAP endpoint must be https, not ${base.protocol}`, 'unreachable');
  }

  // Path-joined rather than template-concatenated, so a base URL with or
  // without a trailing slash behaves the same way.
  const url = new URL(
    `${base.pathname.replace(/\/$/, '')}/domain/${encodeURIComponent(domainName)}`,
    base.origin,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  // Which host gave the final answer, so an error names the redirector or the
  // registry rather than calling everything "the registry".
  let answeredBy = base.host;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: HEADERS,
      // Followed manually, so a hop to http can be refused rather than taken.
      redirect: 'manual',
    });

    // Up to three hops, which is more than any registry redirector uses and
    // short enough that a loop ends rather than hanging on the timeout.
    for (let hop = 0; hop < 3 && response.status >= 300 && response.status < 400; hop += 1) {
      const location = response.headers.get('location');
      if (!location) break;
      const next = new URL(location, response.url || url);
      if (next.protocol !== 'https:') {
        throw new RdapError(
          `the registry redirected to ${next.protocol}//, which would put this answer `
          + 'on the wire in clear text',
          'unreachable',
        );
      }
      answeredBy = next.host;
      response = await fetch(next, {
        signal: controller.signal,
        headers: HEADERS,
        redirect: 'manual',
      });
    }
  } catch (error) {
    if (error instanceof RdapError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new RdapError(
      controller.signal.aborted
        ? `no answer from ${base.host} within ${Math.round(timeoutMs / 1000)}s`
        : `could not reach ${base.host}: ${message}`,
      'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }

  // 404 is a real answer: this registry does not know this name. Worth
  // recording against the domain rather than retrying hourly.
  if (response.status === 404) {
    throw new RdapError(`the registry does not know ${domainName}`, 'not_found');
  }
  // 403 and 429 are refusals of this client — blocked or rate-limited — not
  // facts about the domain, so they are failures that get retried and shown in
  // amber, not 'unsupported'.
  if (response.status === 403 || response.status === 429) {
    throw new RdapError(
      `${answeredBy} refused the lookup for ${domainName} (${response.status})`,
      'unreachable',
    );
  }
  if (!response.ok) {
    throw new RdapError(
      `${answeredBy} answered ${response.status} for ${domainName}`,
      response.status >= 500 ? 'unreachable' : 'unsupported',
    );
  }

  let document: unknown;
  try {
    document = await response.json();
  } catch {
    throw new RdapError('the registry did not return JSON', 'unreadable');
  }

  return expiryFromRdap(document);
}
