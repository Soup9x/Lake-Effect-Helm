import Link from 'next/link';
import {
  Activity, Boxes, Bot, Building, CalendarClock, Globe, KeyRound, PanelLeft, ShieldCheck,
} from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { InlineRename } from '@/components/inline-rename';
import { SidebarCustomise } from '@/components/sidebar-customise';
import { ExternalChecksForm } from '@/components/external-checks-form';
import { HealthWindowForm } from '@/components/health-window-form';
import { ExpiryAlertForm } from '@/components/expiry-alert-form';
import { readExpiryAlertSetting } from '@/lib/alerts/queries';
import { readHealthSetting } from '@/lib/health/queries';
import { readSmtpSetting } from '@/lib/email/settings';
import { SmtpSettingsCard } from '@/components/smtp-settings';
import { BackupSettingsCard } from '@/components/backup-settings';
import { backupCapabilities, listBackupRuns, readBackupSettings } from '@/lib/backups/settings';
import { readExternalCheckSetting } from '@/lib/external/settings';
import { readTenantSidebarDefault } from '@/lib/nav/sidebar-queries';
import { ORG_CATEGORIES } from '@/lib/nav/org-categories';
import { RadiusSettingsCard } from '@/components/radius-settings';
import { SessionPolicyCard } from '@/components/session-policy-settings';
import { readSessionPolicy } from '@/lib/auth/session-policy-settings';
import { OidcSettingsCard } from '@/components/oidc-settings';
import { NotificationSettingsCard } from '@/components/notification-settings';
import { UnifiSettingsCard } from '@/components/unifi-settings';
import { NinjaSettingsCard } from '@/components/ninja-settings';
import { readNinjaSettings } from '@/lib/ninja/queries';
import { M365SettingsCard } from '@/components/m365-settings';
import { listM365Connections } from '@/lib/m365/queries';
import { listKeyCustody, listSystemWorkers, readTenantSummary } from '@/lib/tenant/queries';
import { readOidcSettings, readRadiusSettings } from '@/lib/auth/sign-in-settings';
import {
  listNotificationDestinations,
  listRecentDeliveries,
  NOTIFICATION_EVENTS,
} from '@/lib/notifications/queries';
import { listOrganizationOptions, listUnifiMappings } from '@/lib/unifi/queries';
import { listGrantableRoles, listServiceAccounts } from '@/lib/auth/service-accounts';
import { ServiceAccountsCard } from '@/components/service-accounts-card';
import { headers } from 'next/headers';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime } from '@/lib/ui/format';

/**
 * Deployment-wide settings: how people sign in, where the keys are, what the
 * network integrations are doing, and what the background workers may decrypt.
 *
 * The key custody panel exists because "could someone with root on the app
 * server read this client's credentials" is the first question of any breach
 * assessment, and reconstructing the answer from deployment history months
 * later is not a plan. `host_held_kek` is a generated column, so the answer
 * comes from the row rather than from configuration that may since have changed.
 *
 * Key rotation is `pnpm helm:rotate-kek` and worker authorisation is fixed by a
 * database trigger — deliberately, because a UI that can widen the sync
 * worker's reveal purposes is a UI that can hand it the vault.
 *
 * Personal settings are NOT here. This page is hidden from client-side roles
 * entirely, and "change my password" has to be reachable by everybody who can
 * sign in, so it lives on /account.
 */
