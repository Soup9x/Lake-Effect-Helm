import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';
import { parseTotpEnrolment, TotpEnrolmentError } from '@/lib/secrets/totp-enrolment';

/**
 * The TOTP seed attached to a credential.
 *
 *   PUT    stores one, or replaces the one that is there
 *   DELETE unlinks it
 *
 * WHY THE SEED IS AN ORDINARY SECRET AND NOT A COLUMN HERE.
 *
 * 0070 gave `credential` a totp_secret_id pointing into `secret`, with a
 * generated discriminator column carrying a composite FK that refuses anything
 * whose kind is not 'totp_seed'. That is the storage mechanism, and it is the
 * same one the password uses: the same envelope encryption under the tenant's
 * data key, the same reveal ladder, the same audit trail, the same RLS. Nothing
 * here invents a second way to keep a secret.
 *
 * REPLACING IS A ROTATION, NOT A NEW SECRET.
 *
 * If a seed is already attached, PUT writes a new VERSION of that secret rather
 * than creating a second one and repointing the credential. Two reasons, and the
 * first is the one that matters: secret_version is append-only, so a rotation
 * keeps the whole history of that TOTP slot on one audit chain, and "what seed
 * was on this account in March" stays answerable. The second is that repointing
 * would orphan the old secret row — nothing references it, nothing lists it, and
 * it holds live key material.
 */
const putSchema = z.object({
  /**
   * An otpauth:// URI or a bare base32 seed. Bounded generously: a seed is
   * ~32 characters and a URI with a long issuer and account is a few hundred,
   * so 4 KiB is far past anything real while still bounding the work.
   */
  seed: z.string().min(1).max(4096),
  /*
   * Explicit overrides, for the vendor who documents "8 digits, 60 seconds" on a
   * page that offers no QR code. Omitted, a URI's own parameters win and a bare
   * seed gets RFC 6238's defaults.
   */
  algorithm: z.enum(['SHA1', 'SHA256', 'SHA512']).optional(),
  digits: z.union([z.literal(6), z.literal(7), z.literal(8)]).optional(),
  periodSeconds: z.number().int().min(15).max(120).optional(),
  issuer: z.string().trim().max(200).nullable().optional(),
  account: z.string().trim().max(320).nullable().optional(),
  /** Why, for the rotation audit row when this replaces an existing seed. */
  reason: z.string().trim().max(500).optional(),
});

interface CredentialRow {
  id: string;
  organization_id: string;
  name: string;
  totp_secret_id: string | null;
}

/**
 * The credential, read through RLS.
 *
 * "Not there" and "not yours" are one answer, the same posture every other
 * route on this node takes: the policy simply matches no row.
 */
async function loadCredential(
  tx: Parameters<Parameters<typeof tenantRoute>[0]>[0]['tx'],
  nodeId: string,
): Promise<CredentialRow> {
  const [row] = await tx<CredentialRow[]>`
    SELECT c.id, n.organization_id, n.name, c.totp_secret_id
    FROM credential c
    JOIN asset_node n ON n.id = c.id
    WHERE c.id = ${nodeId}::uuid AND n.archived_at IS NULL
  `;
  if (!row) throw ApiError.notFound('no such credential');
  return row;
}

function nodeIdFrom(params: Record<string, string>): string {
  const nodeId = params.nodeId;
  if (!nodeId || !z.guid().safeParse(nodeId).success) {
    throw ApiError.invalid('nodeId must be a UUID');
  }
  return nodeId;
}

export const PUT = tenantRoute(
  async ({ tx, request, params, identity }) => {
    const nodeId = nodeIdFrom(params);

    const body = await readJson(request, (raw) => {
      const result = putSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid TOTP enrolment', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    // Parsed before anything is written, so a mistyped seed costs a 400 rather
    // than a credential that claims to have MFA and generates wrong codes.
    let enrolment;
    try {
      enrolment = parseTotpEnrolment(body.seed, {
        ...(body.algorithm ? { algorithm: body.algorithm } : {}),
        ...(body.digits ? { digits: body.digits } : {}),
        ...(body.periodSeconds ? { periodSeconds: body.periodSeconds } : {}),
        ...(body.issuer !== undefined ? { issuer: body.issuer } : {}),
        ...(body.account !== undefined ? { account: body.account } : {}),
      });
    } catch (error) {
      if (error instanceof TotpEnrolmentError) throw ApiError.invalid(error.message);
      throw error;
    }

    const credential = await loadCredential(tx, nodeId);
    const actor = {
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      actorType: identity.actorType,
    };

    let result;
    if (credential.totp_secret_id) {
      result = await getSecretService().rotateInTransaction(
        tx,
        actor,
        credential.totp_secret_id,
        enrolment.seed,
        body.reason ?? 'TOTP seed replaced',
      );
    } else {
      result = await getSecretService().createInTransaction(tx, actor, {
        organizationId: credential.organization_id,
        // The one caller that genuinely knows its kind, and has to say so: the
        // composite FK in 0070 refuses to accept anything else in this slot.
        kind: 'totp_seed',
        label: `${credential.name} (TOTP seed)`,
        /*
         * A seed is at least as sensitive as the password it protects — it is
         * the second factor for the same account — so it does not sit at the
         * default. Not 'critical' either: that forces step-up and a written
         * reason on every code generation, and a technician who needs a code to
         * finish a login would be re-authenticating twice per login. The
         * credential's own sensitivity still governs its password.
         */
        sensitivity: 'elevated',
      }, enrolment.seed);
    }

    await tx`
      UPDATE credential SET
        totp_secret_id      = ${result.secretId}::uuid,
        totp_algorithm      = ${enrolment.algorithm},
        totp_digits         = ${enrolment.digits},
        totp_period_seconds = ${enrolment.periodSeconds},
        totp_issuer         = ${enrolment.issuer},
        totp_account        = ${enrolment.account}
      WHERE id = ${nodeId}::uuid
    `;

    // The seed is NOT echoed. Neither is anything derived from it: a caller that
    // wants to check the enrolment took asks for a code, which is audited.
    return {
      credentialId: nodeId,
      totpSecretId: result.secretId,
      version: result.version,
      algorithm: enrolment.algorithm,
      digits: enrolment.digits,
      periodSeconds: enrolment.periodSeconds,
      issuer: enrolment.issuer,
      account: enrolment.account,
      auditEventUid: result.auditEventUid,
    };
  },
  { permissions: ['secret:write', 'asset:write'] },
);

/**
 * DELETE — the credential no longer has a second factor.
 *
 * The credential is unlinked; the secret row and its versions stay. That is the
 * same shape as every other removal in this product: secret_version is
 * append-only by trigger, and the audit question "who could generate codes for
 * this account in June" has to remain answerable after somebody detaches the
 * seed. Purging the material is the archive-and-destroy path (0500, 0520),
 * which is a separate, more privileged act.
 */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const nodeId = nodeIdFrom(params);
    const credential = await loadCredential(tx, nodeId);
    if (!credential.totp_secret_id) {
      throw ApiError.notFound('this credential has no TOTP seed');
    }

    await tx`
      UPDATE credential SET
        totp_secret_id = NULL,
        totp_issuer    = NULL,
        totp_account   = NULL
      WHERE id = ${nodeId}::uuid
    `;

    return { credentialId: nodeId, detached: credential.totp_secret_id };
  },
  { permissions: ['secret:write', 'asset:write'] },
);

export const dynamic = 'force-dynamic';
