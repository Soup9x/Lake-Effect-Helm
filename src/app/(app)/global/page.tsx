import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  CalendarClock, FileDown, Grid3x3, Layers, Search, Server, Settings, Wand2,
} from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { isClientRole } from '@/lib/ui/roles';
import { ADMIN_SECTIONS } from '@/lib/settings/sections';

export const dynamic = 'force-dynamic';

/**
 * Global — the scope, and a real page rather than an alias.
 *
 * WHAT CHANGED. The Global tab pointed at /search, which is one of the seven
 * things this scope contains. So the scope had no landing page, and the only
 * way to reach the audit log or the coverage grid was to already know the URL
 * — which is why the parity table recorded "aliases, not sections".
 *
 * COUNTS, NOT A SUMMARY. Each card carries the one number that tells somebody
 * whether to open it: how many things expire soon, how many exports are live,
 * how many clients are documented. A landing page of seven bare links is a
 * worse menu than the sidebar, because it costs a page load to learn nothing.
 *
 * AND THE NUMBERS COME THROUGH RLS, so a client-side role that somehow reached
 * this page sees its own organisation's figures rather than the tenant's. The
 * administrative cards are hidden from it as well — not because the pages are
 * unprotected (they check their own permissions) but because a card offering a
 * count of "0 people" to somebody who cannot open the People page is a control
 * that exists to say no.
 *
 * NO CROSS-CLIENT ASSET LIST. The plan's wording mentioned "an assets view"
 * and there is no such page — /assets/[nodeId] is a single record. A filterable
 * table over every asset in the tenant is a group of its own, not assembly, and
 * inventing a half of one here would be the kind of placeholder the plan has
 * spent eleven groups refusing. The Documentation coverage card is the thing
 * that answers "what do we have", which is what that wording was reaching for.
 */
