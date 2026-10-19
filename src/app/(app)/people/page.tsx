import { Users } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { PeopleManager } from '@/components/people-manager';
import { RolesManager } from '@/components/roles-manager';
import { ACCESS_LEVELS, grantableRoles, listPermissions, listRoles } from '@/lib/roles/catalogue';

interface MemberRow {
  user_id: string;
  email: string;
  name: string | null;
  role_key: string;
  role_name: string;
  rank: number;
  status: string;
  org_scope_all: boolean;
  org_scope: string[] | null;
  last_login_at: Date | null;
}

/**
 * Who has access, and as what.
 *
 * Read in the page rather than fetched from /api/users, like every other page
 * here: one authorisation path, not two. The route exists for the writes the
 * client component makes.
 *
 * `grantableRoles` comes from helm.grantable_roles(): the caller's own rank and
 * every permission they hold, which is what the database enforces (0350, 0830). Sending the full list and filtering in the browser
 * would put a second, weaker copy of that rule where anybody can edit it.
 */
export default async function PeoplePage() {
  const identity = await getServerIdentity();

  const data = await withTenant(actorOf(identity), async (tx, session) => {
    const [me] = await tx<{ rank: number }[]>`
      SELECT r.rank
      FROM membership m JOIN app_role r ON r.key = m.role_key
      WHERE m.user_id = ${identity.actorId}::uuid
    `;
    const myRank = me?.rank ?? 0;

    const [members, roles, organizations, catalogue, permissions] = await Promise.all([
      tx<MemberRow[]>`
        SELECT m.user_id, u.email, u.name, m.role_key, r.name AS role_name, r.rank,
               m.status::text AS status, m.org_scope_all, m.org_scope, u.last_login_at
        FROM membership m
        JOIN app_user u ON u.id = m.user_id
        JOIN app_role r ON r.key = m.role_key
        ORDER BY r.rank DESC, u.email
      `,
      grantableRoles(tx),
      tx<{ id: string; name: string }[]>`
        SELECT id, name FROM organization
        WHERE deleted_at IS NULL AND NOT is_msp_internal
        ORDER BY name
      `,
      listRoles(tx),
      listPermissions(tx),
    ]);

    return {
      members, roles, organizations, myRank, catalogue, permissions,
      myPermissions: session.permissions,
      canWrite: session.permissions.includes('user:write'),
      canManageRoles: session.permissions.includes('tenant:write'),
    };
  });

  const grantable = new Set(data.roles.map((r) => r.key));

  return (
    <>
      <PageHeader
        title="People"
        description="Who can reach this tenant, and what they can do once they are in."
      />
      <PageBody>
        {data.members.length === 0 ? (
          <Card>
            <CardContent className="p-0">
              <EmptyState
                icon={Users}
                title="Nobody is visible"
                description="Your membership does not permit reading this tenant's people."
              />
            </CardContent>
          </Card>
        ) : (
          <PeopleManager
            canWrite={data.canWrite}
            members={data.members.map((m) => ({
              userId: m.user_id,
              email: m.email,
              name: m.name,
              roleKey: m.role_key,
              roleName: m.role_name,
              rank: m.rank,
              status: m.status,
              orgScopeAll: m.org_scope_all,
              orgScope: m.org_scope ?? [],
              lastLoginAt: m.last_login_at?.toISOString() ?? null,
              // Nobody edits their own membership, or one whose role outranks
              // them or carries a permission they lack (0350, 0830).
              editable: m.rank <= data.myRank && grantable.has(m.role_key) && m.user_id !== identity.actorId,
              isSelf: m.user_id === identity.actorId,
            }))}
            grantableRoles={data.roles}
            organizations={data.organizations}
          />
        )}
        <RolesManager
          roles={data.catalogue}
          permissions={data.permissions}
          levels={ACCESS_LEVELS}
          canManage={data.canManageRoles}
          myRank={data.myRank}
          myPermissions={data.myPermissions}
        />
      </PageBody>
    </>
  );
}

export const dynamic = 'force-dynamic';
