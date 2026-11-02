import { publicRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { installSessionResolver } from '@/lib/auth/bootstrap';
import { resolveIdentity } from '@/lib/auth/identity';
import { getSessionUser } from '@/lib/auth/session';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { fieldPolicyForUser, setSessionField } from '@/lib/auth/field-session';

/**
 * POST /api/auth/field/enter — make this session a Field view session (1250).
 *
 * Needs nothing but the session: it only ever takes privilege AWAY, so there is
 * nothing to prove. The phone sign-in asks for it directly (the login route
 * creates the session already marked); this is the path for a session that
 * arrived some other way — single sign-on, or somebody choosing Field view
 * from the account menu.
 *
 * Refused when an administrator has switched Field view off.
 */
export const POST = publicRoute(async (request) => {
  await installSessionResolver();
  const identity = await resolveIdentity(request);
  if (identity.method !== 'session') {
    throw ApiError.forbidden('Field view is for people signed in with a browser');
  }

  const user = await getSessionUser();
  const token = request.cookies.get(sessionCookieName())?.value;
  if (!user || !token) throw ApiError.unauthenticated();

  if (!identity.fieldMode) {
    const policy = await fieldPolicyForUser(user.id);
    if (!policy.enabled) throw ApiError.forbidden('Field view is switched off for your organization');
    await setSessionField(token, true);
  }
  return { ok: true, fieldMode: true };
});

export const dynamic = 'force-dynamic';
