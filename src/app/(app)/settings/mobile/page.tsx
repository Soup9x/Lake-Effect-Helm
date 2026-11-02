import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { AdminNav } from '@/components/admin-nav';
import { EmptyState } from '@/components/app-shell';
import { FieldViewSettingsCard } from '@/components/field-view-settings';
import { readFieldViewPolicy } from '@/lib/field/policy';

/**
 * Administration → Mobile access: Field view, the read-only phone view (1250).
 *
 * Settings, not a layout designer. What there is to decide about a phone is
 * whether it is offered, how long it may stay signed in, what happens to a
 * critical credential, and which sections a client shows — set once, and
 * then left alone.
 */
export default async function MobileSettingsPage() {
  const identity = await getServerIdentity();
  const data = await withTenant(actorOf(identity), async (tx, session) => ({
    canManage: session.permissions.includes('tenant:write'),
    policy: await readFieldViewPolicy(tx),
  }));

  return (
    <>
      <PageHeader
        title="Mobile access"
        description="Field view: a simple, read-only view of Helm for phones at a client site."
        trail={[{ label: 'Administration', href: '/settings' }]}
      />
      <PageBody>
        <AdminNav />
        {data.canManage ? (
          <FieldViewSettingsCard initial={data.policy} />
        ) : (
          <EmptyState title="Only administrators can change these settings" />
        )}
      </PageBody>
    </>
  );
}
