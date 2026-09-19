import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { translate } from '../../route';

/**
 * Per-user permission overrides.
 *
 * WHAT THIS TABLE IS. membership_permission sits on top of a role:
 * helm.set_session_context() unions its grants into the role's permissions,
 * subtracts its denies, and honours expires_at. That half has always worked and
 * is tested. What did not exist was any way to write to it from the product —
 * no route, no interface, nothing. A grant could only be made by someone with a
 * psql prompt, and 0480 established that it could then never be revoked through
 * the request path at all, because the table had no UPDATE or DELETE policy.
 *
 * WHY tenant:write RATHER THAN user:write. user:write is "manage the people in
 * this tenant" — invite somebody, change their role, end their membership.
 * Writing an override is a different act: it changes what the role catalogue
 * MEANS for one person, which is a change to the authority model rather than to
 * somebody's job. 0480 raised the gate on the table to match, and the reasoning
 * is set out there.
 *
 * WHAT THIS ROUTE DOES NOT ENFORCE, deliberately. Two rules decide whether a
 * grant is legitimate, and both live in the database (0480), not here:
 *
 *   nobody grants a permission they do not hold themselves;
 *   an MSP-only permission never reaches a client-side role.
 *
 * Re-implementing either would put the rule that decides who becomes an
 * administrator in the layer easiest to bypass. `grantable` below is derived
 * from the same two rules so the interface can offer the right list, but it is
 * a convenience for the picker — the database refuses regardless.
 */