export default async function GlobalPage() {
  const identity = await getServerIdentity();
  const isClient = isClientRole(identity.roleKey);

  const counts = await withTenant(actorOf(identity), async (tx) => {
    const [row] = await tx<{
      expiring: number; critical: number; exports: number;
      clients: number; documented: number; people: number; events: number;
    }[]>`
      SELECT
        -- The dashboard's own view, so this number and that one cannot
        -- disagree: severity is computed at read time, never stored.
        (SELECT count(*)::int FROM v_expiration_dashboard
          WHERE severity <> 'info') AS expiring,
        (SELECT count(*)::int FROM v_expiration_dashboard
          WHERE severity IN ('critical', 'expired')) AS critical,
        -- Live exports only: a failed, expired or revoked bundle is not
        -- something somebody needs to be drawn to, and neither is one whose
        -- download window has closed. The table is export_job, not
        -- export_request, and the enum reads queued / running / completed —
        -- both of which the page test caught before this shipped. (The first
        -- attempt at this comment quoted those values in backticks, inside a
        -- backtick template literal, which ended the SQL string mid-comment.)
        (SELECT count(*)::int FROM export_job
          WHERE status IN ('queued', 'running', 'completed')
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())) AS exports,
        (SELECT count(*)::int FROM organization
          WHERE deleted_at IS NULL AND archived_at IS NULL) AS clients,
        -- A client counts as documented once it has one non-archived record,
        -- which is the same floor the coverage grid's first column uses.
        (SELECT count(*)::int FROM organization o
          WHERE o.deleted_at IS NULL AND o.archived_at IS NULL
            AND EXISTS (SELECT 1 FROM asset_node n
                         WHERE n.organization_id = o.id
                           AND n.archived_at IS NULL)) AS documented,
        (SELECT count(*)::int FROM membership
          WHERE status = 'active'
            AND (expires_at IS NULL OR expires_at > now())) AS people,
        (SELECT count(*)::int FROM audit_log
          WHERE occurred_at > now() - interval '24 hours') AS events
    `;
    return row ?? {
      expiring: 0, critical: 0, exports: 0, clients: 0, documented: 0, people: 0, events: 0,
    };
  });

  return (
    <>
      <PageHeader
        title="Global"
        description="Everything that spans clients — what is expiring, what has been exported, and who can see it."
      />
      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Tile
            href="/search"
            icon={Search}
            title="Search"
            detail="Every client, asset, credential and contact you may see."
          />

          <Tile
            href="/global/assets"
            icon={Layers}
            title="Assets"
            detail="Every client’s documented assets, filtered by client, location, type and status."
          />

          <Tile
            href="/global/configurations"
            icon={Server}
            title="Configurations"
            detail="Every client’s servers, network gear and endpoints, filtered the same way."
          />

          <Tile
            href="/global/password-generator"
            icon={Wand2}
            title="Password generator"
            detail="A strong password for something Helm does not hold. Made in your browser."
          />

          <Tile
            href="/expirations"
            icon={CalendarClock}
            title="Upcoming expirations"
            detail="Certificates, warranties, domains and contracts, across every client."
            count={counts.expiring}
            tone={counts.critical > 0 ? 'danger' : counts.expiring > 0 ? 'warning' : 'neutral'}
            note={counts.critical > 0 ? `${counts.critical} critical or expired` : undefined}
          />

          <Tile
            href="/coverage"
            icon={Grid3x3}
            title="Documentation coverage"
            detail="Every client against every kind of documentation, counts per cell."
            count={counts.clients}
            // COUNTS, NEVER A SCORE (decision 20). "12 of 14 documented" carries
            // its own denominator; a percentage is a number people learn to
            // ignore because it never reaches 100 for a reason nobody can name.
            note={`${counts.documented} of ${counts.clients} have any records`}
          />

          <Tile
            href="/exports"
            icon={FileDown}
            title="Exports"
            detail="Bundles requested, ready or downloaded. Credential exports are notified, not approved."
            count={counts.exports}
            tone={counts.exports > 0 ? 'brand' : 'neutral'}
            note={counts.exports > 0 ? 'live now' : undefined}
          />

        </div>

        {/*
          Administration is one card, not four tiles among the everyday ones:
          the scope's page is for work that spans clients, and the settings
          that govern the MSP are a different kind of visit (Administration has
          its own index at /settings).
        */}
        {!isClient && (
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Settings className="size-4 text-ink-faint" aria-hidden />
                <Link href="/settings" className="font-medium text-ink hover:underline">Administration</Link>
                <span className="text-xs text-ink-faint">
                  {counts.people} active {counts.people === 1 ? 'membership' : 'memberships'} · {counts.events} audit events in the last 24 hours
                </span>
              </div>
              <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {ADMIN_SECTIONS.map((section) => (
                  <li key={section.href}>
                    <Link href={section.href} className="text-brand hover:underline">{section.title}</Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </PageBody>
    </>
  );
}

function Tile({
  href,
  icon: Icon,
  title,
  detail,
  count,
  tone = 'neutral',
  note,
}: {
  href: string;
  icon: typeof Search;
  title: string;
  detail: string;
  count?: number;
  tone?: BadgeTone;
  note?: string | undefined;
}): ReactNode {
  return (
    <Link href={href} className="group block">
      <Card className="h-full transition-colors group-hover:border-border-strong">
        <CardContent className="flex h-full flex-col gap-2 p-4">
          <div className="flex items-center gap-2">
            <Icon className="size-4 shrink-0 text-ink-faint" aria-hidden />
            <span className="font-medium text-ink">{title}</span>
            {count !== undefined && (
              <span className="ml-auto">
                <Badge tone={tone}>{count}</Badge>
              </span>
            )}
          </div>
          <p className="text-xs text-ink-muted">{detail}</p>
          {note && <p className="mt-auto text-xs text-ink-faint">{note}</p>}
        </CardContent>
      </Card>
    </Link>
  );
}
