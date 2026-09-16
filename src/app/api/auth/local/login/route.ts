/**
 * POST /api/auth/local/login — sign in with a local password.
 *
 * The route that still answers when Entra does not. It is a thin shell over
 * attemptLocalLogin(); the interesting decisions are there. What this file
 * owns is the response, and the response is where a login form usually leaks:
 *
 *   * ONE message for every failure. Wrong password, no such account, no local
 *     password on an account that exists — all "those credentials are not
 *     valid". A form that distinguishes them is a user-enumeration endpoint,
 *     and the accounts worth enumerating here are an MSP's administrators.
 *
 *   * Rate limiting and lockout DO say so, because the person needs to know to
 *     stop typing. That tells an attacker their attempts are landing, which
 *     they can already infer from the clock; it does not tell them whether the
 *     account exists, because a nonexistent address is throttled identically.
 */
import { NextResponse } from 'next/server';
import { publicRoute } from '@/lib/api/handler';
import { attemptLocalLogin } from '@/lib/auth/local';
import { clientIp } from '@/lib/auth/identity';
import { setSessionCookie } from '@/lib/auth/session-cookie';

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

const INVALID = 'Those credentials are not valid.';

export const POST = publicRoute(async (request) => {
  const body = (await request.json().catch(() => ({}))) as LoginBody;

  if (typeof body.email !== 'string' || typeof body.password !== 'string') {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'email and password are required' } },
      { status: 400 },
    );
  }

  const result = await attemptLocalLogin({
    email: body.email,
    password: body.password,
    ip: clientIp(request),
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  if (!result.ok) {
    if (result.outcome === 'rate_limited') {
      return NextResponse.json(
        {
          error: {
            code: 'rate_limited',
            message: 'Too many attempts. Wait a few minutes and try again.',
          },
        },
        { status: 429, headers: { 'retry-after': '900' } },
      );
    }

    if (result.outcome === 'locked') {
      const seconds = result.retryAfter
        ? Math.max(1, Math.ceil((result.retryAfter.getTime() - Date.now()) / 1000))
        : 900;

      return NextResponse.json(
        {
          error: {
            code: 'locked',
            message: 'This account is temporarily locked after repeated failures.',
            retryAfter: result.retryAfter?.toISOString(),
          },
        },
        { status: 429, headers: { 'retry-after': String(seconds) } },
      );
    }

    // bad_password, no_such_account and disabled collapse to one answer. In
    // particular 'disabled' does NOT get its own message: saying "that account
    // is disabled" confirms the address to whoever asked.
    return NextResponse.json(
      { error: { code: 'invalid_credentials', message: INVALID } },
      { status: 401 },
    );
  }

  const response = NextResponse.json({
    ok: true,
    mustChange: result.mustChange,
    expires: result.expires.toISOString(),
  });

  setSessionCookie(response, result.sessionToken, { expires: result.expires });
  return response;
});

export const dynamic = 'force-dynamic';
