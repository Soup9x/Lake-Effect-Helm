import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent } from '@/components/ui/card';
import { BackupSettingsCard } from '@/components/backup-settings';
import { backupCapabilities, listBackupRuns, readBackupSettings } from '@/lib/backups/settings';
import { readTenantSummary } from '@/lib/tenant/queries';

/**
 * Administration → Backups: where they go, how often, and the restore rehearsal.
 */
export default async function BackupSettingsPage() {
  const identity = await getServerIdentity();

  const {
    tenant, backups,
  } = await withTenant(actorOf(identity), async (tx, session) => {
    const tenant = await readTenantSummary(tx, identity.actorId);
    return {
      tenant,
      // 0820: instance-wide, so only for somebody who may change it; the
      // functions refuse everyone else and the card would have nothing to say.
      backups: session.permissions.includes('tenant:write')
        ? { settings: await readBackupSettings(tx), runs: await listBackupRuns(tx, 20) }
        : null,
    };
  });

  return (
    <>
      <PageHeader
        title="Backups"
        description="Where backups are written, how long they are kept, and the weekly restore rehearsal."
        trail={[{ label: 'Administration', href: '/settings' }]}
      />
      <PageBody>
        <AdminNav />

        {backups && (
          <BackupSettingsCard
            initial={backups.settings}
            runs={backups.runs}
            capabilities={backupCapabilities()}
            canManage={tenant?.can_write_tenant ?? false}
          />
        )}

        {!backups && (
          <Card>
            <CardContent className="text-sm text-ink-muted">
              Backups are configured by somebody with tenant settings access.
            </CardContent>
          </Card>
        )}
      </PageBody>
    </>
  );
}

export const dynamic = 'force-dynamic';
