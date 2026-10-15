/**
 * POST /api/auth/local/reset — ask for a reset code.
 *
 * Two callers, two behaviours:
 *
 *   ANONYMOUS  Self-service. Emails a link, and answers identically whether or
 *              not the address exists. The answer is the security property:
 *              an endpoint that says "no account with that address" needs no
 *              password and no rate limit to be a user-enumeration tool. It
 *              cannot cancel an administrator's code, and repeats within five
 *              minutes issue nothing (0740).
 *
 *   ADMIN      An administrator issues a code for somebody else and the
 *              response CONTAINS it, once. That is not a lapse — it is the
 *              point. During an identity provider outage the mailbox is
 *              usually down too, so the code is read down the phone. This
 *              branch requires user:write and is audited.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { publicRoute } from '@/lib/api/handler';
import { issuePasswordReset } from '@/lib/auth/local';
import { getResetDelivery, resetDeliveryAvailable } from '@/lib/auth/reset-delivery';
import { clientIp } from '@/lib/auth/identity';
import { getServerIdentity, NotAuthenticatedError } from '@/lib/auth/server-identity';
import { withTenant } from '@/lib/db/client';

interface ResetBody {
  email?: unknown;
  /** Set by the administrator-issued flow; ignored from an anonymous caller. */
  outOfBand?: unknown;
}

/** The same answer for an address that exists and one that does not. */
const ACKNOWLEDGED = {
  ok: true,
  message: 'If an account exists for that address, a reset link has been sent.',
} as const;

export const POST = publicRoute(async (request) => {
  const body = (await request.json().catch(() => ({}))) as ResetBody;

  if (typeof body.email !== 'string' || body.email.length === 0) {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'email is required' } },
      { status: 400 },
    );
  }

  const ip = clientIp(request);

  if (body.outOfBand === true) {
    return issueOutOfBand(body.email, ip, request);
  }

  // Decided before the address is looked up, so the answer is the same for
  // every address. An operator who has not configured a channel needs to hear
  // that from this endpoint rather than from a user who believes they are
  // locked out — but it must not be the account's existence that decides it.
  if (!resetDeliveryAvailable()) {
    return NextResponse.json(
      {
        error: {
          code: 'reset_delivery_unavailable',
          message:
            'Self-service reset is not available on this deployment. Ask an ' +
            'administrator to issue a reset code.',
        },
      },
      { status: 503 },
    );
  }

  const issued = await issuePasswordReset({ email: body.email, origin: 'self', ip });

  // No account, or a link for this person already went out in the last five
  // minutes (0740). Answer exactly as the success path does.
  if (!issued) {
    return NextResponse.json(ACKNOWLEDGED);
  }

  try {
    await getResetDelivery().send({
      email: body.email,
      name: null,
      resetUrl: resetUrl(issued.token, request),
      expiresAt: issued.expiresAt,
      origin: 'self',
    });
  } catch (error) {
    // A configured channel that failed this time. Logged for the operator and
    // answered as usual: a distinct response here would again be one only an
    // address with an account can produce.
    console.error('[reset] self-service delivery failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return NextResponse.json(ACKNOWLEDGED);
});

/**
 * An administrator issues a code for somebody else, and reads it back.
 *
 * Requires a signed-in administrator holding user:write. The target must share
 * the administrator's current tenant, must not outrank them, and must not
 * belong to any other tenant — see db/sql/0710_reset_authority.sql.
 */
async function issueOutOfBand(
  email: string,
  ip: string | undefined,
  request: NextRequest,
): Promise<NextResponse> {
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

  // Every rule — the permission, the shared tenant, the caller's rank against
  // the target's, and the target belonging to no other tenant — is decided by
  // helm.authorise_out_of_band_reset() (0710). Issuing somebody's reset code is
  // authority over their account, so it follows the same rank rule 0350
  // applies to their membership: a tier3 must not be able to become the
  // super_admin by resetting their password.
  const [decision] = await withTenant(
    { tenantId: identity.tenantId, actorId: identity.actorId },
    async (tx) => tx<{ user_id: string | null; refusal: string | null }[]>`
      SELECT * FROM helm.authorise_out_of_band_reset(${email}::citext)
    `,
  );

  switch (decision?.refusal ?? null) {
    case null:
      break;
    case 'forbidden':
      return NextResponse.json(
        { error: { code: 'forbidden', message: 'Issuing a reset code requires user:write.' } },
        { status: 403 },
      );
    case 'not_found':
      // An administrator inside their own tenant is allowed to know whether a
      // colleague has an account — they can already see the membership list —
      // so this branch answers honestly rather than acknowledging blindly.
      return NextResponse.json(
        { error: { code: 'not_found', message: 'No active member of this tenant with that address.' } },
        { status: 404 },
      );
    case 'outranks_caller':
      return NextResponse.json(
        {
          error: {
            code: 'forbidden',
            message: 'That person’s role outranks yours. Ask an administrator of equal or higher rank.',
          },
        },
        { status: 403 },
      );
    case 'member_elsewhere':
      return NextResponse.json(
        {
          error: {
            code: 'forbidden',
            message:
              'That account also belongs to another tenant, so its password is not this ' +
              'tenant’s to reset. The person can use self-service reset instead.',
          },
        },
        { status: 403 },
      );
    default:
      throw new Error(`unrecognised reset refusal: ${String(decision?.refusal)}`);
  }

  if (!decision?.user_id) {
    throw new Error('authorise_out_of_band_reset returned neither a user nor a refusal');
  }

  const issued = await issuePasswordReset({
    email,
    origin: 'admin',
    issuedBy: identity.actorId,
    ip,
  });

  if (!issued) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'That account cannot receive a reset.' } },
      { status: 404 },
    );
  }

  return NextResponse.json({
    ok: true,
    // Shown once, never stored, never logged. Read it to the person; do not
    // paste it into a ticket.
    resetUrl: resetUrl(issued.token, request),
    expiresAt: issued.expiresAt.toISOString(),
    warning:
      'This code works once and is shown once. Read it to the person directly — ' +
      'do not put it in a ticket or a chat message.',
  });
}

/**
 * The absolute URL the person opens.
 *
 * HELM_PUBLIC_URL is authoritative, and the compose stack always has it —
 * AUTH_URL is derived from it and marked required. The request's own origin is
 * the fallback for a deployment that set neither, because the alternative was a
 * bare path: an administrator reading a reset link down the phone can do
 * nothing with "/sign-in/reset?token=...", which would quietly break the one
 * flow this path exists for.
 */
function resetUrl(token: string, request: NextRequest): string {
  const configured = process.env.HELM_PUBLIC_URL ?? process.env.AUTH_URL ?? '';
  const base = configured || new URL(request.url).origin;
  return `${base.replace(/\/$/, '')}/sign-in/reset?token=${encodeURIComponent(token)}`;
}

export const dynamic = 'force-dynamic';
