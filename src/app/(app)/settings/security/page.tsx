import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { AdminNav } from '@/components/admin-nav';
import { KeyRound } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime } from '@/lib/ui/format';
import { RadiusSettingsCard } from '@/components/radius-settings';
import { SessionPolicyCard } from '@/components/session-policy-settings';
import { readSessionPolicy } from '@/lib/auth/session-policy-settings';
import { OidcSettingsCard } from '@/components/oidc-settings';
import { readOidcSettings, readRadiusSettings } from '@/lib/auth/sign-in-settings';
import { listKeyCustody } from '@/lib/tenant/queries';
import { requestOrigin } from '@/lib/settings/origin';

/**
 * Administration → Sign-in & security: session limits, single sign-on, RADIUS,
 * and where the encryption keys are held.
 */
export default async function SecuritySettingsPage() {
  const identity = await getServerIdentity();
  const origin = await requestOrigin();

  const {
    keys, radius, oidc, sessionPolicy,
  } = await withTenant(actorOf(identity), async (tx, session) => {
    const [keys, radius, oidc] = await Promise.all([
      listKeyCustody(tx),
      readRadiusSettings(tx),
      readOidcSettings(tx, origin),
    ]);
    return {
      keys, radius, oidc,
      // 0890: offered only to somebody who may change it, like the sign-in cards.
      sessionPolicy: session.permissions.includes('tenant:write') ? await readSessionPolicy(tx) : null,
    };
  });

  const hostHeld = keys.some((key) => key.host_held_kek);
  const developmentKey = keys.some((key) => key.development_key);

  return (
    <>
      <PageHeader
        title="Sign-in & security"
        description="Session limits, single sign-on, RADIUS, and who holds the encryption keys."
        trail={[{ label: 'Administration', href: '/settings' }]}
      />
      <PageBody>
        <AdminNav />

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
      </PageBody>
    </>
  );
}

export const dynamic = 'force-dynamic';
