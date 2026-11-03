/**
 * Prove, again, that the person holding this session is at the keyboard, and
 * record it as a step-up (0340) the next transaction's context will carry.
 *
 * Shared by POST /api/auth/step-up and by pairing the browser extension
 * (1121). Why it verifies outside any transaction, and why it goes through the
 * ordinary login path, is in the step-up route's header.
 */
import { z } from 'zod';
import { ApiError } from '../api/errors';
import { withTenant } from '../db/client';
import { attemptLocalLogin } from './local';
import { clientIp, type RequestIdentity } from './identity';
import { getSessionUser } from './session';
import { TICKET, totpEnrolled } from './sso-reauth';
import { verifySecondFactor } from './local-totp';

/**
 * The request fields every re-authenticating route accepts: the password, or a
 * single sign-on ticket (1270), and the authenticator code when asked for.
 * Spread into a route's z.object and refine with `hasReauth`.
 */
export const reauthFields = {
  password: z.string().min(1).max(1024).optional(),
  ssoTicket: z.string().regex(TICKET).optional(),
  code: z.string().trim().max(32).optional(),
};

export const hasReauth = (v: { password?: string | undefined; ssoTicket?: string | undefined }) =>
  Boolean(v.password) || Boolean(v.ssoTicket);

export interface Reauthentication {
  /** The Helm password. Either this or `ssoTicket`. */
  password?: string | undefined;
  /**
   * A confirmation with the identity provider (1270): the ticket the browser
   * minted before opening the provider's sign-in window. Good once, within
   * five minutes of that sign-in.
   */
  ssoTicket?: string | undefined;
  /** The authenticator code, when `secondFactor` asks for one. */
  code?: string | undefined;
  /** Also ask for the authenticator code, if the account has an authenticator. */
  secondFactor?: 'if_enrolled' | undefined;
}

/**
 * Throws an ApiError the caller can show as it is. A missing code comes back
 * as `unauthenticated` with `details.secondFactor = 'totp'`, so a form knows
 * to ask for one rather than calling the password wrong.
 */
export async function reauthenticate(
  request: Request,
  identity: RequestIdentity,
  input: Reauthentication,
): Promise<Date> {
  if (identity.method !== 'session') {
    // A step-up is a person proving they are still at the keyboard. An API
    // token is not, and helm.record_step_up() would refuse a service account
    // anyway — but a token issued to a USER carries actor_type 'user' and
    // would sail past that check. Refused here, where the distinction exists.
    throw ApiError.forbidden(
      'step-up verification is an interactive re-authentication and cannot be completed with an API token',
    );
  }

  const user = await getSessionUser();
  if (!user) throw ApiError.unauthenticated();

  if (input.ssoTicket) return reauthenticateWithSso(request, identity, user.id, input);
  if (!input.password) throw ApiError.invalid('your password is required');

  const reauth = await attemptLocalLogin({
    email: user.email,
    password: input.password,
    ip: clientIp(request),
    userAgent: request.headers.get('user-agent') ?? undefined,
    establishSession: false,
    code: input.code,
    secondFactor: input.secondFactor,
  });

  if (!reauth.ok) {
    // Unlike the sign-in route, this may be specific. Enumeration safety
    // exists there because the caller has not proved who they are; here they
    // are already authenticated AS this account, so "you have no local
    // password" tells them something about themselves they need to know and a
    // stranger cannot reach. Answering "wrong password" to somebody who has no
    // password to get wrong is how a person retypes it eleven times.
    switch (reauth.outcome) {
      case 'rate_limited':
      case 'locked':
        throw new ApiError('rate_limited', 'Too many attempts. Wait a few minutes and try again.');
      case 'no_such_account':
        throw ApiError.forbidden(
          'Your account signs in through your identity provider and has no local password. ' +
            'Use the single sign-on button to confirm instead.',
        );
      case 'disabled':
        throw ApiError.forbidden('This account is disabled.');
      case 'totp_required':
      case 'totp_enrolment_required':
        throw new ApiError('unauthenticated', 'Enter the code from your authenticator app.', {
          secondFactor: 'totp',
        });
      case 'bad_totp':
        throw new ApiError('unauthenticated', 'That code is not correct.', { secondFactor: 'totp' });
      default:
        throw new ApiError('unauthenticated', 'That password is not correct.');
    }
  }

  // One statement, one short transaction. record_step_up() writes both the
  // verification row and its audit event, and it derives the actor from the
  // session context rather than from anything passed here.
  return withTenant(
    {
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      actorType: identity.actorType,
      ...(identity.ip ? { ip: identity.ip } : {}),
      ...(identity.userAgent ? { userAgent: identity.userAgent } : {}),
    },
    async (tx) => {
      const [row] = await tx<{ record_step_up: Date }[]>`
        SELECT helm.record_step_up(
          ${reauth.method === 'radius' ? 'password' : reauth.method}::text,
          (SELECT step_up_minutes FROM helm.session_policy()),
          ${identity.ip ?? null}::inet)
      `;
      if (!row) throw new Error('helm.record_step_up returned no row');
      return row.record_step_up;
    },
  );
}

/**
 * The identity-provider path. The provider sign-in already happened in its own
 * window and wrote a step-up row tagged with this ticket; this spends it.
 *
 * The authenticator code, when the action asks for one and the person has set
 * one up in Helm, is still required: the provider is not obliged to have asked
 * for a second factor. It is checked AFTER the ticket is spent, so a wrong code
 * costs a new provider sign-in rather than leaving five minutes to guess in.
 */
async function reauthenticateWithSso(
  request: Request,
  identity: RequestIdentity,
  userId: string,
  input: Reauthentication,
): Promise<Date> {
  const wantsCode = input.secondFactor === 'if_enrolled' && (await totpEnrolled(userId));
  if (wantsCode && !input.code?.trim()) {
    throw new ApiError('unauthenticated', 'Enter the code from your authenticator app.', { secondFactor: 'totp' });
  }

  const ctx = {
    tenantId: identity.tenantId,
    actorId: identity.actorId,
    actorType: identity.actorType,
    ...(identity.ip ? { ip: identity.ip } : {}),
    ...(identity.userAgent ? { userAgent: identity.userAgent } : {}),
  };

  const consumed = await withTenant(ctx, async (tx) => {
    const [row] = await tx<{ ok: boolean }[]>`SELECT helm.consume_sso_reauth(${input.ssoTicket ?? ''}) AS ok`;
    return row?.ok === true;
  });
  if (!consumed) {
    throw new ApiError('unauthenticated', 'That sign-in confirmation has expired or was already used. Confirm again.');
  }

  if (wantsCode && !(await verifySecondFactor(userId, input.code ?? ''))) {
    throw new ApiError('unauthenticated', 'That code is not correct. Confirm your sign-in again, then enter a fresh code.', {
      secondFactor: 'totp',
      ssoSpent: true,
    });
  }

  void request;
  // The step-up the provider sign-in recorded is still open; report its end.
  return withTenant(ctx, async (tx) => {
    const [row] = await tx<{ expires_at: Date }[]>`
      SELECT max(expires_at) AS expires_at FROM step_up_verification
      WHERE user_id = ${identity.actorId}::uuid AND expires_at > now()
    `;
    return row?.expires_at ?? new Date();
  });
}
