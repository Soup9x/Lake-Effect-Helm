/**
 * assertNotCrossSite: a page on another origin must not be able to make a
 * signed-in browser change anything, including a page on a sibling subdomain
 * that SameSite=Lax lets the cookie through to.
 */
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { assertNotCrossSite } from '../../src/lib/api/cross-site';
import { publicRoute } from '../../src/lib/api/handler';

const request = (method: string, headers: Record<string, string> = {}) =>
  new NextRequest('https://helm.example.com/api/secrets', { method, headers });

describe('assertNotCrossSite', () => {
  it('refuses a write another site or a sibling subdomain caused', () => {
    for (const site of ['cross-site', 'same-site', 'Cross-Site']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(() => assertNotCrossSite(request(method, { 'sec-fetch-site': site }))).toThrow(/another site/);
      }
    }
  });

  it("allows Helm's own pages and things the person did directly", () => {
    expect(() => assertNotCrossSite(request('POST', { 'sec-fetch-site': 'same-origin' }))).not.toThrow();
    expect(() => assertNotCrossSite(request('POST', { 'sec-fetch-site': 'none' }))).not.toThrow();
  });

  it('allows reads from anywhere', () => {
    expect(() => assertNotCrossSite(request('GET', { 'sec-fetch-site': 'cross-site' }))).not.toThrow();
    expect(() => assertNotCrossSite(request('HEAD', { 'sec-fetch-site': 'cross-site' }))).not.toThrow();
  });

  it('allows a bearer token, which no cross-site page can attach', () => {
    expect(() =>
      assertNotCrossSite(request('POST', { 'sec-fetch-site': 'cross-site', authorization: 'Bearer helm_be_x' })),
    ).not.toThrow();
  });

  it('still refuses when the Authorization header is not a bearer token', () => {
    expect(() =>
      assertNotCrossSite(request('POST', { 'sec-fetch-site': 'cross-site', authorization: 'Basic eDp5' })),
    ).toThrow();
  });

  it('allows a request with no Sec-Fetch-Site: a server, or an old browser', () => {
    expect(() => assertNotCrossSite(request('POST'))).not.toThrow();
  });
});

describe('the route wrappers', () => {
  it('answer a cross-site write with a 403 before the handler runs', async () => {
    let ran = false;
    const route = publicRoute(async () => {
      ran = true;
      return { ok: true };
    });

    const refused = await route(request('POST', { 'sec-fetch-site': 'same-site' }));
    expect(refused.status).toBe(403);
    expect(ran).toBe(false);

    const allowed = await route(request('POST', { 'sec-fetch-site': 'same-origin' }));
    expect(allowed.status).toBe(200);
    expect(ran).toBe(true);
  });
});
