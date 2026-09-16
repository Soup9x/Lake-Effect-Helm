/**
 * POST /api/auth/local/reset/redeem — spend a reset code and set a password.
 *
 * Public by necessity: the person holding the code is, by definition, not
 * signed in. The code is the authentication.
 *
 * Does NOT sign the person in afterwards. A reset that hands back a session
 * turns a leaked link into an account takeover with no further steps; making
 * them sign in with the password they just chose proves they know it, and the
 * redemption has already killed every session the previous holder had.
 */
import { NextResponse } from 'next/server';
import { publicRoute } from '@/lib/api/handler';
import { redeemPasswordReset } from '@/lib/auth/local';
import { clientIp } from '@/lib/auth/identity';

interface RedeemBody {
  token?: unknown;
  password?: unknown;
}

export const POST = publicRoute(async (request) => {
  const body = (await request.json().catch(() => ({}))) as RedeemBody;

  if (typeof body.token !== 'string' || typeof body.password !== 'string') {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'token and password are required' } },
      { status: 400 },
    );
  }

  const result = await redeemPasswordReset(
    body.token,
    body.password,
    clientIp(request),
  );

  if (!result.ok) {
    return NextResponse.json(
      { error: { code: 'reset_refused', message: result.problems.join('; '), problems: result.problems } },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    email: result.email,
    message: 'Your password has been changed. Sign in with it now.',
  });
});

export const dynamic = 'force-dynamic';
