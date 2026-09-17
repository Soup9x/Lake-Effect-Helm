/**
 * The session cookie, written by hand.
 *
 * Local sign-in bypasses Auth.js (see auth/local.ts for why), but the session
 * it creates has to be the SAME session, which means this file has to agree
 * with Auth.js's cookie conventions exactly. Two details do the work, and both
 * are the kind of thing that fails silently:
 *
 *   * The NAME changes with the scheme. Auth.js prefixes the cookie with
 *     `__Secure-` when `useSecureCookies` is on, which it is whenever
 *     NODE_ENV is production. Get this wrong and sign-in appears to succeed —
 *     the row is in auth_session, the response sets a cookie — and every
 *     subsequent request is anonymous, because the resolver is reading a
 *     different name.
 *
 *   * `__Secure-` is enforced by the BROWSER. A cookie with that prefix is
 *     rejected outright over plain http, with no console error worth the name.
 *     A production Helm reached over http therefore cannot hold a session at
 *     all. That is intended — this is a credential vault — and it is why the
 *     compose stack terminates TLS in front of the app (setup guide §4).
 *
 * Auth.js's own value is a signed JWE in JWT mode and an opaque token in
 * database mode. Helm is in database mode, so the value is the token and
 * nothing else needs to match.
 */
import { createHash } from 'node:crypto';
import type { NextResponse } from 'next/server';

/** True when Auth.js would be using secure cookies, per auth/config.ts. */
export function useSecureCookies(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * The cookie name Auth.js reads, for this environment.
 *
 * Derived rather than configured: a constant that had to be kept in step with
 * `useSecureCookies` by hand would eventually drift, and the failure is silent.
 */
export function sessionCookieName(): string {
  return useSecureCookies() ? '__Secure-authjs.session-token' : 'authjs.session-token';
}

export interface SessionCookieOptions {
  expires: Date;
}

/**
 * Attach a session cookie to a response.
 *
 * `sameSite: 'lax'` rather than 'strict': 'strict' would drop the cookie on the
 * redirect back from Entra, and a local session that behaves differently from
 * an SSO one is the thing this whole design exists to avoid. 'lax' still blocks
 * the cross-site POST that matters.
 */
export function setSessionCookie(
  response: NextResponse,
  token: string,
  options: SessionCookieOptions,
): void {
  response.cookies.set({
    name: sessionCookieName(),
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: useSecureCookies(),
    expires: options.expires,
  });
}

/**
 * Clear the session cookie.
 *
 * Deleting the cookie is the second half of signing out; the first is deleting
 * the auth_session row. Order matters: delete the row first. A cleared cookie
 * with a live row is a session an attacker who copied the cookie still holds.
 */
export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: sessionCookieName(),
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: useSecureCookies(),
    maxAge: 0,
  });
}

/**
 * The public handle for a session: sha256 of the token, hex, first 32 chars.
 *
 * MUST agree byte for byte with helm.session_ref() in 0360 — the account page
 * lists sessions by the identifier the database computes and revokes them by
 * the identifier computed here, so a divergence would silently make "this
 * device" unmatchable and "sign out everywhere else" sign you out of
 * everywhere, including here. There is a test that runs both and compares.
 *
 * Computed in Node rather than by calling the SQL function, so a live session
 * token never appears as a query parameter — where it would be one
 * log_statement setting away from sitting in the Postgres log in the clear.
 */
export function sessionRef(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32);
}
