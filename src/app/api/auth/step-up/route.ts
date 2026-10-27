/**
 * POST /api/auth/step-up — prove, again, that you are the person holding this
 * session.
 *
 * WHY THIS FILE DID NOT EXIST UNTIL NOW, AND WHAT THAT COST. helm.record_step_up()
 * has been in the schema since 0340: correct, granted to helm_app, refusing
 * machine identities, clamping its own TTL, writing its own audit row. Nothing
 * ever called it. A function nobody calls is indistinguishable from a feature
 * nobody has, and the absence was load-bearing in three places:
 *
 *   - No `critical` secret could be created at all. helm.write_secret_version()
 *     refuses to write material for one unless the session has stepped up, so
 *     every attempt failed — while the New credential form went on offering
 *     "Critical" in its dropdown.
 *   - Any secret flagged `requires_step_up` became permanently unreadable.
 *   - Two components rendered "re-authenticate, then try again" as advice,
 *     with nothing in the product that could carry it out.
 *
 * WHAT COUNTS AS A STEP-UP HERE. The local password, re-entered — which is what
 * 0340 designed for ("satisfy a step-up with the local password ... the password
 * check itself happens in the application; this records the result"). It is also
 * the only interactive factor this product has: there is no WebAuthn, and the
 * TOTP engine in src/lib/crypto is for DOCUMENTING a client's seeds, not for
 * authenticating Helm's own users. step_up_verification.method already permits
 * 'webauthn', 'totp' and 'sso_reauth'; when one of those arrives it belongs
 * here, beside this one, rather than replacing it.
 *
 * VERIFY FIRST, THEN OPEN THE TRANSACTION, and that ordering is deliberate
 * rather than stylistic. attemptLocalLogin() may sit on a RADIUS round trip for
 * seconds when a directory is configured and unreachable — "RADIUS was
 * configured and did not answer" is a first-class outcome in this product.
 * Running that inside a tenant transaction would pin a pooled Postgres backend
 * idle-in-transaction for the duration of somebody else's network problem. So
 * this is a publicRoute that establishes its own short context for the single
 * statement that needs one.
 *
 * RE-USING THE ORDINARY LOGIN PATH is what keeps this from becoming a password
 * oracle. It goes through the same throttle, the same lockout and the same
 * auth_attempt accounting as the sign-in screen, so a stolen session cookie
 * cannot be used to grind the password here at a rate the login form would
 * refuse. `establishSession: false` because this proves knowledge; it does not
 * mint a session, and one minted here would appear on the account page as a
 * place the person is supposedly signed in.
 */
import { publicRoute } from '@/lib/api/handler';
import { readJsonObjectOrEmpty } from '@/lib/api/body';
import { ApiError } from '@/lib/api/errors';
import { resolveIdentity } from '@/lib/auth/identity';
import { installSessionResolver } from '@/lib/auth/bootstrap';
import { reauthenticate } from '@/lib/auth/reauthenticate';

/**
 * How long a verification lasts: the tenant's session policy (0890), fifteen
 * minutes unless an administrator changed it.
 *
 * helm.record_step_up() clamps it to 1..60 minutes whatever is passed. Fifteen
 * is long enough to reveal a credential, read it and rotate it; short enough
 * that a walked-away-from session does not stay elevated.
 */

interface StepUpBody {
  password?: unknown;
}

export const POST = publicRoute(async (request) => {
  // publicRoute does not install the resolver the way tenantRoute does, and
  // resolveIdentity() reaches getSessionUser() immediately. Idempotent and
  // memoised.
  await installSessionResolver();

  const body = (await readJsonObjectOrEmpty(request)) as StepUpBody;
  if (typeof body.password !== 'string' || body.password.length === 0) {
    throw ApiError.invalid('password is required');
  }

  // The SAME resolution the reveal it is about to enable will use. A step-up
  // recorded against a different tenant than the reveal runs in would be
  // written, audited, and silently useless — set_session_context() matches
  // step_up_verification on (user_id, tenant_id).
  const identity = await resolveIdentity(request);
  const expiresAt = await reauthenticate(request, identity, { password: body.password });

  // The expiry, so the caller can say how long it lasts rather than guessing.
  // No token: the verification is a row the database reads when the NEXT
  // request opens its context, not a bearer credential this response hands out.
  return {
    ok: true,
    expiresAt: expiresAt.toISOString(),
    minutes: Math.round((expiresAt.getTime() - Date.now()) / 60_000),
  };
});

export const dynamic = 'force-dynamic';
