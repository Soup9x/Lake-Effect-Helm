import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';

/**
 * POST /api/assets/{nodeId}/totp/code — the current six digits.
 *
 * POST, not GET, for the same reasons the reveal route is a POST: a GET lands in
 * browser history, proxy logs and a Referer header, and is prefetchable and
 * CSRF-able. This one hands out live MFA codes.
 *
 * THE SEED NEVER LEAVES THE SERVER. SecretService.generateTotpCode reveals it
 * through the audited path, decodes it, computes the code and wipes the bytes
 * before returning; only the digits and the window position come back. That is
 * the whole architecture of this feature: if the client could compute codes
 * itself it would need the seed, and then `secret:reveal` on this endpoint would
 * be a formality rather than a gate — every future code for the account would
 * already be computable off the record.
 *
 * WHY THIS IS A SEPARATE CALL PER WINDOW rather than a stream or a long-lived
 * token. Each generation is one audited access. A technician who sat on a page
 * for an hour watching codes tick over has accessed that credential repeatedly,
 * and an audit trail that recorded only the first one would understate it.
 *
 * `secret:reveal`, the same gate as the password, because it is the same act:
 * obtaining the means to log in as this account. The seed's own sensitivity
 * ('elevated', set when it is stored) still applies underneath — reveal_secret
 * enforces step-up and reason requirements on it exactly as it does for any
 * other secret, and a refusal comes back as step_up_required so the interface
 * can offer the prompt.
 */
const bodySchema = z.object({
  reason: z.string().max(500).optional(),
});

interface TotpRow {
  totp_secret_id: string | null;
  totp_algorithm: string;
  totp_digits: number;
  totp_period_seconds: number;
}

export const POST = tenantRoute(
  async ({ tx, request, params, identity }) => {
    const nodeId = params.nodeId;
    if (!nodeId || !z.guid().safeParse(nodeId).success) {
      throw ApiError.invalid('nodeId must be a UUID');
    }

    const body = await readJson(request, (raw) => {
      const result = bodySchema.safeParse(raw ?? {});
      if (!result.success) throw ApiError.invalid('invalid TOTP code request');
      return result.data;
    });

    /*
     * The parameters come from the credential row, read through RLS. They are
     * not accepted from the caller: letting a client choose the digit count or
     * the period would let it grind a different code space against the same
     * seed, and there is no legitimate reason for a browser to override what the
     * vendor's enrolment said.
     */
    const [row] = await tx<TotpRow[]>`
      SELECT c.totp_secret_id, c.totp_algorithm, c.totp_digits, c.totp_period_seconds
      FROM credential c
      JOIN asset_node n ON n.id = c.id
      WHERE c.id = ${nodeId}::uuid AND n.archived_at IS NULL
    `;
    if (!row) throw ApiError.notFound('no such credential');
    if (!row.totp_secret_id) throw ApiError.notFound('this credential has no TOTP seed');

    const generated = await getSecretService().generateTotpCode(
      {
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        actorType: identity.actorType,
      },
      row.totp_secret_id,
      {
        algorithm: row.totp_algorithm as 'SHA1' | 'SHA256' | 'SHA512',
        digits: row.totp_digits as 6 | 7 | 8,
        periodSeconds: row.totp_period_seconds,
      },
      { ...(body.reason ? { reason: body.reason } : {}) },
    );

    return {
      code: generated.code,
      /** Drives the countdown. The client re-asks when this reaches zero. */
      secondsRemaining: generated.secondsRemaining,
      periodSeconds: row.totp_period_seconds,
      digits: row.totp_digits,
      auditEventUid: generated.auditEventUid,
    };
  },
  { permissions: ['secret:reveal'] },
);

export const dynamic = 'force-dynamic';
