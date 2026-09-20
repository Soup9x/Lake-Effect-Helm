'use client';

/**
 * The create flows, from the dashboard.
 *
 * THE SAME COMPONENTS, NOT COPIES. Each button below renders the real
 * NewOrganizationForm / NewSecretForm / SiteForm / NewAssetForm that the client
 * page renders. A quick-action panel with its own lightweight forms would be a
 * second implementation of every create flow, and the first thing to drift
 * would be a validation rule that only one of them has.
 *
 * WHY THERE IS A CLIENT PICKER. Three of the four flows are scoped to a client:
 * NewSecretForm and SiteForm take an organizationId, and NewAssetForm takes
 * that plus the client's sites. On a client page that context is the page. The
 * dashboard has none, so the widget asks for it once and then hands the real
 * component exactly what it expects. Adding a client is the one flow that needs
 * no client, so it is offered unconditionally.
 *
 * Export is a link rather than a modal because it is a page, not a dialog — the
 * request form carries a scope picker and a reason of real length, which is not
 * a thing to squeeze into a widget.
 *
 * The client list and the sites come from the dashboard's own query, which runs
 * only when this widget is in the layout. A widget that fetched its own would
 * put a request on every dashboard load whether or not anybody wanted it.
 */
import { useState } from 'react';
import Link from 'next/link';
import { Building2, Download, Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FieldHint, Label, Select } from '@/components/ui/field';
import { NewOrganizationForm } from '@/components/new-organization-form';
import { NewSecretForm } from '@/components/new-secret-form';
import { SiteForm } from '@/components/site-form';
import { NewAssetForm } from '@/components/new-asset-form';

export interface QuickActionClient {
  id: string;
  name: string;
  sites: { id: string; name: string }[];
}

export function QuickActionsWidget({
  clients,
  canWrite,
}: {
  clients: QuickActionClient[];
  canWrite: boolean;
}) {
  // Remembered across opening several dialogs in a row: somebody adding a site
  // and then an asset for the same client should not pick it twice.
  const [organizationId, setOrganizationId] = useState(clients[0]?.id ?? '');
  const chosen = clients.find((c) => c.id === organizationId);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plus className="size-4 text-ink-faint" aria-hidden /> Quick actions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!canWrite ? (
          <p className="text-sm text-ink-faint">
            Your role is read-only, so there is nothing to start from here.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <NewOrganizationForm />
              <Button asChild variant="secondary">
                <Link href="/exports">
                  <Download aria-hidden />
                  Run an export
                </Link>
              </Button>
            </div>

            {clients.length === 0 ? (
              <FieldHint>
                Add a client first — credentials, sites and assets all belong to one.
              </FieldHint>
            ) : (
              <div className="space-y-2 border-t border-border pt-3">
                <div className="space-y-1">
                  <Label htmlFor="quick-action-client">For which client</Label>
                  <Select
                    id="quick-action-client"
                    value={organizationId}
                    onChange={(event) => setOrganizationId(event.target.value)}
                  >
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </Select>
                </div>

                {chosen && (
                  <div className="flex flex-wrap gap-2">
                    {/*
                      Keyed on the client so switching clients resets each
                      dialog's internal state. Without it, a half-filled form
                      for one client carries its values to the next.
                    */}
                    <NewSecretForm key={`secret-${chosen.id}`} organizationId={chosen.id} />
                    <SiteForm key={`site-${chosen.id}`} organizationId={chosen.id} />
                    <NewAssetForm
                      key={`asset-${chosen.id}`}
                      organizationId={chosen.id}
                      sites={chosen.sites}
                    />
                  </div>
                )}
              </div>
            )}

            <p className="pt-1 text-xs text-ink-faint">
              <Building2 className="mr-1 inline size-3" aria-hidden />
              The same forms as the client page — this is only a shorter way to reach them.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
