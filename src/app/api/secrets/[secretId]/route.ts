import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/**
 * PATCH /api/secrets/[secretId] — edit a credential's documentation.
 *
 * NOT ITS VALUE. Changing what the password IS goes through
 * POST /api/secrets/[secretId]/rotate, because that writes a new encrypted
 * version through the audited handshake and this does not. Two verbs for two
 * genuinely different acts: correcting a username is documentation, replacing a
 * password is a credential event that a client may need to be told about.
 *
 * A CREDENTIAL IS TWO ROWS, and this route knows it. `secret` holds the
 * encrypted material and its access policy; `credential`, an asset_node
 * subtype, holds the account it belongs to. /api/secrets POST creates both, so
 * editing has to reach both or half the form would silently do nothing.
 *
 * WHAT IS NOT EDITABLE HERE, and why:
 *
 *   * `kind` — it decides how the value is interpreted and rendered, and
 *     changing it on a stored version would relabel ciphertext rather than
 *     convert it.
 *   * `requiresStepUp`, `requiresReason`, `minRoleRank` — the access policy.
 *     These ARE editable, and deliberately so: a credential that turns out to
 *     be more sensitive than it looked must be able to become more protected
 *     without being deleted and re-entered. Relaxing them is the direction
 *     worth noticing, which is why every change here is audited below.
 */
