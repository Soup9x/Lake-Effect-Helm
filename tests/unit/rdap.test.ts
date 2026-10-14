/**
 * The RDAP probe: parsing, and the paths that are not the happy one.
 *
 * TLS VERIFICATION IS DISABLED FOR THIS FILE'S WORKER, and only here. The
 * fixture RDAP service is a real https server with a self-signed certificate,
 * which Node's fetch rightly refuses — and the production probe has NO option
 * to accept one, deliberately: an RDAP endpoint is a public service or an
 * internal mirror, and both can present a certificate that verifies. Adding an
 * "insecure" switch to lookupDomainExpiry so a test could pass would be putting
 * a hole in the product to make the test easy.
 *
 * Vitest isolates each test file in its own process — measured, not assumed:
 * two files run in one command report different pids and the second sees the
 * variable unset. The afterAll below restores it anyway, so the suite does not
 * depend on a vitest default (`isolate`, or the pool) staying what it is.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { expiryFromRdap, lookupDomainExpiry, RdapError } from '../../src/lib/external/rdap';
import { FakeRdap, type RdapMode } from '../support/fake-external';

const running: FakeRdap[] = [];
async function service(options?: { mode?: RdapMode; expiresAt?: string }): Promise<FakeRdap> {
  const s = await FakeRdap.start(options);
  running.push(s);
  return s;
}
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});
afterAll(() => {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
});

describe('reading an expiry out of an RDAP document', () => {
  it('finds the expiration event whatever case the registry used', () => {
    // RFC 9083 names the action; registries are not consistent about its case,
    // and a probe that only matched 'expiration' would read nothing from the
    // ones that send 'Expiration'.
    for (const action of ['expiration', 'Expiration', 'EXPIRATION']) {
      const found = expiryFromRdap({
        events: [{ eventAction: action, eventDate: '2027-03-01T00:00:00Z' }],
      });
      expect(found.expiresAt.toISOString()).toBe('2027-03-01T00:00:00.000Z');
    }
  });

  it('ignores the other events, of which there are always several', () => {
    const found = expiryFromRdap({
      events: [
        { eventAction: 'registration', eventDate: '2010-01-01T00:00:00Z' },
        { eventAction: 'last changed', eventDate: '2025-06-01T00:00:00Z' },
        { eventAction: 'expiration', eventDate: '2027-03-01T00:00:00Z' },
        { eventAction: 'last update of RDAP database', eventDate: '2026-10-14T00:00:00Z' },
      ],
    });
    expect(found.expiresAt.getUTCFullYear()).toBe(2027);
  });

  it('calls a document with no expiration event unsupported, not failed', () => {
    /*
     * The distinction the whole status enum exists for. A ccTLD that publishes
     * no expiry event will never publish one — there is nothing to retry and
     * nothing for anybody to fix — so showing it in red beside a real outage
     * would train people to ignore both.
     */
    const noEvents = (): unknown => expiryFromRdap({ objectClassName: 'domain' });
    expect(noEvents).toThrow(RdapError);
    expect(noEvents).toThrow(/no events/i);
    try { noEvents(); } catch (error) {
      expect((error as RdapError).reason).toBe('unsupported');
    }

    try {
      expiryFromRdap({ events: [{ eventAction: 'registration', eventDate: '2020-01-01' }] });
      expect.unreachable('a document with no expiration event should not parse');
    } catch (error) {
      expect((error as RdapError).reason).toBe('unsupported');
    }
  });

  it('calls a date it cannot read unreadable, which IS worth looking at', () => {
    // Different from unsupported: the registry published an expiry and this
    // code could not understand it, which is a parser problem or a registry
    // doing something new. Either way somebody should see the raw value.
    try {
      expiryFromRdap({ events: [{ eventAction: 'expiration', eventDate: 'next Tuesday' }] });
      expect.unreachable('an unparseable date should not yield a date');
    } catch (error) {
      expect((error as RdapError).reason).toBe('unreadable');
      expect((error as Error).message).toContain('next Tuesday');
    }
  });

  it('refuses a document that is not an object, and an event with no date', () => {
    expect(() => expiryFromRdap(null)).toThrow(RdapError);
    expect(() => expiryFromRdap('a string')).toThrow(RdapError);
    expect(() => expiryFromRdap({ events: 'not an array' })).toThrow(RdapError);
    expect(() => expiryFromRdap({ events: [{ eventAction: 'expiration' }] }))
      .toThrow(/carried no date/i);
    expect(() => expiryFromRdap({ events: [{ eventAction: 'expiration', eventDate: 42 }] }))
      .toThrow(/carried no date/i);
  });
});

