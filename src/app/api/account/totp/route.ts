import { NextResponse } from 'next/server';
import { publicRoute } from '@/lib/api/handler';
import { readJsonObjectOrEmpty } from '@/lib/api/body';
import { attemptLocalLogin } from '@/lib/auth/local';
import { clientIp } from '@/lib/auth/identity';
import { actorOf, getServerIdentity, NotAuthenticatedError, type ServerIdentity } from '@/lib/auth/server-identity';
import { withTenant } from '@/lib/db/client';
import {
  confirmEnrolment, issueRecoveryCodes, removeTotp, startEnrolment, totpStatus, verifySecondFactor,
} from '@/lib/auth/local-totp';

/**
 * /api/account/totp — the signed-in person's own authenticator (0960).
 *
 *   GET                                   whether one is set up, and recovery codes left
 *   POST { action: 'start' }              a new seed to scan (not yet in force)
 *   POST { action: 'confirm', code }      prove it with a first code; returns recovery codes
 *   POST { action: 'recovery', code }     new recovery codes, for a current code
 *   DELETE { password }                   turn it off, for the local password
 *
 * The seed and the codes live on helm_auth (see local-totp.ts); each change is
 * also written to the audit log under the person's tenant, so "who turned off
 * their second factor, and when" has an answer.
 */
type Body = { action?: unknown; code?: unknown; password?: unknown };

const json = (status: number, code: string, message: string) =>
  NextResponse.json({ error: { code, message } }, { status });

async function signedIn(): Promise<ServerIdentity | NextResponse> {
  try {
    return await getServerIdentity();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return json(401, 'unauthenticated', 'Sign in first.');
    throw error;
  }
}

async function audit(identity: ServerIdentity, action: string): Promise<void> {
  await withTenant(actorOf(identity), (tx) => tx`
    SELECT helm.audit(${action}, 'app_user', ${identity.actorId}::uuid, 'success'::audit_outcome)
  `);
}

export const GET = publicRoute(async () => {
  const identity = await signedIn();
  if (identity instanceof NextResponse) return identity;
  return NextResponse.json(await totpStatus(identity.actorId));
});

export const POST = publicRoute(async (request) => {
  const identity = await signedIn();
  if (identity instanceof NextResponse) return identity;
  const body = (await readJsonObjectOrEmpty(request)) as Body;
  const code = typeof body.code === 'string' ? body.code : '';

  switch (body.action) {
    case 'start': {
      if ((await totpStatus(identity.actorId)).enrolled) {
        return json(409, 'conflict', 'An authenticator is already set up. Turn it off first to set up another.');
      }
      return NextResponse.json({ enrolment: await startEnrolment(identity.actorId, identity.email) });
    }
    case 'confirm': {
      const codes = await confirmEnrolment(identity.actorId, code);
      if (!codes) return json(400, 'totp_invalid', 'That code is not right. Check the time on your phone and try the next one.');
      await audit(identity, 'auth.totp_enabled');
      return NextResponse.json({ recoveryCodes: codes });
    }
    case 'recovery': {
      if (!(await verifySecondFactor(identity.actorId, code))) {
        return json(400, 'totp_invalid', 'That code is not right.');
      }
      const codes = await issueRecoveryCodes(identity.actorId);
      await audit(identity, 'auth.totp_recovery_reissued');
      return NextResponse.json({ recoveryCodes: codes });
    }
    default:
      return json(400, 'invalid_request', 'action must be start, confirm or recovery');
  }
});

export const DELETE = publicRoute(async (request) => {
  const identity = await signedIn();
  if (identity instanceof NextResponse) return identity;
  const body = (await readJsonObjectOrEmpty(request)) as Body;
  if (typeof body.password !== 'string') return json(400, 'invalid_request', 'password is required');

  // Through the ordinary sign-in check, so it is throttled like one: a stolen
  // cookie cannot turn the second factor off without the password.
  const reauth = await attemptLocalLogin({
    email: identity.email,
    password: body.password,
    ip: clientIp(request),
    userAgent: request.headers.get('user-agent') ?? undefined,
    establishSession: false,
  });
  if (!reauth.ok) return json(403, 'forbidden', 'That password is not right.');

  await removeTotp(identity.actorId);
  await audit(identity, 'auth.totp_disabled');
  return NextResponse.json({ ok: true });
});

export const dynamic = 'force-dynamic';
