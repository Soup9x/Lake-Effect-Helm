import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';

/**
 * The same rule normaliseTags() applies in lib/bulk/service.ts, minus its
 * "at least one" requirement: a credential with no tags is ordinary.
 */
function normaliseOptionalTags(raw: string[]): string[] {
  const cleaned = raw
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((t) => t.length > 0 && t.length <= 60);
  return [...new Set(cleaned)].sort();
}

const createSchema = z.object({
  organizationId: z.guid('organizationId must be a UUID'),
  label: z.string().trim().min(1).max(200),
  /*
   * NO LONGER ASKED FOR, and no longer defaulted here either. Omitting it lets
   * secret.kind's own DEFAULT apply (0540), so there is one place that decides
   * what an unspecified kind is. Still accepted, because an importer or a
   * script may genuinely know — the credential form does not.
   */
  kind: z
    .enum([
      'password', 'api_key', 'private_key', 'certificate', 'totp_seed',
      'connection_string', 'ssh_key', 'recovery_code', 'license_key', 'generic',
    ])
    .optional(),
  /**
   * Freeform labels, on the credential's asset_node. Deliberately unrelated to
   * `kind`: nothing reads these back to infer what the material is, so tagging
   * a credential can never change what reveal or export do with it.
   */
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
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

  // The credential NODE's own fields. A stored credential is two things: the
  // encrypted material, and the documented account it belongs to.
  credentialType: z
    .enum([
      'local_admin', 'domain_admin', 'service_account', 'standard_user', 'api',
      'database', 'wifi', 'vpn', 'root', 'recovery', 'shared_mailbox', 'other',
    ])
    .default('standard_user'),
  username: z.string().trim().max(200).optional(),
  url: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(4000).optional(),
  siteId: z.guid().nullable().optional(),
  criticality: z.number().int().min(1).max(5).default(3),
  isBreakGlass: z.boolean().default(false),
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
 *
 * TWO ROWS, NOT ONE, AND THIS IS WHERE THAT WAS MISSING.
 *
 * A credential in Helm is a graph node that POINTS AT a secret: `secret` holds
 * the encrypted material, and `credential` (an asset_node subtype) holds the
 * account it belongs to — the username, the URL, what it unlocks. 0070 says so
 * outright, and /api/assets refuses to create credential nodes precisely
 * because "a credential is created through /api/secrets so the value is
 * encrypted on the way in".
 *
 * This route only ever wrote the first row. The secret was stored and
 * encrypted correctly, and then nothing referenced it: the client page lists
 * credential ASSETS, so the row it needed did not exist, and the search index —
 * which is fed from asset_node — never saw it either. The credential was
 * persisted and invisible, which is the worst of the three possible outcomes,
 * because the technician believes it is captured.
 *
 * Both rows are written in the transaction the route already owns. A node
 * without material documents an account nobody can use; material without a
 * node is what this bug was.
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

    // One try/catch over BOTH writes. `secret` and `asset_node` each reach
    // organization through a composite key carrying tenant_id, so an id from
    // another tenant — or one that simply does not exist — violates a foreign
    // key in whichever runs first. Catching it around only the second left the
    // first surfacing as a bare 500, which reads as "Helm is broken" rather
    // than "there is no such client".
    let created;
    let node: { id: string } | undefined;
    try {
      created = await getSecretService().createInTransaction(
        tx,
        {
          tenantId: identity.tenantId,
          actorId: identity.actorId,
          actorType: identity.actorType,
        },
        {
          organizationId: body.organizationId,
          ...(body.kind ? { kind: body.kind } : {}),
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

      // The credential node. Same transaction, so the two cannot come apart.
      [node] = await tx<{ id: string }[]>`
        INSERT INTO asset_node (
          tenant_id, organization_id, site_id, node_type, name, notes,
          criticality, created_by, updated_by, tags
        )
        VALUES (
          ${identity.tenantId}::uuid, ${body.organizationId}::uuid,
          ${body.siteId ?? null}, 'credential'::node_type, ${body.label},
          ${body.notes ?? null},
          ${body.criticality}, ${identity.actorId}::uuid, ${identity.actorId}::uuid,
          -- Lowercased, deduplicated and sorted the way every other tag write
          -- normalises them, so a tag typed here and one added from the bulk
          -- toolbar are the same tag.
          ${normaliseOptionalTags(body.tags)}
        )
        RETURNING id
      `;
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        throw ApiError.invalid('no such client or site');
      }
      /*
       * The same rule PATCH already states, stated here too — and its absence
       * was measurable: the New credential form offers "Critical" and does not
       * send requiresStepUp, so the CHECK fired, nothing caught it, and the
       * person received `500 internal error` for ticking a box the form put in
       * front of them. A constraint violation is a user mistake and has to read
       * like one.
       *
       * The form now turns both flags on with `critical`, so this is the floor
       * rather than the everyday path — but an API client building the same
       * payload by hand deserves the same sentence.
       */
      if (
        (error as { constraint_name?: string }).constraint_name ===
        'secret_critical_requires_step_up'
      ) {
        throw ApiError.invalid(
          'a credential marked critical must also require re-authentication and a written reason to reveal',
        );
      }
      throw error;
    }
    if (!node) throw ApiError.conflict('the credential could not be created');

    // `notes` went onto the NODE above, not here. 0370 removed
    // credential.notes: a credential that carried its own notes column had two
    // of them once every asset gained one, with the interface editing the node's
    // and the offboarding export reading the credential's.
    await tx`
      INSERT INTO credential (
        id, tenant_id, node_type, credential_type, username, url,
        secret_id, is_break_glass
      )
      VALUES (
        ${node.id}::uuid, ${identity.tenantId}::uuid, 'credential',
        ${body.credentialType}::credential_type,
        ${body.username ?? null}, ${body.url ?? null},
        ${created.secretId}::uuid, ${body.isBreakGlass}
      )
    `;

    return {
      // The node is what the interface navigates to; the secret is what it
      // reveals. Both are returned because a caller storing a credential
      // programmatically needs the first to link it and the second to rotate it.
      credentialId: node.id,
      secretId: created.secretId,
      version: created.version,
      auditEventUid: created.auditEventUid,
    };
  },
  { permissions: ['secret:write', 'asset:write'] },
);

export const dynamic = 'force-dynamic';
