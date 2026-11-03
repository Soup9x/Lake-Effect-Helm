import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { TICKET } from '@/lib/auth/sso-reauth';

/**
 * GET /api/auth/reauth/sso/status?t=<ticket> — has the provider sign-in for
 * this ticket landed? Polled by the waiting prompt (1270), in case the sign-in
 * window cannot message it back (a phone that opened it as a tab, say).
 */
export const GET = tenantRoute(async ({ tx, request }) => {
  const ticket = request.nextUrl.searchParams.get('t') ?? '';
  if (!TICKET.test(ticket)) throw ApiError.invalid('a ticket is required');
  const [row] = await tx<{ done: boolean }[]>`SELECT helm.sso_reauth_done(${ticket}) AS done`;
  return { done: row?.done === true };
});

export const dynamic = 'force-dynamic';
