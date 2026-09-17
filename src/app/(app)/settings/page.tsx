import { KeyRound, Plug, ShieldCheck, Bot, Building } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RenameTenant } from '@/components/rename-tenant';
import { RadiusSettingsCard, type RadiusSettings } from '@/components/radius-settings';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime, humanise } from '@/lib/ui/format';

interface KeyRow {
  generation: number;
  status: string;
  wrap_provider: string;
  kek_id: string;
  host_held_kek: boolean;
  development_key: boolean;
  activated_at: Date | null;
}

interface IntegrationRow {
  id: string; provider: string; display_name: string; status: string;
  sync_enabled: boolean; last_sync_at: Date | null; last_success_at: Date | null;
  consecutive_failures: number; last_error: string | null; respect_manual_edits: boolean;
}

interface WorkerRow {
  id: string; name: string; role_key: string;
  allowed_reveal_purposes: string[] | null; disabled_at: Date | null;
}

function integrationTone(status: string): BadgeTone {
  switch (status) {
    case 'active':
      return 'ok';
    case 'degraded':
      return 'warning';
    case 'error':
      return 'danger';
    default:
      return 'neutral';
  }
}

interface RadiusRow {
  enabled: boolean;
  host: string;
  port: number;
  timeout_ms: number;
  retries: number;
  nas_identifier: string;
  secret_set: boolean;
  last_test_at: Date | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
}

function toRadiusSettings(row: RadiusRow | null): RadiusSettings | null {
  if (!row) return null;
  return {
    configured: true,
    enabled: row.enabled,
    host: row.host,
    port: row.port,
    timeoutMs: row.timeout_ms,
    retries: row.retries,
    nasIdentifier: row.nas_identifier,
    secretSet: row.secret_set,
    lastTestAt: row.last_test_at?.toISOString() ?? null,
    lastTestOk: row.last_test_ok,
    lastTestError: row.last_test_error,
  };
}

/**
 * Deployment-wide settings: how people sign in, where the keys are, what the
 * integrations are doing, and what the background workers may decrypt.
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

  const { keys, integrations, workers, tenant, radius } = await withTenant(actorOf(identity), async (tx) => {
    const [keyRows, integrationRows, workerRows, tenantRows, radiusRows] = await Promise.all([
      tx<KeyRow[]>`SELECT * FROM helm.key_custody()`,
      tx<IntegrationRow[]>`
        SELECT id, provider::text, display_name, status::text, sync_enabled,
               last_sync_at, last_success_at, consecutive_failures, last_error,
               respect_manual_edits
        FROM integration_connection WHERE disabled_at IS NULL ORDER BY display_name
      `,
      tx<WorkerRow[]>`
        SELECT id, name, role_key, allowed_reveal_purposes, disabled_at
        FROM service_account WHERE is_system ORDER BY name
      `,
      // tenant_rls_select restricts this to the current tenant, so no
      // predicate is needed and adding one would imply the policy were
      // optional. can_rename mirrors the route's permission so the control is
      // only offered to somebody it would work for.
      tx<{ name: string; slug: string; can_rename: boolean }[]>`
        SELECT t.name, t.slug,
               EXISTS (SELECT 1 FROM membership m
                       JOIN role_permission rp ON rp.role_key = m.role_key
                       WHERE m.user_id = ${identity.actorId}::uuid
                         AND rp.permission_key = 'tenant:write') AS can_rename
        FROM tenant t
      `,
      // Settings only, never the shared secret: helm_app cannot read that
      // column, and this function's result type does not contain it.
      tx<RadiusRow[]>`SELECT * FROM helm.radius_settings()`,
    ]);
    return {
      keys: keyRows,
      integrations: integrationRows,
      workers: workerRows,
      tenant: tenantRows[0] ?? null,
      radius: radiusRows[0] ?? null,
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
              {tenant.can_rename ? (
                <RenameTenant currentName={tenant.name} slug={tenant.slug} />
              ) : (
                <div>
                  <div className="text-ink">{tenant.name}</div>
                  <div className="text-xs text-ink-faint">{tenant.slug}</div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <RadiusSettingsCard initial={toRadiusSettings(radius)} />

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
              <Plug className="size-4 text-ink-faint" aria-hidden /> Integrations
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Connection</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Manual edits</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {integrations.length === 0 && (
                  <TableEmpty colSpan={5}>No integrations configured.</TableEmpty>
                )}
                {integrations.map((integration) => (
                  <TableRow key={integration.id}>
                    <TableCell className="font-medium">{integration.display_name}</TableCell>
                    <TableCell className="text-ink-muted">
                      {humanise(integration.provider)}
                    </TableCell>
                    <TableCell>
                      <Badge tone={integrationTone(integration.status)}>{integration.status}</Badge>
                      {integration.consecutive_failures > 0 && (
                        <div className="mt-0.5 text-xs text-ink-faint">
                          {integration.consecutive_failures} consecutive failures — retries are
                          backing off
                        </div>
                      )}
                      {integration.last_error && (
                        <div className="mt-0.5 max-w-sm truncate text-xs text-danger" title={integration.last_error}>
                          {integration.last_error}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-ink-muted">
                      {formatDateTime(integration.last_sync_at)}
                      {integration.last_success_at && (
                        <div className="text-ink-faint">
                          last success {formatDateTime(integration.last_success_at)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge tone={integration.respect_manual_edits ? 'ok' : 'warning'}>
                        {integration.respect_manual_edits ? 'Preserved' : 'Overwritten'}
                      </Badge>
                    </TableCell>
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
