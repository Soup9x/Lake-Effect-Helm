import { z } from 'zod';
import { publicRoute, readJson } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { installSessionResolver } from '@/lib/auth/bootstrap';
import { resolveIdentity } from '@/lib/auth/identity';
import { reauthenticate } from '@/lib/auth/reauthenticate';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { setSessionField } from '@/lib/auth/field-session';

const bodySchema = z.object({
  password: z.string().min(1).max(1024),
  code: z.string().trim().max(32).optional(),
});

/**
 * POST /api/auth/field/upgrade — leave Field view for the full site (1250).
 *
 * The one way a phone session gets its write access back, and it costs the
 * password again, plus the authenticator code when the account has one. That
 * is the whole point of Field view: a phone left unlocked at a client site can
 * show what it was showing, and nothing more, until its owner proves it is
 * still them. The re-authentication is recorded as a step-up, with its audit
 * row, by reauthenticate().
 */
export const POST = publicRoute(async (request) => {
  await installSessionResolver();
  const identity = await resolveIdentity(request);

  const body = await readJson(request, (raw) => {
    const result = bodySchema.safeParse(raw);
    if (!result.success) throw ApiError.invalid('your password is required', { issues: zodIssues(result.error) });
    return result.data;
  });

  const token = request.cookies.get(sessionCookieName())?.value;
  if (!token) throw ApiError.unauthenticated();

  await reauthenticate(request, identity, {
    password: body.password,
    code: body.code,
    secondFactor: 'if_enrolled',
  });
  await setSessionField(token, false);
  return { ok: true, fieldMode: false };
});

export const dynamic = 'force-dynamic';
