import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { AdminNav } from '@/components/admin-nav';
import { Globe } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ExternalChecksForm } from '@/components/external-checks-form';
import { UnifiSettingsCard } from '@/components/unifi-settings';
import { NinjaSettingsCard } from '@/components/ninja-settings';
import { M365SettingsCard } from '@/components/m365-settings';
import { readNinjaSettings } from '@/lib/ninja/queries';
import { listM365Connections } from '@/lib/m365/queries';
import { readExternalCheckSetting } from '@/lib/external/settings';
import { listOrganizationOptions, listUnifiMappings } from '@/lib/unifi/queries';
import { readTenantSummary } from '@/lib/tenant/queries';
import { requestOrigin } from '@/lib/settings/origin';

/**
 * Administration → Integrations: NinjaOne, Microsoft 365, UniFi, and whether
 * Helm checks domains and certificates itself.
 */
export default async function IntegrationSettingsPage() {
  const identity = await getServerIdentity();
  const origin = await requestOrigin();

  const {
    tenant, unifi, organizations, externalChecks, ninja, m365, canManageNetwork, canManageRmm, canManageM365,
  } = await withTenant(actorOf(identity), async (tx, session) => {
    const [tenant, unifi, organizations, networkRows, externalChecks, ninja, m365] = await Promise.all([
      readTenantSummary(tx, identity.actorId),
      listUnifiMappings(tx),
      listOrganizationOptions(tx),
      // Mirrors the route's gate, so the editing controls are only offered to
      // somebody they would work for. The route and the database both check
      // again; this only decides what is rendered.
      tx<{ permitted: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM membership m
          JOIN role_permission rp ON rp.role_key = m.role_key
          WHERE m.user_id = ${identity.actorId}::uuid
            AND rp.permission_key = 'integration:network:manage') AS permitted
      `,
      // Whether Helm may reach outside, and how. Read unconditionally: "off"
      // is what the card needs to say, and an absent row means off.
      readExternalCheckSetting(tx),
      readNinjaSettings(tx),
      listM365Connections(tx),
    ]);
    return {
      tenant, unifi, organizations, externalChecks, ninja, m365,
      canManageNetwork: networkRows[0]?.permitted ?? false,
      canManageRmm: session.permissions.includes('integration:rmm:manage'),
      canManageM365: session.permissions.includes('integration:m365:manage'),
    };
  });

  return (
    <>
      <PageHeader
        title="Integrations"
        description="NinjaOne, Microsoft 365, UniFi, and domain and certificate checking."
        trail={[{ label: 'Administration', href: '/settings' }]}
      />
      <PageBody>
        <AdminNav />

        <NinjaSettingsCard initial={ninja} organizations={organizations} canManage={canManageRmm} />

        <M365SettingsCard initial={m365} organizations={organizations} canManage={canManageM365} />

        <UnifiSettingsCard
          mappings={unifi}
          organizations={organizations}
          canManage={canManageNetwork}
          // Same origin the OIDC redirect URI is built from, and for the same
          // reason: the only thing that knows the address a controller will
          // reach Helm on is the request, and a stored copy would drift.
          callbackBase={origin}
        />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="size-4 text-ink-faint" aria-hidden /> Domain and certificate checking
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="max-w-xl space-y-1">
              <p className="text-ink-muted">
                Refresh what the registry says about a domain&rsquo;s expiry, and what a server is
                actually serving for a certificate. Recorded beside what somebody entered rather
                than over it, so a disagreement is visible on the asset.
              </p>
              <p className="text-ink-faint">
                {/*
                  "Off" is stated as a complete answer, not as something missing.
                  Decision 4: an air-gapped install must keep working with zero
                  configuration, so there is nothing here nudging anybody to
                  enable outbound traffic.
                */}
                {externalChecks.domainsEnabled || externalChecks.certificatesEnabled
                  ? `${[
                      externalChecks.domainsEnabled ? 'domains' : null,
                      externalChecks.certificatesEnabled ? 'certificates' : null,
                    ].filter(Boolean).join(' and ')} every ${externalChecks.intervalHours}h`
                  : 'Off. Nothing leaves this network, and manual entry is the only source.'}
              </p>
            </div>
            {tenant?.can_write_tenant ? (
              <ExternalChecksForm
                setting={externalChecks}
                trigger={
                  <Button variant="secondary" size="sm">
                    {externalChecks.configured ? 'Edit' : 'Set up'}
                  </Button>
                }
              />
            ) : (
              <p className="text-xs text-ink-faint">Requires tenant settings access.</p>
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}

export const dynamic = 'force-dynamic';
