import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/ids';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { Sidebar } from '@/components/shell/sidebar';
import { loadOrgNav } from '@/lib/nav/org-sidebar';
import { getSidebarLayout } from '@/lib/nav/sidebar-queries';

/**
 * Everything inside one client gets the drawer.
 *
 * WHY A LAYOUT AND NOT A COMPONENT EACH PAGE RENDERS. The drawer has to survive
 * navigation between categories without re-mounting — otherwise its scroll
 * position resets every time somebody moves from Passwords to Documents, and the
 * "More" disclosure closes itself. A layout renders once for the whole subtree
 * and Next keeps it mounted across the pages beneath it; a component inside each
 * page cannot.
 *
 * It also means the counts are loaded once per subtree rather than once per page,
 * and that the organization's existence is checked in one place.
 *
 * FIXED HEIGHT HERE, not in the chrome. Subtracting the bar's height is what
 * makes the drawer stay put while the grid scrolls, and it is wanted only here —
 * pages outside an organization keep scrolling the window as they always did.
 */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  if (!isUuid(organizationId)) notFound();
  const identity = await getServerIdentity();

  const data = await withTenant(actorOf(identity), async (tx) => {
    // Read through RLS: an organisation this actor may not see simply matches no
    // row, so "not there" and "not yours" are one answer.
    const [org] = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM organization WHERE id = ${organizationId}::uuid
    `;
    if (!org) return null;

    /*
     * The drawer's arrangement, loaded HERE for the same reason the counts are:
     * once per subtree rather than once per page. `customised` is a separate
     * question from the layout — it decides whether the control offers "follow
     * the tenant default again", and a layout that happens to equal the default
     * is not the same as not having one.
     */
    const [nav, layout, mine] = await Promise.all([
      loadOrgNav(tx, org.id),
      getSidebarLayout(tx),
      tx<{ n: number }[]>`SELECT count(*)::int AS n FROM user_sidebar`,
    ]);

    return { org, nav, layout, customised: (mine[0]?.n ?? 0) > 0 };
  });

  if (!data) notFound();

  return (
    <div className="flex min-h-0 flex-1 md:h-[calc(100vh-3.5rem)]">
      <Sidebar
        org={data.org}
        counts={data.nav.counts}
        flexibleAssets={data.nav.flexibleAssets}
        layout={data.layout}
        customised={data.customised}
      />
      <main className="min-w-0 flex-1 overflow-y-auto bg-canvas">{children}</main>
    </div>
  );
}
