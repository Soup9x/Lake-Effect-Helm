import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import {
  clearSessionCookie,
  sessionCookieName,
  setSessionCookie,
  useSecureCookies,
} from '../../src/lib/auth/session-cookie';

// NODE_ENV is typed readonly by Next's process.env augmentation, so it is
// stubbed rather than assigned.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('cookie naming', () => {
  it('matches what Auth.js reads in each environment', () => {
    // The failure this guards against is silent: sign-in succeeds, a row lands
    // in auth_session, a cookie is set — and every subsequent request is
    // anonymous, because the resolver is reading a different name.
    vi.stubEnv('NODE_ENV', 'production');
    expect(sessionCookieName()).toBe('__Secure-authjs.session-token');
    expect(useSecureCookies()).toBe(true);

    vi.stubEnv('NODE_ENV', 'development');
    expect(sessionCookieName()).toBe('authjs.session-token');
    expect(useSecureCookies()).toBe(false);

    vi.stubEnv('NODE_ENV', 'test');
    expect(sessionCookieName()).toBe('authjs.session-token');
  });
});

describe('setSessionCookie', () => {
  it('sets httpOnly, lax, path and expiry', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const response = NextResponse.json({ ok: true });
    const expires = new Date(Date.now() + 3600_000);

    setSessionCookie(response, 'a-session-token', { expires });
    const cookie = response.cookies.get('authjs.session-token');

    expect(cookie?.value).toBe('a-session-token');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.path).toBe('/');
    expect(cookie?.secure).toBe(false);
  });

  it('marks the cookie secure in production, under the prefixed name', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = NextResponse.json({ ok: true });

    setSessionCookie(response, 'a-session-token', { expires: new Date(Date.now() + 1000) });
    const cookie = response.cookies.get('__Secure-authjs.session-token');

    expect(cookie?.secure).toBe(true);
    // A __Secure- cookie is rejected by the browser over plain http, so a
    // production Helm behind no TLS cannot hold a session at all. Intended.
    expect(cookie?.name.startsWith('__Secure-')).toBe(true);
  });
});

describe('clearSessionCookie', () => {
  it('expires the cookie under the same name it was set with', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = NextResponse.json({ ok: true });

    clearSessionCookie(response);
    const cookie = response.cookies.get('__Secure-authjs.session-token');

    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
  });
});