describe('asking a registry', () => {
  it('reads the expiry off a real response', async () => {
    const rdap = await service({ expiresAt: '2028-07-04T12:00:00Z' });
    const found = await lookupDomainExpiry(rdap.baseUrl, 'acme.test');
    expect(found.expiresAt.toISOString()).toBe('2028-07-04T12:00:00.000Z');
    expect(found.raw).toBe('2028-07-04T12:00:00Z');
  });

  it('asks for the domain at the RDAP path, encoded', async () => {
    const rdap = await service();
    await lookupDomainExpiry(rdap.baseUrl, 'münchen.test').catch(() => undefined);
    expect(rdap.requests[0], 'the path should be /domain/<name>, percent-encoded')
      .toBe('/domain/m%C3%BCnchen.test');
  });

  it('refuses a base URL that is not https before any socket opens', async () => {
    // Not a network failure — a refusal. The answer is a date somebody acts on,
    // so it cannot travel where anything on the path could rewrite it.
    await expect(lookupDomainExpiry('http://rdap.example', 'acme.test'))
      .rejects.toThrow(/must be https/i);
  });

  it('follows a redirect within https, which is what a redirector is for', async () => {
    // rdap.org and friends exist precisely to forward to the authoritative
    // registry for each TLD, so refusing all redirects would break the default.
    const rdap = await service({ mode: 'redirect-https' });
    const found = await lookupDomainExpiry(rdap.baseUrl, 'acme.test');
    expect(found.expiresAt.getUTCFullYear()).toBe(2027);
    expect(rdap.requests.length, 'it should have taken the second hop').toBeGreaterThan(1);
  });

  it('refuses a redirect that drops to plain http', async () => {
    /*
     * The case the manual redirect handling exists for. `redirect: 'follow'`
     * would take this hop silently, and the expiry date somebody is about to
     * act on would arrive over a channel anything could rewrite.
     */
    const rdap = await service({ mode: 'redirect-http' });
    await expect(lookupDomainExpiry(rdap.baseUrl, 'acme.test'))
      .rejects.toThrow(/clear text/i);
  });

  it('reports a 404 as not_found, which is a real answer about the name', async () => {
    const rdap = await service({ mode: 'not-found' });
    try {
      await lookupDomainExpiry(rdap.baseUrl, 'nope.test');
      expect.unreachable('a 404 should not resolve');
    } catch (error) {
      expect((error as RdapError).reason).toBe('not_found');
    }
  });

  it('reports a 5xx as unreachable, because that is the registry"s problem', async () => {
    const rdap = await service({ mode: 'server-error' });
    try {
      await lookupDomainExpiry(rdap.baseUrl, 'acme.test');
      expect.unreachable('a 503 should not resolve');
    } catch (error) {
      expect((error as RdapError).reason).toBe('unreachable');
    }
  });

  it('reports a login page as unreadable rather than guessing', async () => {
    // A captive portal or a proxy answering 200 with HTML is the classic case,
    // and it is the one where a lenient parser invents a date.
    const rdap = await service({ mode: 'not-json' });
    try {
      await lookupDomainExpiry(rdap.baseUrl, 'acme.test');
      expect.unreachable('HTML should not parse as RDAP');
    } catch (error) {
      expect((error as RdapError).reason).toBe('unreadable');
    }
  });

  it('gives up rather than hanging, and says how long it waited', async () => {
    // Port 1 on localhost refuses or never answers; either way the probe must
    // return a recorded fact instead of holding the worker's tick open.
    await expect(
      lookupDomainExpiry('https://127.0.0.1:1', 'acme.test', { timeoutMs: 300 }),
    ).rejects.toThrow(RdapError);
  });
});
