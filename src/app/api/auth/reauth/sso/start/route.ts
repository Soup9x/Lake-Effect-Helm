import { NextResponse, type NextRequest } from 'next/server';
import { ApiError } from '@/lib/api/errors';
import { installSessionResolver } from '@/lib/auth/bootstrap';
import { resolveIdentity } from '@/lib/auth/identity';
import { getSessionUser } from '@/lib/auth/session';
import { startSsoReauth, TICKET } from '@/lib/auth/sso-reauth';

/**
 * GET /api/auth/reauth/sso/start?t=<ticket> — open the provider's sign-in for
 * a re-authentication (1270).
 *
 * Opened by the prompt in a small window, straight from the click, so a popup
 * blocker lets it through. A GET because a window can only be opened on one;
 * it changes nothing but a cookie, and the ticket it starts is worthless to
 * anybody but this session.
 *
 * Errors come back as the same /reauth/done page the success lands on, so the
 * window always says what happened and the waiting prompt always hears it.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const origin = originOf(request);
  const ticket = request.nextUrl.searchParams.get('t') ?? '';
  const fail = (message: string) => {
    const done = new URL('/reauth/done', origin);
    if (TICKET.test(ticket)) done.searchParams.set('t', ticket);
    done.searchParams.set('error', message);
    return NextResponse.redirect(done, 303);
  };

  if (!TICKET.test(ticket)) return fail('This confirmation link is malformed. Close this window and try again.');

  try {
    await installSessionResolver();
    const identity = await resolveIdentity(request);
    const user = await getSessionUser();
    if (identity.method !== 'session' || identity.actorType !== 'user' || !user) {
      return fail('Sign in to Helm first.');
    }

    const started = await startSsoReauth({ userId: identity.actorId, email: user.email, ticket, origin });
    const response = NextResponse.redirect(started.location, 303);
    response.cookies.set(started.cookie.name, started.cookie.value, {
      path: started.cookie.path,
      maxAge: started.cookie.maxAge,
      httpOnly: true,
      secure: started.cookie.secure,
      // Lax: the provider sends the person back with a top-level GET.
      sameSite: 'lax',
    });
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch (error) {
    if (error instanceof ApiError) return fail(error.message);
    console.error('helm: could not start a single sign-on re-authentication', error);
    return fail('Could not reach your sign-in provider. Try again in a moment.');
  }
}

/** The address the sign-in redirect URI was registered with — see oidc/route.ts. */
function originOf(request: Request): string {
  const configured = process.env.AUTH_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const headers = request.headers;
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  const proto = headers.get('x-forwarded-proto') ?? 'https';
  if (host) return `${proto}://${host}`;
  return new URL(request.url).origin;
}

export const dynamic = 'force-dynamic';
