import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';

const createSchema = z.object({
  organizationId: z.guid('organizationId must be a UUID'),
  label: z.string().trim().min(1).max(200),
  kind: z.enum([
    'password',
    'api_key',
    'private_key',
    'certificate',
    'totp_seed',
    'connection_string',
    'ssh_key',
    'recovery_code',
    'license_key',
    'generic',
  ]),
  /**
   * The credential itself. Bounded because an unbounded body on the one
   * endpoint that encrypts its input is a cheap way to make the server do
   * expensive work; 64 KiB comfortably holds a private key.
   */
  value: z.string().min(1).max(65_536),
  sensitivity: z.enum(['standard', 'elevated', 'critical']).default('standard'),
  requiresStepUp: z.boolean().default(false),
  requiresReason: z.boolean().default(false),
  minRoleRank: z.number().int().min(0).max(100).optional(),
  rotationIntervalDays: z.number().int().min(1).max(3650).optional(),
});

/**
 * POST /api/secrets — store a credential.
 *
 * The plaintext arrives in the body and leaves this function encrypted. It is
 * never logged, never echoed back, and never put in an error message: the
 * response carries the secret's id, its version and the audit event id, which
 * is everything a caller legitimately needs and nothing it does not. A
 * validation failure reports which FIELD was wrong, never its value — the
 * field that is usually wrong is the one holding the password.
 *
 * `createInTransaction` rather than `create`, so the insert and the audit row
 * it writes share the transaction this route already opened. `create` would
 * open a second one through withTenant(), and a secret committed in one
 * transaction with its audit row in another is exactly the gap the audit chain
 * exists to close.
 *
 * The organization is not checked here. A caller who supplies an id from
 * another tenant, or one they cannot reach, hits `secret`'s RLS policy and the
 * organization foreign key — the insert matches nothing and fails. Re-checking
 * it in the application would imply the policy were optional.
 */
export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid secret', {
          // Paths only. The issues array must never carry `i.input`, which for
          // the `value` field is the credential.
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const created = await getSecretService().createInTransaction(
      tx,
      {
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        actorType: identity.actorType,
      },
      {
        organizationId: body.organizationId,
        kind: body.kind,
        label: body.label,
        sensitivity: body.sensitivity,
        requiresStepUp: body.requiresStepUp,
        requiresReason: body.requiresReason,
        ...(body.minRoleRank !== undefined ? { minRoleRank: body.minRoleRank } : {}),
        ...(body.rotationIntervalDays !== undefined
          ? { rotationIntervalDays: body.rotationIntervalDays }
          : {}),
      },
      body.value,
    );

    return {
      secretId: created.secretId,
      version: created.version,
      auditEventUid: created.auditEventUid,
    };
  },
  { permissions: ['secret:write'] },
);

export const dynamic = 'force-dynamic';
