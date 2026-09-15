/**
 * POST /api/auth/local/change-password — a signed-in person changes their own.
 *
 * Requires the CURRENT password even though the caller already holds a valid
 * session. That is not belt-and-braces: a stolen session cookie is the most
 * likely way somebody reaches this endpoint who should not, and letting it set
 * a new password would upgrade a temporary theft into permanent ownership of
 * the account. Proving knowledge of the current password is what stops that.
 *
 * Runs on the auth pool. helm_app cannot read a password hash (there is a
 * guard in 0340 asserting it), so the verification has to happen on the
 * connection that can.
 */
import { NextResponse } from 'next/server';
import { publicRoute } from '@/lib/api/handler';
import { attemptLocalLogin, setLocalPassword } from '@/lib/auth/local';
import { clientIp } from '@/lib/auth/identity';
import { getServerIdentity, NotAuthenticatedError } from '@/lib/auth/server-identity';

interface ChangeBody {
  currentPassword?: unknown;
  newPassword?: unknown;
}

export const POST = publicRoute(async (request) => {
  const body = (await request.json().catch(() => ({}))) as ChangeBody;

  if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_request',
          message: 'currentPassword and newPassword are required',
        },
      },
      { status: 400 },
    );
  }

  let identity;
  try {
    identity = await getServerIdentity();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return NextResponse.json(
        { error: { code: 'unauthenticated', message: 'Sign in first.' } },
        { status: 401 },
      );
    }
    throw error;
  }

  // Re-authenticating through the ordinary login path is deliberate: it goes
  // through the same throttle, so a stolen cookie cannot be used to grind the
  // current password offline through this endpoint.
  const reauth = await attemptLocalLogin({
    email: identity.email,
    password: body.currentPassword,
    ip: clientIp(request),
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  if (!reauth.ok) {
    const status = reauth.outcome === 'rate_limited' || reauth.outcome === 'locked' ? 429 : 401;
    return NextResponse.json(
      {
        error: {
          code: status === 429 ? 'rate_limited' : 'invalid_credentials',
          message:
            status === 429
              ? 'Too many attempts. Wait a few minutes and try again.'
              : 'Your current password is not correct.',
        },
      },
      { status },
    );
  }

  const result = await setLocalPassword({
    userId: identity.actorId,
    password: body.newPassword,
    context: { email: identity.email, name: identity.name },
    reason: 'changed by the account owner',
    connection: 'auth',
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: {
          code: 'policy_violation',
          message: `That password ${result.problems.join('; ')}.`,
          problems: result.problems,
        },
      },
      { status: 422 },
    );
  }

  // The session that made this request survives. The person proved they know
  // both passwords, so there is nothing to revoke — and signing them out of the
  // tab they are working in would be hostile.
  return NextResponse.json({ ok: true, message: 'Your password has been changed.' });
});

export const dynamic = 'force-dynamic';
