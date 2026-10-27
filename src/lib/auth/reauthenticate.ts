/**
 * Prove, again, that the person holding this session is at the keyboard, and
 * record it as a step-up (0340) the next transaction's context will carry.
 *
 * Shared by POST /api/auth/step-up and by pairing the browser extension
 * (1121). Why it verifies outside any transaction, and why it goes through the
 * ordinary login path, is in the step-up route's header.
 */
import { ApiError } from '../api/errors';
import { withTenant } from '../db/client';
import { attemptLocalLogin } from './local';
import { clientIp, type RequestIdentity } from './identity';
import { getSessionUser } from './session';

export interface Reauthentication {
  password: string;
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
          'Your account signs in through your identity provider and has no local password, ' +
            'so it cannot complete a step-up. Ask an administrator to set one.',
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
