import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent } from '@/components/ui/card';
import { UpdatesCard } from '@/components/updates-card';
import { getUpdateStatus } from '@/lib/updates/check';

/**
 * Administration → Updates: this build against the newest Helm on GitHub, and
 * how to apply it. tenant:write only, the same as the route it shares a cache
 * with.
 */
export default async function UpdatesSettingsPage() {
  const identity = await getServerIdentity();
  const canManage = await withTenant(actorOf(identity), async (_tx, session) =>
    session.permissions.includes('tenant:write'));

  return (
    <>
      <PageHeader
        title="Updates"
        description="Which version of Helm this is, what is newer on GitHub, and how to install it."
        trail={[{ label: 'Administration', href: '/settings' }]}
      />
      <PageBody>
        <AdminNav />
        {canManage ? (
          <UpdatesCard initial={await getUpdateStatus()} />
        ) : (
          <Card>
            <CardContent className="text-sm text-ink-muted">
              Updates are looked after by somebody with tenant settings access.
            </CardContent>
          </Card>
        )}
      </PageBody>
    </>
  );
}

export const dynamic = 'force-dynamic';
