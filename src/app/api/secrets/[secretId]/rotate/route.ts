import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';

/**
 * POST /api/secrets/[secretId]/rotate — replace a credential's value.
 *
 * SEPARATE FROM PATCH ON PURPOSE. Editing a username is documentation;
 * replacing a password is a credential event. This one writes a new encrypted
 * version through helm.write_secret_version(), which means an audit row, a
 * version number, and the previous version still readable for the window the
 * retention policy allows — none of which a metadata UPDATE does or should do.
 *
 * THE GATE IS RE-DERIVED IN THE DATABASE, not here. SecretService.rotate() goes
 * through helm.write_secret_version(), which checks the actor's authority
 * itself. This route does not re-implement it — a second copy of an
 * authorisation rule is a second place for it to drift.
 *
 * WHICH GATE, PRECISELY, because this comment used to get it wrong and the
 * error was worth correcting rather than quietly deleting. It claimed a
 * credential flagged `requires_step_up` could not be rotated without one.
 * Measured: it can. helm.write_secret_version() gates on `sensitivity =
 * 'critical'`; `requires_step_up` gates the READ path in helm.reveal_secret().
 * So a standard-sensitivity credential with the flag set is unreadable without
 * a step-up and rotatable without one. That asymmetry is real, predates this
 * route, and is documented in docs/architecture/01-security-model.md §4.4 —
 * what had to stop was a route comment asserting a control that is not there.
 *
 * A refusal surfaces as `step_up_required` either way: through
 * SecretAccessDeniedError on the read side, and since 0470 through the DETAIL
 * the write-path raise carries. So the client can prompt rather than seeing a
 * bare 403 that reads as "you may never do this".
 */
const rotateSchema = z.object({
  /** Bounded exactly as creation is: 64 KiB comfortably holds a private key. */
  value: z.string().min(1).max(65_536),
  /**
   * Why. Required and substantive, because a rotation is the one credential
   * event whose reason is read later — "rotated after the Miller offboarding"
   * is the difference between an audit trail and a list of timestamps.
   */
  reason: z.string().trim().min(10).max(500),
});

export const POST = tenantRoute(
  async ({ request, identity, params }) => {
    const secretId = z.guid().safeParse(params.secretId);
    if (!secretId.success) throw ApiError.invalid('not a credential id');

    const body = await readJson(request, (raw) => {
      const result = rotateSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid rotation', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    // The plaintext arrives here and leaves encrypted. It is never logged,
    // never echoed back, and never put in an error message — the response
    // carries the new version number and the audit event id, which is all a
    // caller legitimately needs.
    const result = await getSecretService().rotate(
      { tenantId: identity.tenantId, actorId: identity.actorId, actorType: identity.actorType },
      secretId.data,
      body.value,
      body.reason,
    );

    return {
      secretId: result.secretId,
      version: result.version,
      auditEventUid: result.auditEventUid,
    };
  },
  { permissions: ['secret:write'] },
);

export const dynamic = 'force-dynamic';
