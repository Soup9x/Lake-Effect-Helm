import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

interface MemberRow {
  user_id: string;
  email: string;
  name: string | null;
  disabled_at: Date | null;
  role_key: string;
  role_name: string;
  rank: number;
  status: string;
  org_scope_all: boolean;
  org_scope: string[] | null;
  require_step_up: boolean;
  expires_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

/**
 * GET /api/users — who has access to this tenant, and as what.
 *
 * Returns memberships, not users. A person is a deployment-level row that may
 * belong to several tenants; what this tenant's administrator may see is who
 * can reach THIS tenant. `membership`'s policy already scopes it, and
 * `user:read` is what widens it beyond your own row.
 *
 * `grantableRoles` comes back with the list: every role at or below the
 * caller's own rank. The interface needs it to populate a picker, and deriving
 * it here rather than in the browser means one answer rather than two that can
 * disagree — the database refuses anything above it regardless (0350).
 */
export const GET = tenantRoute(
  async ({ tx, identity }) => {
    const [me] = await tx<{ rank: number }[]>`
      SELECT r.rank
      FROM membership m JOIN app_role r ON r.key = m.role_key
      WHERE m.user_id = ${identity.actorId}::uuid AND m.tenant_id = ${identity.tenantId}::uuid
    `;
    const myRank = me?.rank ?? 0;

    const [members, roles] = await Promise.all([
      tx<MemberRow[]>`
        SELECT m.user_id, u.email, u.name, u.disabled_at,
               m.role_key, r.name AS role_name, r.rank,
               m.status::text AS status, m.org_scope_all, m.org_scope,
               m.require_step_up, m.expires_at, u.last_login_at, m.created_at
        FROM membership m
        JOIN app_user u ON u.id = m.user_id
        JOIN app_role r ON r.key = m.role_key
        ORDER BY r.rank DESC, u.email
      `,
      tx<{ key: string; name: string; rank: number; is_tenant_wide: boolean }[]>`
        SELECT key, name, rank, is_tenant_wide FROM app_role
        WHERE rank <= ${myRank} ORDER BY rank DESC
      `,
    ]);

    return {
      members: members.map((m) => ({
        userId: m.user_id,
        email: m.email,
        name: m.name,
        disabled: m.disabled_at !== null,
        roleKey: m.role_key,
        roleName: m.role_name,
        rank: m.rank,
        status: m.status,
        orgScopeAll: m.org_scope_all,
        orgScope: m.org_scope ?? [],
        requireStepUp: m.require_step_up,
        expiresAt: m.expires_at,
        lastLoginAt: m.last_login_at,
        createdAt: m.created_at,
        // What the interface may offer for THIS row. Nobody edits a membership
        // that outranks them, which is the same rule the trigger applies to
        // every column.
        editable: m.rank <= myRank && m.user_id !== identity.actorId,
      })),
      grantableRoles: roles.map((r) => ({
        key: r.key,
        name: r.name,
        rank: r.rank,
        isTenantWide: r.is_tenant_wide,
      })),
      myRank,
    };
  },
  { permissions: ['user:read'] },
);

const inviteSchema = z
  .object({
    email: z.email('a valid email address is required').max(254),
    name: z.string().trim().max(200).optional(),
    roleKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'not a role key'),
    /** Tenant-wide, or pinned to these organisations. Never both. */
    orgScopeAll: z.boolean().default(false),
    orgScope: z.array(z.guid()).max(200).default([]),
    requireStepUp: z.boolean().default(true),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .refine((v) => v.orgScopeAll !== (v.orgScope.length > 0), {
    message: 'give either tenant-wide scope or at least one organisation, not both and not neither',
    path: ['orgScope'],
  });

/**
 * POST /api/users — give somebody access to this tenant.
 *
 * A person is deployment-level and a membership is per tenant, so inviting an
 * address that already has an account attaches a membership to that account
 * rather than creating a second one. Two `app_user` rows for one human would
 * mean two audit trails for one person, which defeats the point of having one.
 *
 * Nothing here checks rank. The trigger added in 0350 does, for every writer —
 * this route, a future one, a maintenance script, a psql session as helm_app.
 * The insufficient_privilege it raises is translated below into something an
 * administrator can act on, and that translation is the only thing this route
 * contributes to the decision.
 *
 * `is_platform_admin` is absent from the schema deliberately. It is a
 * deployment-level flag that crosses tenants, so no tenant's administrator can
 * grant it — not even their own tenant's most senior one.
 */
export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = inviteSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid invitation', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const email = body.email.trim().toLowerCase();

    // Find or create the person.
    //
    // Through a function rather than an INSERT, because helm_app cannot see an
    // app_user with no membership in THIS tenant (app_user_rls_select) and has
    // no INSERT policy on the table at all. helm.upsert_invitee() is
    // SECURITY DEFINER, requires a session context, and checks user:write
    // itself — see 0350.
    let person: { id: string } | undefined;
    try {
      [person] = await tx<{ id: string }[]>`
        SELECT helm.upsert_invitee(${email}::citext, ${body.name ?? null}) AS id
      `;
    } catch (error) {
      throw translate(error);
    }
    if (!person?.id) throw ApiError.conflict('the account could not be created');

    try {
      const [membership] = await tx<{ id: string }[]>`
        INSERT INTO membership (
          tenant_id, user_id, role_key, org_scope_all, org_scope,
          require_step_up, expires_at, invited_by
        )
        VALUES (
          ${identity.tenantId}::uuid, ${person.id}::uuid, ${body.roleKey},
          ${body.orgScopeAll}, ${body.orgScopeAll ? null : body.orgScope},
          ${body.requireStepUp}, ${body.expiresAt ?? null}, ${identity.actorId}::uuid
        )
        RETURNING id
      `;
      if (!membership) throw ApiError.conflict('the membership could not be created');

      return { userId: person.id, membershipId: membership.id, email };
    } catch (error) {
      throw translate(error);
    }
  },
  { permissions: ['user:write'] },
);

/**
 * Turn the trigger's and the constraints' errors into something actionable.
 *
 * Re-thrown unchanged if unrecognised: inventing a friendly message for an
 * error nobody anticipated is how a real failure gets reported as a typo.
 */
export function translate(error: unknown): unknown {
  const e = error as { code?: string; message?: string; constraint_name?: string };
  switch (e.code) {
    case '42501': // insufficient_privilege — the rank guard in 0350
      return ApiError.forbidden(e.message?.replace(/^helm: /, '') ?? 'that role outranks you');
    case '23514': // check_violation — a client role given tenant-wide scope
      return ApiError.invalid(
        e.message?.replace(/^helm: /, '') ??
          'that role must be pinned to specific organisations',
      );
    case '23505': // unique_violation — membership_user_tenant_uk
      return ApiError.conflict('that person already has access to this tenant');
    case '23503': // foreign_key_violation — no such role, or no such organisation
      return ApiError.invalid(e.message?.replace(/^helm: /, '') ?? 'no such role or organisation');
    default:
      return error;
  }
}

export const dynamic = 'force-dynamic';
