import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { translate } from '../route';

const patchSchema = z
  .object({
    roleKey: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,40}$/, 'not a role key')
      .optional(),
    orgScopeAll: z.boolean().optional(),
    orgScope: z.array(z.guid()).max(200).optional(),
    requireStepUp: z.boolean().optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' })
  .refine(
    (v) =>
      // Scope is one decision expressed in two columns, and the table's CHECK
      // rejects the halfway states. Changing one without the other is almost
      // always a caller that forgot, so it is refused here where the message
      // can say which field is missing.
      v.orgScopeAll === undefined || v.orgScopeAll || (v.orgScope?.length ?? 0) > 0,
    { message: 'pinning a membership needs at least one organisation', path: ['orgScope'] },
  );

/**
 * PATCH /api/users/[userId] — change somebody's role, scope or status.
 *
 * Two refusals live here rather than in the database, because both are about
 * avoiding an accident rather than stopping an attacker:
 *
 *   You cannot edit your own membership. Not because it is dangerous — the
 *   trigger already stops you granting yourself anything above your own rank —
 *   but because the useful things you could do to it are demoting or suspending
 *   yourself, and an administrator who does that by accident may be the last
 *   one with user:write. Somebody else changes your access.
 *
 *   You cannot suspend the last active member who can manage users. That is a
 *   tenant nobody can administer, recoverable only from a psql prompt.
 *
 * Everything about RANK is the trigger's, not this route's.
 */
export const PATCH = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const userId = z.guid().safeParse(params.userId);
    if (!userId.success) throw ApiError.invalid('not a user id');

    if (userId.data === identity.actorId) {
      throw ApiError.forbidden(
        'you cannot change your own access — ask another administrator, so a mistake here cannot lock the tenant',
      );
    }

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid changes', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    if (body.status === 'suspended') await refuseIfLastAdministrator(tx, userId.data);

    try {
      const [updated] = await tx<{ user_id: string; role_key: string; status: string }[]>`
        UPDATE membership SET
          role_key        = COALESCE(${body.roleKey ?? null}, role_key),
          org_scope_all   = COALESCE(${body.orgScopeAll ?? null}, org_scope_all),
          org_scope       = CASE
                              WHEN ${body.orgScopeAll ?? null}::boolean IS TRUE THEN NULL
                              WHEN ${body.orgScope ?? null}::uuid[] IS NOT NULL
                                THEN ${body.orgScope ?? null}::uuid[]
                              ELSE org_scope
                            END,
          require_step_up = COALESCE(${body.requireStepUp ?? null}, require_step_up),
          expires_at      = ${body.expiresAt === undefined ? tx`expires_at` : body.expiresAt},
          status          = COALESCE(${body.status ?? null}::membership_status, status),
          updated_at      = now()
        WHERE user_id = ${userId.data}::uuid
        RETURNING user_id, role_key, status::text AS status
      `;
      if (!updated) throw ApiError.invalid('that person has no access to this tenant');

      return {
        membership: {
          userId: updated.user_id,
          roleKey: updated.role_key,
          status: updated.status,
        },
      };
    } catch (error) {
      throw translate(error);
    }
  },
  { permissions: ['user:write'] },
);

/**
 * DELETE /api/users/[userId] — revoke access to this tenant.
 *
 * The membership row is kept and marked revoked rather than deleted. Audit rows
 * reference the actor, and "who was this person and what could they do when
 * they revealed that credential" must still have an answer a year later. A
 * DELETE would cascade that answer away.
 *
 * The person's account survives too: they may hold access to other tenants, and
 * this tenant's administrator has no business deleting a deployment-level row.
 */
export const DELETE = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const userId = z.guid().safeParse(params.userId);
    if (!userId.success) throw ApiError.invalid('not a user id');

    if (userId.data === identity.actorId) {
      throw ApiError.forbidden('you cannot revoke your own access — ask another administrator');
    }

    await refuseIfLastAdministrator(tx, userId.data);

    const reason = new URL(request.url).searchParams.get('reason')?.slice(0, 500) ?? null;

    try {
      const [revoked] = await tx<{ user_id: string }[]>`
        UPDATE membership SET
          status         = 'revoked',
          revoked_at     = now(),
          revoked_reason = ${reason},
          updated_at     = now()
        WHERE user_id = ${userId.data}::uuid AND revoked_at IS NULL
        RETURNING user_id
      `;
      if (!revoked) throw ApiError.invalid('that person has no active access to this tenant');

      // Their sessions go with it — through a function, because auth_session
      // belongs to helm_auth and the request role cannot touch it (0350). It
      // is a no-op if they still hold active access to another tenant, since
      // sessions are not tenant-scoped.
      await tx`SELECT helm.end_sessions_if_no_access(${userId.data}::uuid)`;

      return { userId: revoked.user_id, revoked: true };
    } catch (error) {
      throw translate(error);
    }
  },
  { permissions: ['user:write'] },
);

/**
 * Refuse to remove the last person who can manage users.
 *
 * Counted from role_permission rather than from a hard-coded list of roles, so
 * a deployment that adds its own role holding user:write is counted correctly.
 */
async function refuseIfLastAdministrator(
  tx: Parameters<Parameters<typeof tenantRoute>[0]>[0]['tx'],
  userId: string,
): Promise<void> {
  const [row] = await tx<{ remaining: string }[]>`
    SELECT count(*)::text AS remaining
    FROM membership m
    JOIN role_permission rp ON rp.role_key = m.role_key AND rp.permission_key = 'user:write'
    WHERE m.status = 'active'
      AND m.revoked_at IS NULL
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND m.user_id <> ${userId}::uuid
  `;
  if (row && Number(row.remaining) === 0) {
    throw ApiError.invalid(
      'that is the last person who can manage users in this tenant — promote somebody else first',
    );
  }
}

export const dynamic = 'force-dynamic';
