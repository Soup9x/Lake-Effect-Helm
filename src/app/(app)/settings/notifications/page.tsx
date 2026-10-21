import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { AdminNav } from '@/components/admin-nav';
import { CalendarClock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SmtpSettingsCard } from '@/components/smtp-settings';
import { NotificationSettingsCard } from '@/components/notification-settings';
import { ExpiryAlertForm } from '@/components/expiry-alert-form';
import { readExpiryAlertSetting } from '@/lib/alerts/queries';
import { listSendingConnections, readSmtpSetting } from '@/lib/email/settings';
import { readTenantSummary } from '@/lib/tenant/queries';
import { listNotificationDestinations, listRecentDeliveries, NOTIFICATION_EVENTS } from '@/lib/notifications/queries';

/**
 * Administration → Email & notifications: the mail relay first, because the
 * destinations below depend on it, then where notifications go and when expiry
 * warnings are raised.
 */
export default async function NotificationSettingsPage() {
  const identity = await getServerIdentity();

  const {
    tenant, smtp, connections, destinations, deliveries, expiryAlerts, canManageAlerts,
  } = await withTenant(actorOf(identity), async (tx) => {
    const [tenant, smtp, connections, destinations, deliveries, expiryAlerts, alertPermissionRows] = await Promise.all([
      readTenantSummary(tx, identity.actorId),
      // The mail relay, without its password: helm_app has no privilege on the
      // envelope columns, so `passwordSet` is a boolean the database computed.
      readSmtpSetting(tx),
      // The MSP's own Microsoft 365 connections, which mail can go out through (1010).
      listSendingConnections(tx),
      listNotificationDestinations(tx),
      listRecentDeliveries(tx),
      readExpiryAlertSetting(tx),
      tx<{ allowed: boolean }[]>`SELECT helm.has_permission('alert:manage') AS allowed`,
    ]);
    return {
      tenant, smtp, connections, destinations, deliveries, expiryAlerts,
      canManageAlerts: alertPermissionRows[0]?.allowed ?? false,
    };
  });

  return (
    <>
      <PageHeader
        title="Email & notifications"
        description="How Helm sends mail, where notifications are sent, and when expiry warnings go out."
        trail={[{ label: 'Administration', href: '/settings' }]}
      />
      <PageBody>
        <AdminNav />

        {/*
          * The relay comes BEFORE the destinations that depend on it. An email
          * destination cannot be saved without one, and a page that offers the
          * dependent control first teaches people to hit the error.
          */}
        <SmtpSettingsCard
          initial={smtp}
          canManage={tenant?.can_write_tenant ?? false}
          connections={connections}
        />

        <NotificationSettingsCard
          destinations={destinations}
          history={deliveries}
          events={NOTIFICATION_EVENTS}
          emailConfigured={smtp.enabled}
        />

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
      </PageBody>
    </>
  );
}

export const dynamic = 'force-dynamic';