const GRANT_SCHEMA = z.object({
  permissionKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/, 'not a permission key')
    .max(64),
  /** false writes a DENY, which subtracts from what the role would otherwise give. */
  granted: z.boolean(),
  /**
   * Required, and substantive. An override is an exception to the role
   * catalogue; six months later the only thing that explains it is this
   * sentence. The table already declares the column NOT NULL — this is what
   * stops it being filled with a space.
   */
  reason: z.string().trim().min(10).max(500),
  /** Optional expiry, for access granted "for the migration weekend". */
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

interface OverrideRow {
  permission_key: string;
  granted: boolean;
  reason: string;
  expires_at: Date | null;
  created_at: Date;
  granted_by_email: string | null;
  category: string;
  description: string;
  msp_only: boolean;
}

/** The membership this route is about, plus whether the target is client-side. */
async function targetMembership(
  tx: Parameters<Parameters<typeof tenantRoute>[0]>[0]['tx'],
  userId: string,
): Promise<{ id: string; roleKey: string; isTenantWide: boolean }> {
  const [row] = await tx<{ id: string; role_key: string; is_tenant_wide: boolean }[]>`
    SELECT m.id, m.role_key, r.is_tenant_wide
    FROM membership m JOIN app_role r ON r.key = m.role_key
    WHERE m.user_id = ${userId}::uuid
  `;
  if (!row) throw ApiError.notFound();
  return { id: row.id, roleKey: row.role_key, isTenantWide: row.is_tenant_wide };
}

/**
 * GET — this person's overrides, and what may be added to them.
 *
 * Only `user:read`, because seeing that somebody holds an exception is part of
 * reading the access model. Changing one is the privileged act.
 */
export const GET = tenantRoute(
  async ({ tx, params, session }) => {
    const userId = z.guid().safeParse(params.userId);
    if (!userId.success) throw ApiError.invalid('not a user id');

    const target = await targetMembership(tx, userId.data);

    const [overrides, catalogue] = await Promise.all([
      tx<OverrideRow[]>`
        SELECT mp.permission_key, mp.granted, mp.reason, mp.expires_at, mp.created_at,
               u.email AS granted_by_email,
               p.category, p.description, p.msp_only
        FROM membership_permission mp
        JOIN permission p ON p.key = mp.permission_key
        LEFT JOIN app_user u ON u.id = mp.granted_by
        WHERE mp.membership_id = ${target.id}::uuid
        ORDER BY p.category, mp.permission_key
      `,
      tx<{ key: string; category: string; description: string; msp_only: boolean }[]>`
        SELECT key, category, description, msp_only FROM permission
        ORDER BY category, key
      `,
    ]);

    /*
     * What the picker may offer, derived from the same two rules 0480 enforces.
     * The database refuses anything else regardless; this is so the interface
     * does not present a choice that is going to come back as an error.
     */
    const grantable = catalogue.filter(
      (p) => session.permissions.includes(p.key) && (target.isTenantWide || !p.msp_only),
    );

    return {
      roleKey: target.roleKey,
      /** Client-side roles can hold no MSP-only permission, by any route. */
      isClientSide: !target.isTenantWide,
      overrides: overrides.map((o) => ({
        permissionKey: o.permission_key,
        granted: o.granted,
        reason: o.reason,
        expiresAt: o.expires_at,
        createdAt: o.created_at,
        grantedBy: o.granted_by_email,
        category: o.category,
        description: o.description,
        mspOnly: o.msp_only,
      })),
      grantable: grantable.map((p) => ({
        key: p.key,
        category: p.category,
        description: p.description,
      })),
      /** Whether the caller may write here at all, so the UI can hide the controls. */
      canManage: session.permissions.includes('tenant:write'),
    };
  },
  { permissions: ['user:read'] },
);

/**
 * POST — grant or deny one permission for one person.
 *
 * An upsert rather than an insert: re-granting something already granted is a
 * correction to its reason or expiry, not a conflict to report.
 */
export const POST = tenantRoute(
  async ({ tx, request, params, identity }) => {
    const userId = z.guid().safeParse(params.userId);
    if (!userId.success) throw ApiError.invalid('not a user id');

    // The same refusal /api/users/[userId] makes, for the same reason: the
    // useful things you can do to your own access are the ones you cannot
    // undo, and an administrator who denies themselves tenant:write by accident
    // may be the last one holding it. The trigger in 0480 already stops the
    // dangerous direction; this stops the careless one.
    if (userId.data === identity.actorId) {
      throw ApiError.forbidden(
        'you cannot change your own permissions — ask another administrator, so a mistake here cannot lock the tenant',
      );
    }

    const body = await readJson(request, (raw) => {
      const result = GRANT_SCHEMA.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid permission override', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const target = await targetMembership(tx, userId.data);

    try {
      const [row] = await tx<{ permission_key: string; granted: boolean }[]>`
        INSERT INTO membership_permission
          (membership_id, permission_key, granted, reason, granted_by, expires_at)
        VALUES (
          ${target.id}::uuid, ${body.permissionKey}, ${body.granted}, ${body.reason},
          ${identity.actorId}::uuid, ${body.expiresAt ?? null}
        )
        ON CONFLICT (membership_id, permission_key) DO UPDATE SET
          granted    = EXCLUDED.granted,
          reason     = EXCLUDED.reason,
          granted_by = EXCLUDED.granted_by,
          expires_at = EXCLUDED.expires_at
        RETURNING permission_key, granted
      `;
      // RLS matched nothing: the caller can read this membership but may not
      // write its overrides.
      if (!row) throw ApiError.forbidden('your role does not permit changing permissions');

      /*
       * Audited explicitly. The row itself records granted_by and a reason, but
       * an override is an authority change and belongs in the same append-only
       * chain as every other one — "who gave the contractor secret:reveal" is a
       * question asked after the fact, by somebody reading the audit log rather
       * than the table.
       */
      await tx`
        SELECT helm.audit(
          ${body.granted ? 'membership.permission_granted' : 'membership.permission_denied'},
          'membership', ${target.id}::uuid, 'success'::audit_outcome,
          NULL, NULL, ${body.reason},
          ${tx.json({
            permission_key: body.permissionKey,
            subject_user_id: userId.data,
            role_key: target.roleKey,
            expires_at: body.expiresAt ?? null,
          })}::jsonb
        )
      `;

      return { permissionKey: row.permission_key, granted: row.granted };
    } catch (error) {
      throw translate(error);
    }
  },
  { permissions: ['tenant:write'] },
);

/**
 * DELETE — remove an override entirely, so the role decides again.
 *
 * Distinct from writing a deny: a deny SUBTRACTS a permission the role grants,
 * whereas removing the row returns the person to whatever their role says. The
 * interface offers both because they are different intentions.
 */
export const DELETE = tenantRoute(
  async ({ tx, request, params, identity }) => {
    const userId = z.guid().safeParse(params.userId);
    if (!userId.success) throw ApiError.invalid('not a user id');

    if (userId.data === identity.actorId) {
      throw ApiError.forbidden('you cannot change your own permissions');
    }

    const permissionKey = new URL(request.url).searchParams.get('permission') ?? '';
    if (!/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(permissionKey)) {
      throw ApiError.invalid('a permission key is required');
    }

    const target = await targetMembership(tx, userId.data);

    const [removed] = await tx<{ permission_key: string; granted: boolean }[]>`
      DELETE FROM membership_permission
      WHERE membership_id = ${target.id}::uuid AND permission_key = ${permissionKey}
      RETURNING permission_key, granted
    `;
    // Before 0480 this route could not have existed: with no DELETE policy the
    // statement affected zero rows and reported success, so a revoke button
    // would have said "done" and changed nothing.
    if (!removed) throw ApiError.notFound();

    await tx`
      SELECT helm.audit(
        'membership.permission_revoked', 'membership', ${target.id}::uuid,
        'success'::audit_outcome, NULL, NULL, 'override removed',
        ${tx.json({
          permission_key: permissionKey,
          subject_user_id: userId.data,
          role_key: target.roleKey,
          was_granted: removed.granted,
        })}::jsonb
      )
    `;

    return { permissionKey: removed.permission_key, removed: true };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
