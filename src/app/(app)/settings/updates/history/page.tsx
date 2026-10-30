import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { UpdatesTabs } from '@/components/updates-tabs';
import { UpdateTimeline } from '@/components/update-history';
import { listDeploys } from '@/lib/updates/history';
import { listUpdateRequests } from '@/lib/updates/requests';
import { readUpdateConfig } from '@/lib/updates/check';

/**
 * Administration → Updates → History: every version this server has run
 * (1220), who put it there and when. tenant:write only, like the rest of
 * Updates. Asks nothing of GitHub: what changed was recorded at deploy time.
 */
export default async function UpdateHistoryPage() {
  const identity = await getServerIdentity();
  const history = await withTenant(actorOf(identity), async (tx, session) =>
    session.permissions.includes('tenant:write')
      ? { deploys: await listDeploys(tx), requests: await listUpdateRequests(tx, 100) }
      : null);

  return (
    <>
      <PageHeader
        title="Updates"
        description="Which version of Helm this is, what is newer on GitHub, and how to install it."
        trail={[{ label: 'Administration', href: '/settings' }]}
      />
      <PageBody>
        <AdminNav />
        <UpdatesTabs active="/settings/updates/history" />
        {history ? (
          <Card>
            <CardHeader>
              <CardTitle>Update history</CardTitle>
            </CardHeader>
            <CardContent>
              <UpdateTimeline deploys={history.deploys} requests={history.requests} repo={readUpdateConfig().repo} />
            </CardContent>
          </Card>
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
