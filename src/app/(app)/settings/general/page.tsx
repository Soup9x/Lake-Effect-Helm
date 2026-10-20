import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { AdminNav } from '@/components/admin-nav';
import Link from 'next/link';
import { Activity, Boxes, Building, PanelLeft, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { InlineRename } from '@/components/inline-rename';
import { SidebarCustomise } from '@/components/sidebar-customise';
import { HealthWindowForm } from '@/components/health-window-form';
import { readHealthSetting } from '@/lib/health/queries';
import { readTenantSidebarDefault } from '@/lib/nav/sidebar-queries';
import { ORG_CATEGORIES } from '@/lib/nav/org-categories';
import { readTenantSummary } from '@/lib/tenant/queries';

/**
 * Administration → General (the MSP's name, the default sidebar, what counts
 * as stale documentation, the custom documentation types, and who you are here).
 */
export default async function GeneralSettingsPage() {
  const identity = await getServerIdentity();

  const {
    tenant, flexibleTypeCount, sidebarDefault, sidebarDefaultSet, healthWindow,
  } = await withTenant(actorOf(identity), async (tx) => {
    const [tenant, flexibleTypeRows, sidebarDefaultRow, healthWindow] = await Promise.all([
      readTenantSummary(tx, identity.actorId),
      tx<{ n: number }[]>`SELECT count(*)::int AS n FROM flexible_asset_type`,
      readTenantSidebarDefault(tx),
      readHealthSetting(tx),
    ]);
    return {
      tenant,
      flexibleTypeCount: flexibleTypeRows[0]?.n ?? 0,
      sidebarDefault: sidebarDefaultRow.categories,
      sidebarDefaultSet: sidebarDefaultRow.set,
      healthWindow,
    };
  });

  return (
    <>
      <PageHeader
        title="General"
        description="This MSP, the default sidebar, documentation health and custom documentation types."
        trail={[{ label: 'Administration', href: '/settings' }]}
      />
      <PageBody>
        <AdminNav />

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

export const dynamic = 'force-dynamic';
