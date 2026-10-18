/**
 * withForwardedOrigin: Auth.js must see the address the browser used.
 *
 * Behind Caddy, Next hands route handlers a URL on the address it listens on
 * (https://localhost:3000). With AUTH_URL deliberately unset — Helm answers on
 * any address — Auth.js would build every callback and redirect on that
 * internal origin. The last case drives next-auth's real route handler — the
 * one production serves — and reads the callback URL in its sign-in redirect.
 */
import NextAuth from 'next-auth';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { withForwardedOrigin } from '../../src/lib/auth/forwarded-origin';

const TRUSTED = { AUTH_TRUST_HOST: 'true' };
const inner = (headers: Record<string, string>) =>
  new NextRequest('https://localhost:3000/api/auth/signin?x=1', { headers });

describe('withForwardedOrigin', () => {
  it('rebuilds the origin from the forwarded host and protocol', () => {
    const out = withForwardedOrigin(inner({ 'x-forwarded-host': '192.168.3.14', 'x-forwarded-proto': 'https' }), TRUSTED);
    expect(out.nextUrl.href).toBe('https://192.168.3.14/api/auth/signin?x=1');
  });

  it('keeps a port and works for any name', () => {
    const out = withForwardedOrigin(inner({ 'x-forwarded-host': 'helm.example.net:8443' }), TRUSTED);
    expect(out.nextUrl.origin).toBe('https://helm.example.net:8443');
  });

  it('falls back to Host, and takes the first of a list', () => {
    expect(withForwardedOrigin(inner({ host: 'helm.lan' }), TRUSTED).nextUrl.origin).toBe('https://helm.lan');
    expect(withForwardedOrigin(inner({ 'x-forwarded-host': 'a.example, b.example', 'x-forwarded-proto': 'https, http' }), TRUSTED)
      .nextUrl.origin).toBe('https://a.example');
  });

  it('leaves the request alone when AUTH_URL pins an address, or no proxy is trusted', () => {
    const req = inner({ 'x-forwarded-host': '192.168.3.14' });
    expect(withForwardedOrigin(req, { ...TRUSTED, AUTH_URL: 'https://helm.example.com' })).toBe(req);
    expect(withForwardedOrigin(req, {})).toBe(req);
  });

  it('refuses a host that is not a host', () => {
    for (const bad of ['evil.example/path', 'a b', 'user@evil.example', '']) {
      const req = inner({ 'x-forwarded-host': bad });
      expect(withForwardedOrigin(req, TRUSTED).nextUrl.origin).toBe('https://localhost:3000');
    }
  });

  it('makes Auth.js build its callback URL on the address the browser used', async () => {
    delete process.env.AUTH_URL;
    const { handlers } = NextAuth({
      secret: 'x'.repeat(32), trustHost: true, providers: [], pages: { signIn: '/sign-in' },
    });
    const callbackOf = async (req: NextRequest) => {
      const location = (await handlers.GET(req)).headers.get('location') ?? '';
      return new URLSearchParams(location.split('?')[1]).get('callbackUrl');
    };
    for (const host of ['192.168.3.14', 'helm.example.net']) {
      const req = withForwardedOrigin(inner({ 'x-forwarded-host': host, 'x-forwarded-proto': 'https' }), TRUSTED);
      expect(await callbackOf(req)).toBe(`https://${host}`);
    }
    // And the failure this exists for: without it, the container's own address.
    expect(await callbackOf(inner({ 'x-forwarded-host': '192.168.3.14' }))).toBe('https://localhost:3000');
  });
});
