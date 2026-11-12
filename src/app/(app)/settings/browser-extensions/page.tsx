import { Puzzle } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TenantBrowsersTable } from '@/components/tenant-browsers-table';
import { listTenantBrowsers } from '@/lib/extension/pairing';
import { readExtensionPolicy } from '@/lib/extension/policy';
import { ExtensionPolicyCard } from '@/components/extension-policy-card';

export const dynamic = 'force-dynamic';

/**
 * Administration → Browser extensions: every browser paired with Helm in this
 * MSP, and revoking one (1121). For somebody who manages people (user:write),
 * as revoking somebody's browser is the same kind of act as disabling them.
 */
export default async function BrowserExtensionsSettingsPage() {
  const identity = await getServerIdentity();
  const { browsers, policy } = await withTenant(actorOf(identity), async (tx, session) =>
    session.permissions.includes('user:write')
      ? { browsers: await listTenantBrowsers(tx), policy: await readExtensionPolicy(tx) }
      : { browsers: null, policy: null });

  return (
    <>
      <PageHeader
        title="Browser extensions"
        description="Every browser paired with the Helm extension, whose it is, when it was last used, and revoking one."
        trail={[{ label: 'Administration', href: '/settings' }]}
      />
      <PageBody>
        <AdminNav />
        {policy && <ExtensionPolicyCard initial={policy} />}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Puzzle className="size-4 text-ink-faint" aria-hidden /> Paired browsers
            </CardTitle>
          </CardHeader>
          <CardContent>
            {browsers ? (
              <TenantBrowsersTable browsers={browsers} />
            ) : (
              <p className="text-sm text-ink-muted">
                Seeing and revoking everybody&rsquo;s paired browsers needs the permission to manage
                people. Your own are under Personal → Browser extension.
              </p>
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
