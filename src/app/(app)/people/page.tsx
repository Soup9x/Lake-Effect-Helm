import { Users } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { PeopleManager } from '@/components/people-manager';

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
 * `grantableRoles` is derived from the caller's own rank, which is what the
 * database enforces (0350). Sending the full list and filtering in the browser
 * would put a second, weaker copy of that rule where anybody can edit it.
 */
export default async function PeoplePage() {
  const identity = await getServerIdentity();

  const data = await withTenant(actorOf(identity), async (tx) => {
    const [me] = await tx<{ rank: number; can_write: boolean }[]>`
      SELECT r.rank,
             EXISTS (SELECT 1 FROM role_permission rp
                     WHERE rp.role_key = m.role_key
                       AND rp.permission_key = 'user:write') AS can_write
      FROM membership m JOIN app_role r ON r.key = m.role_key
      WHERE m.user_id = ${identity.actorId}::uuid
    `;
    const myRank = me?.rank ?? 0;

    const [members, roles, organizations] = await Promise.all([
      tx<MemberRow[]>`
        SELECT m.user_id, u.email, u.name, m.role_key, r.name AS role_name, r.rank,
               m.status::text AS status, m.org_scope_all, m.org_scope, u.last_login_at
        FROM membership m
        JOIN app_user u ON u.id = m.user_id
        JOIN app_role r ON r.key = m.role_key
        ORDER BY r.rank DESC, u.email
      `,
      tx<{ key: string; name: string; rank: number; is_tenant_wide: boolean }[]>`
        SELECT key, name, rank, is_tenant_wide FROM app_role
        WHERE rank <= ${myRank} ORDER BY rank DESC
      `,
      tx<{ id: string; name: string }[]>`
        SELECT id, name FROM organization
        WHERE deleted_at IS NULL AND NOT is_msp_internal
        ORDER BY name
      `,
    ]);

    return { members, roles, organizations, myRank, canWrite: me?.can_write ?? false };
  });

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
              // Nobody edits a membership that outranks them, or their own.
              editable: m.rank <= data.myRank && m.user_id !== identity.actorId,
            }))}
            grantableRoles={data.roles.map((r) => ({
              key: r.key,
              name: r.name,
              rank: r.rank,
              isTenantWide: r.is_tenant_wide,
            }))}
            organizations={data.organizations}
          />
        )}
      </PageBody>
    </>
  );
}

export const dynamic = 'force-dynamic';
