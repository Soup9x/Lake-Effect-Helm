import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { AdminNav } from '@/components/admin-nav';
import { Bot } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ServiceAccountsCard } from '@/components/service-accounts-card';
import { listGrantableRoles, listServiceAccounts } from '@/lib/auth/service-accounts';
import { listSystemWorkers } from '@/lib/tenant/queries';
import { listOrganizationOptions } from '@/lib/unifi/queries';

/**
 * Administration → Automation: service accounts for scripts and tools, and the
 * fixed identities the background jobs run as.
 */
export default async function AutomationSettingsPage() {
  const identity = await getServerIdentity();

  const {
    workers, organizations, serviceAccounts, grantableRoles, canReadUsers, canManageUsers,
  } = await withTenant(actorOf(identity), async (tx, session) => {
    const canReadUsers = session.permissions.includes('user:read');
    const [workers, organizations, serviceAccounts, grantableRoles] = await Promise.all([
      listSystemWorkers(tx),
      listOrganizationOptions(tx),
      // SECURITY DEFINER readers that check user:read themselves; skipped for
      // an actor without it so the card can be absent rather than a 403.
      canReadUsers ? listServiceAccounts(tx) : Promise.resolve([]),
      canReadUsers ? listGrantableRoles(tx) : Promise.resolve([]),
    ]);
    return {
      workers, organizations, serviceAccounts, grantableRoles, canReadUsers,
      canManageUsers: session.permissions.includes('user:write'),
    };
  });

  return (
    <>
      <PageHeader
        title="Automation"
        description="Service accounts for scripts and tools, and the identities background jobs run as."
        trail={[{ label: 'Administration', href: '/settings' }]}
      />
      <PageBody>
        <AdminNav />

        {canReadUsers && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bot className="size-4 text-ink-faint" aria-hidden /> Service accounts
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ServiceAccountsCard
                accounts={serviceAccounts}
                roles={grantableRoles}
                organizations={organizations}
                canManage={canManageUsers}
              />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="size-4 text-ink-faint" aria-hidden /> Background worker identities
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="max-w-3xl text-sm text-ink-muted">
              Each job runs as its own machine identity, pinned to the decryption purposes that job
              actually has. These cannot be edited from here or from anywhere else — the database
              refuses, because widening the sync worker&rsquo;s purposes would silently hand it
              every credential in the tenant.
            </p>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Identity</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>May decrypt</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workers.map((worker) => (
                  <TableRow key={worker.id}>
                    <TableCell className="font-medium">{worker.name}</TableCell>
                    <TableCell className="font-mono text-xs text-ink-muted">
                      {worker.role_key}
                    </TableCell>
                    <TableCell>
                      {worker.allowed_reveal_purposes === null ? (
                        <span className="text-xs text-ink-faint">Nothing — no secret access</span>
                      ) : (
                        worker.allowed_reveal_purposes.map((purpose) => (
                          <Badge key={purpose} tone="brand" className="mr-1">
                            {purpose}
                          </Badge>
                        ))
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge tone={worker.disabled_at ? 'neutral' : 'ok'}>
                        {worker.disabled_at ? 'Disabled' : 'Active'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}

export const dynamic = 'force-dynamic';
