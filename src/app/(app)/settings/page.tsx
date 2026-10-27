import Link from 'next/link';
import type { ComponentType } from 'react';
import {
  Activity, Bot, Boxes, Building, Cloud, HardDriveDownload, Mail, Puzzle, ShieldCheck, Users,
} from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { ADMIN_SECTIONS, type AdminSection } from '@/lib/settings/sections';

/**
 * Administration — every setting that governs the whole MSP, in sections.
 *
 * It was one page of nineteen cards, from the MSP's name to key custody, which
 * made the one somebody came for hard to find and the page slow to load. Each
 * section is now its own page with its own reads; this one is the index, and
 * says in a word how each section stands where that is cheap to know: whether
 * email is set up, how many integrations are connected and whether any is
 * failing.
 *
 * Personal settings are NOT here. "Change my password" has to be reachable by
 * everybody who can sign in, so it lives on the profile and account pages.
 */
const ICONS: Record<AdminSection['icon'], ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  general: Building,
  people: Users,
  security: ShieldCheck,
  email: Mail,
  integrations: Cloud,
  backups: HardDriveDownload,
  automation: Bot,
  audit: Activity,
  types: Boxes,
  extensions: Puzzle,
};

export default async function AdministrationPage() {
  const identity = await getServerIdentity();

  const status = await withTenant(actorOf(identity), async (tx) => {
    const [row] = await tx<{
      relay: boolean | null; integrations: number; failing: number; people: number; types: number;
    }[]>`
      SELECT
        (SELECT enabled FROM smtp_setting LIMIT 1) AS relay,
        (SELECT count(*)::int FROM integration_connection WHERE disabled_at IS NULL)
          + (SELECT count(*)::int FROM helm.unifi_mappings() WHERE is_active) AS integrations,
        (SELECT count(*)::int FROM integration_connection
          WHERE disabled_at IS NULL AND status IN ('degraded', 'error')) AS failing,
        (SELECT count(*)::int FROM membership
          WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())) AS people,
        (SELECT count(*)::int FROM flexible_asset_type) AS types
    `;
    return row;
  });

  const badge: Partial<Record<string, { text: string; tone: BadgeTone }>> = {
    '/settings/notifications': status?.relay
      ? { text: 'Email on', tone: 'ok' }
      : { text: 'Email not set up', tone: 'warning' },
    '/settings/integrations': (status?.failing ?? 0) > 0
      ? { text: `${status!.failing} failing`, tone: 'danger' }
      : { text: `${status?.integrations ?? 0} connected`, tone: 'neutral' },
    '/people': { text: `${status?.people ?? 0} active`, tone: 'neutral' },
    '/settings/asset-types': { text: `${status?.types ?? 0} defined`, tone: 'neutral' },
  };

  return (
    <>
      <PageHeader
        title="Administration"
        description="Everything that applies to the whole MSP, grouped so the setting you came for is one click away."
      />
      <PageBody>
        <AdminNav />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ADMIN_SECTIONS.map((section) => {
            const Icon = ICONS[section.icon];
            const state = badge[section.href];
            return (
              <Link key={section.href} href={section.href} className="group block">
                <Card className="h-full transition-colors group-hover:border-border-strong">
                  <CardContent className="flex h-full flex-col gap-2 p-4">
                    <div className="flex items-center gap-2">
                      <Icon className="size-4 shrink-0 text-ink-faint" aria-hidden />
                      <span className="font-medium text-ink">{section.title}</span>
                      {state && (
                        <span className="ml-auto">
                          <Badge tone={state.tone}>{state.text}</Badge>
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-muted">{section.detail}</p>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </PageBody>
    </>
  );
}

export const dynamic = 'force-dynamic';