const patchSchema = z
  .object({
    // `secret`
    label: z.string().trim().min(1).max(200).optional(),
    sensitivity: z.enum(['standard', 'elevated', 'critical']).optional(),
    requiresStepUp: z.boolean().optional(),
    requiresReason: z.boolean().optional(),
    minRoleRank: z.number().int().min(0).max(100).optional(),
    rotationIntervalDays: z.number().int().min(1).max(3650).nullable().optional(),

    // `credential` + its asset_node
    name: z.string().trim().min(1).max(200).optional(),
    username: z.string().trim().max(200).nullable().optional(),
    url: z.string().trim().max(2000).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    credentialType: z
      .enum([
        'local_admin', 'domain_admin', 'service_account', 'standard_user', 'api',
        'database', 'wifi', 'vpn', 'root', 'recovery', 'shared_mailbox', 'other',
      ])
      .optional(),
    criticality: z.number().int().min(1).max(5).optional(),
    isBreakGlass: z.boolean().optional(),
    siteId: z.guid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

interface SecretRow {
  id: string;
  label: string;
  node_id: string | null;
}

export const PATCH = tenantRoute(
  async ({ tx, request, identity, params, session }) => {
    const secretId = z.guid().safeParse(params.secretId);
    if (!secretId.success) throw ApiError.invalid('not a credential id');

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid changes', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    // Read through RLS first. A secret the actor cannot see must 404 here
    // rather than fall through to an UPDATE that matches nothing and reports
    // "no such credential" for a different reason.
    const [existing] = await tx<SecretRow[]>`
      SELECT s.id, s.label, c.id AS node_id
      FROM secret s
      LEFT JOIN credential c ON c.secret_id = s.id
      WHERE s.id = ${secretId.data}::uuid AND s.deleted_at IS NULL
    `;
    if (!existing) throw ApiError.notFound('no such credential');

    /*
     * THE FLOOR CANNOT BE RAISED ABOVE THE EDITOR'S OWN RANK.
     *
     * Otherwise the first thing a technician can do with a credential they can
     * see is make it one they cannot — locking themselves, and anyone junior to
     * them, out of a credential that was working a moment ago. Raising it for
     * somebody ELSE is fine and is the point; raising it past yourself is
     * almost always a mistake and is trivially reversible by nobody.
     */
    if (body.minRoleRank !== undefined && body.minRoleRank > session.roleRank) {
      throw ApiError.invalid(
        'you cannot require a higher role than your own to read this credential',
      );
    }

    const touchesSecret =
      body.label !== undefined ||
      body.sensitivity !== undefined ||
      body.requiresStepUp !== undefined ||
      body.requiresReason !== undefined ||
      body.minRoleRank !== undefined ||
      body.rotationIntervalDays !== undefined;

    if (touchesSecret) {
      /*
       * A check-constraint violation here is a USER mistake, not a fault, and
       * it has to read like one. `critical` sensitivity requires both a
       * step-up and a written reason — a rule worth having and worth stating,
       * because an operator ticking "critical" in the form and receiving
       * "internal error" learns nothing and files a bug.
       */
      const [updated] = await tx<{ id: string }[]>`
        UPDATE secret SET
          label                  = COALESCE(${body.label ?? null}, label),
          sensitivity            = COALESCE(${body.sensitivity ?? null}::secret_sensitivity, sensitivity),
          requires_step_up       = COALESCE(${body.requiresStepUp ?? null}, requires_step_up),
          requires_reason        = COALESCE(${body.requiresReason ?? null}, requires_reason),
          min_role_rank          = COALESCE(${body.minRoleRank ?? null}, min_role_rank),
          rotation_interval_days = ${
            body.rotationIntervalDays === undefined
              ? tx`rotation_interval_days`
              : body.rotationIntervalDays
          },
          updated_at             = now(),
          updated_by             = ${identity.actorId}::uuid
        WHERE id = ${secretId.data}::uuid AND deleted_at IS NULL
        RETURNING id
      `.catch((error: unknown) => {
        if ((error as { constraint_name?: string }).constraint_name === 'secret_critical_requires_step_up') {
          throw ApiError.invalid(
            'a credential marked critical must also require re-authentication and a written reason to reveal',
          );
        }
        throw error;
      });
      // RLS refused the write even though the read succeeded: the actor can see
      // this credential but may not change it.
      if (!updated) throw ApiError.forbidden('your role does not permit editing this credential');
    }

    const touchesNode =
      body.name !== undefined ||
      body.username !== undefined ||
      body.url !== undefined ||
      body.notes !== undefined ||
      body.credentialType !== undefined ||
      body.criticality !== undefined ||
      body.isBreakGlass !== undefined ||
      body.siteId !== undefined;

    if (touchesNode && existing.node_id) {
      await tx`
        UPDATE asset_node SET
          name        = COALESCE(${body.name ?? null}, name),
          notes       = ${body.notes === undefined ? tx`notes` : body.notes},
          criticality = COALESCE(${body.criticality ?? null}, criticality),
          site_id     = ${body.siteId === undefined ? tx`site_id` : body.siteId},
          updated_at  = now(),
          updated_by  = ${identity.actorId}::uuid
        WHERE id = ${existing.node_id}::uuid
      `;
      await tx`
        UPDATE credential SET
          username        = ${body.username === undefined ? tx`username` : body.username},
          url             = ${body.url === undefined ? tx`url` : body.url},
          credential_type = COALESCE(${body.credentialType ?? null}::credential_type, credential_type),
          is_break_glass  = COALESCE(${body.isBreakGlass ?? null}, is_break_glass)
        WHERE id = ${existing.node_id}::uuid
      `;
    }

    /*
     * Audited by name, because the interesting edits here are to the ACCESS
     * POLICY. "Who dropped the step-up requirement on the domain admin
     * password" is a question this has to be able to answer, and the answer
     * cannot be reconstructed from a row that only carries its current state.
     *
     * The keys are recorded, never the values — `label` is fine but the list is
     * built from the request, and a policy of "log what changed, not what to"
     * needs no exception for the one field that might carry something.
     */
    await tx`
      SELECT helm.audit(
        'secret.updated', 'secret', ${secretId.data}::uuid, 'success'::audit_outcome,
        NULL, ${existing.node_id}::uuid, NULL,
        ${tx.json({ fields: Object.keys(body).sort() })}::jsonb)
    `;

    return { updated: true, fields: Object.keys(body).sort() };
  },
  { permissions: ['secret:write'] },
);

export const dynamic = 'force-dynamic';