export default async function SettingsPage() {
  const identity = await getServerIdentity();

  const head = await headers();
  const origin =
    process.env.AUTH_URL?.replace(/\/+$/, '') ??
    `${head.get('x-forwarded-proto') ?? 'https'}://${head.get('x-forwarded-host') ?? head.get('host') ?? 'localhost'}`;

  const {
    keys, workers, tenant, radius, oidc, destinations, deliveries,
    unifi, organizations, canManageNetwork, flexibleTypeCount,
    sidebarDefault, sidebarDefaultSet, externalChecks, healthWindow, smtp,
    expiryAlerts, canManageAlerts, serviceAccounts, grantableRoles, canReadUsers, canManageUsers, backups,
    sessionPolicy, ninja, canManageRmm, m365, canManageM365,
  } = await withTenant(actorOf(identity), async (tx, session) => {
    const canReadUsers = session.permissions.includes('user:read');
    const [keys, workers, tenant, radius, oidc, destinations, deliveries, unifi, organizations,
           networkRows, flexibleTypeRows, sidebarDefaultRow, externalChecks,
           healthWindow, smtp, expiryAlerts, alertPermissionRows, serviceAccounts, grantableRoles] = await Promise.all([
      listKeyCustody(tx),
      listSystemWorkers(tx),
      readTenantSummary(tx, identity.actorId),
      readRadiusSettings(tx),
      readOidcSettings(tx, origin),
      listNotificationDestinations(tx),
      listRecentDeliveries(tx),
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
      // Just the count: the card is a signpost, and the page itself fetches
      // the schemas it needs to open an editor.
      tx<{ n: number }[]>`SELECT count(*)::int AS n FROM flexible_asset_type`,
      // The default drawer layout, and whether anybody has actually set one.
      // One read answers both: the card says either "n of sixteen shown by
      // default" or "not set", which is the same list meaning two things.
      readTenantSidebarDefault(tx),
      // Whether Helm may reach outside, and how. Read unconditionally: "off"
      // is what the card needs to say, and an absent row means off.
      readExternalCheckSetting(tx),
      readHealthSetting(tx),
      // The mail relay, without its password: helm_app has no privilege on the
      // envelope columns, so `passwordSet` is a boolean the database computed.
      readSmtpSetting(tx),
      readExpiryAlertSetting(tx),
      tx<{ allowed: boolean }[]>`SELECT helm.has_permission('alert:manage') AS allowed`,
      // Machine identities and the roles this actor may give one. Both are
      // SECURITY DEFINER readers that check user:read themselves; skipped for
      // an actor without it so the card can be absent rather than a 403.
      canReadUsers ? listServiceAccounts(tx) : Promise.resolve([]),
      canReadUsers ? listGrantableRoles(tx) : Promise.resolve([]),
    ]);
    return {
      serviceAccounts, grantableRoles, canReadUsers,
      canManageUsers: session.permissions.includes('user:write'),
      // 0820: instance-wide, so only for somebody who may change it; the
      // functions refuse everyone else and the card would have nothing to say.
      backups: session.permissions.includes('tenant:write')
        ? { settings: await readBackupSettings(tx), runs: await listBackupRuns(tx, 20) }
        : null,
      // 0890: offered only to somebody who may change it, like the sign-in cards.
      sessionPolicy: session.permissions.includes('tenant:write') ? await readSessionPolicy(tx) : null,
      // 0980: readable by any tenant-wide role; the controls only for
      // somebody the routes and functions would let through.
      ninja: await readNinjaSettings(tx),
      canManageRmm: session.permissions.includes('integration:rmm:manage'),
      // 0990: the same arrangement, one row per connected client.
      m365: await listM365Connections(tx),
      canManageM365: session.permissions.includes('integration:m365:manage'),
      keys, workers, tenant, radius, oidc, destinations, deliveries, unifi, organizations,
      canManageNetwork: networkRows[0]?.permitted ?? false,
      flexibleTypeCount: flexibleTypeRows[0]?.n ?? 0,
      sidebarDefault: sidebarDefaultRow.categories,
      sidebarDefaultSet: sidebarDefaultRow.set,
      externalChecks, healthWindow, smtp, expiryAlerts,
      canManageAlerts: alertPermissionRows[0]?.allowed ?? false,
    };
  });

  const hostHeld = keys.some((key) => key.host_held_kek);
  const developmentKey = keys.some((key) => key.development_key);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Authentication, key custody, integration health and the identities your background jobs run as."
      />
      <PageBody>
        {tenant && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building className="size-4 text-ink-faint" aria-hidden /> This MSP
              </CardTitle>
            </CardHeader>
            <CardContent>
              {tenant.can_write_tenant ? (
                <InlineRename
                  currentName={tenant.name}
                  slug={tenant.slug}
                  endpoint="/api/tenant"
                  inputId="rename-tenant"
                  label="MSP name"
                  // The slug is what memberships and audit rows resolve
                  // through; a rebrand must not invalidate a year of history.
                  hint={
                    <>
                      The identifier <code className="font-mono">{tenant.slug}</code> stays as it
                      is — memberships and audit history resolve through it.
                    </>
                  }
                />
              ) : (
                <div>
                  <div className="text-ink">{tenant.name}</div>
                  <div className="text-xs text-ink-faint">{tenant.slug}</div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/*
          * The relay comes BEFORE the destinations that depend on it. An email
          * destination cannot be saved without one, and a page that offers the
          * dependent control first teaches people to hit the error.
          */}
        <SmtpSettingsCard initial={smtp} canManage={tenant?.can_write_tenant ?? false} />

        {backups && (
          <BackupSettingsCard
            initial={backups.settings}
            runs={backups.runs}
            capabilities={backupCapabilities()}
            canManage={tenant?.can_write_tenant ?? false}
          />
        )}

        <NotificationSettingsCard
          destinations={destinations}
          history={deliveries}
          events={NOTIFICATION_EVENTS}
          emailConfigured={smtp.enabled}
        />

        <UnifiSettingsCard
          mappings={unifi}
          organizations={organizations}
          canManage={canManageNetwork}
          // Same origin the OIDC redirect URI is built from, and for the same
          // reason: the only thing that knows the address a controller will
          // reach Helm on is the request, and a stored copy would drift.
          callbackBase={origin}
        />

        <NinjaSettingsCard initial={ninja} organizations={organizations} canManage={canManageRmm} />

        <M365SettingsCard initial={m365} organizations={organizations} canManage={canManageM365} />

        {sessionPolicy && <SessionPolicyCard initial={sessionPolicy} />}

        <OidcSettingsCard initial={oidc} />

        <RadiusSettingsCard initial={radius} />

        <Card className={developmentKey ? 'border-danger/40' : undefined}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-ink-faint" aria-hidden /> Key custody
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="max-w-3xl text-sm text-ink-muted">
              {developmentKey ? (
                <span className="text-danger">
                  At least one key in this tenant is wrapped by a <strong>development</strong> key.
                  This data is not protected to production standards. Rotate before it carries
                  client credentials.
                </span>
              ) : hostHeld ? (
                <>
                  The master key is held by this server. A database compromise alone — a stolen
                  dump, replica or backup — yields nothing usable. Root on this host, however,
                  can decrypt everything offline, with no record and no revocation point.
                </>
              ) : (
                <>
                  The master key never enters this process. Every unwrap is an API call recorded
                  by the key service, and revoking Helm&rsquo;s credential stops decryption
                  immediately.
                </>
              )}
            </p>

            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Generation</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>KEK</TableHead>
                  <TableHead>Host can read the KEK</TableHead>
                  <TableHead>Activated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.length === 0 && <TableEmpty colSpan={6}>No data key provisioned.</TableEmpty>}
                {keys.map((key) => (
                  <TableRow key={key.generation}>
                    <TableCell className="tabular-nums">{key.generation}</TableCell>
                    <TableCell>
                      <Badge tone={key.status === 'active' ? 'ok' : 'neutral'}>{key.status}</Badge>
                    </TableCell>
                    <TableCell className="text-ink-muted">{key.wrap_provider}</TableCell>
                    <TableCell className="font-mono text-xs text-ink-muted">{key.kek_id}</TableCell>
                    <TableCell>
                      <Badge tone={key.host_held_kek ? 'warning' : 'ok'}>
                        {key.host_held_kek ? 'Yes' : 'No'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-ink-muted">{formatDateTime(key.activated_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

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

        {/*
          Asset types get a card and their own page rather than living here.
          Defining one is a form with a variable number of rows, which is a
          page; the card is the signpost, because nobody looking for "where do
          I add a custom field" would think to look under Settings without one.
        */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Boxes className="size-4 text-ink-faint" aria-hidden /> Asset types
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="max-w-xl text-ink-muted">
              The documentation types this tenant defines for itself, beyond
              Helm&rsquo;s built-in ones. Each publishes an immutable schema
              version that records are validated against.
            </p>
            <Button asChild variant="secondary" size="sm">
              <Link href="/settings/asset-types">
                {flexibleTypeCount} defined
              </Link>
            </Button>
          </CardContent>
        </Card>

        {/*
          The default drawer, for people who have not arranged their own.
          Alongside Asset types because both answer "what does this tenant look
          like to everybody", and unlike that one it is a single ordered list,
          which is a dialog rather than a page.
        */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PanelLeft className="size-4 text-ink-faint" aria-hidden /> Default sidebar
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="max-w-xl space-y-1">
              <p className="text-ink-muted">
                Which client categories sit in the drawer, and in what order, for somebody who
                has not arranged their own. Everything else stays reachable under
                &ldquo;More&rdquo;.
              </p>
              <p className="text-ink-faint">
                {sidebarDefaultSet
                  ? `${sidebarDefault.length} of ${ORG_CATEGORIES.length} shown by default.`
                  : `Not set — new users get Helm's own default of ${sidebarDefault.length}.`}
              </p>
            </div>
            {/* Offered only to somebody tenant:write would let through, and the
                route and the RLS policy both check again. */}
            {tenant?.can_write_tenant ? (
              <SidebarCustomise
                scope="tenant"
                layout={sidebarDefault}
                trigger={
                  <Button variant="secondary" size="sm">
                    Edit default
                  </Button>
                }
              />
            ) : (
              <p className="text-xs text-ink-faint">Requires tenant settings access.</p>
            )}
          </CardContent>
        </Card>

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

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="size-4 text-ink-faint" aria-hidden /> Expiry warnings
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="max-w-xl space-y-1">
              <p className="text-ink-muted">
                When the team hears that a certificate, domain, warranty or contract is about
                to expire. Sent to every notification destination subscribed to
                &ldquo;Expiring soon&rdquo;.
              </p>
              <p className="text-ink-faint">
                {expiryAlerts.enabled
                  ? `On: ${expiryAlerts.leadDays.join(', ')} days before expiry.`
                  : 'Off: nothing is raised, whatever is subscribed.'}
              </p>
            </div>
            {canManageAlerts ? (
              <ExpiryAlertForm
                setting={expiryAlerts}
                trigger={
                  <Button variant="secondary" size="sm">
                    Edit
                  </Button>
                }
              />
            ) : (
              <p className="text-xs text-ink-faint">Requires alert management access.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4 text-ink-faint" aria-hidden /> Documentation health
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="max-w-xl space-y-1">
              <p className="text-ink-muted">
                Where the line falls between documentation that is current and documentation
                that has gone quiet. Shown as counts on each client, never as a score —
                Helm can see what has been documented, not what exists.
              </p>
              <p className="text-ink-faint">
                Stale after {healthWindow.staleAfterDays} days without an edit; unopened
                after {healthWindow.unviewedAfterDays} days without anybody looking.
                {!healthWindow.configured && ' Both are the shipped defaults.'}
              </p>
            </div>
            {tenant?.can_write_tenant ? (
              <HealthWindowForm
                setting={healthWindow}
                trigger={
                  <Button variant="secondary" size="sm">
                    {healthWindow.configured ? 'Edit' : 'Change'}
                  </Button>
                }
              />
            ) : (
              <p className="text-xs text-ink-faint">Requires tenant settings access.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-ink-faint" aria-hidden /> Your access
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <div className="text-ink-muted">Tenant</div>
              <div className="text-ink">{identity.tenantName}</div>
            </div>
            <div>
              <div className="text-ink-muted">Role</div>
              <div className="font-mono text-xs text-ink">{identity.roleKey}</div>
            </div>
            <div>
              <div className="text-ink-muted">Signed in as</div>
              <div className="text-ink">{identity.email}</div>
            </div>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
