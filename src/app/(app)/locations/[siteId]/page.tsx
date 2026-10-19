import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLink, Phone } from 'lucide-react';
import { isUuid } from '@/lib/ids';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { NotesCard } from '@/components/notes-card';
import { SitePageActions } from '@/components/site-page-actions';
import { siteValuesFrom } from '@/lib/sites/values';
import { categoryBySource, ORG_CATEGORIES } from '@/lib/nav/org-categories';
import { isClientRole } from '@/lib/ui/roles';
import { formatDateTime, humanise } from '@/lib/ui/format';

export const dynamic = 'force-dynamic';

type SiteRow = Parameters<typeof siteValuesFrom>[0] & {
  id: string; organization_id: string; organization_name: string; updated_at: Date;
};

interface AssetHere { id: string; name: string; node_type: string; status: string }

/** Sidebar order, so the groups on this page read in the order the client page lists them. */
const ORDER = new Map<string, number>(ORG_CATEGORIES.map((c, i) => [c.source, i]));

/**
 * One location at a client: where it is, how to get in, and what is there.
 *
 * A location had no page — its name in the Locations list opened the edit
 * dialog, and "what lives at the Buffalo office" meant filtering three grids.
 * This is the read view the list now links to; Edit opens that same dialog.
 *
 * UNDER RLS like every read: a site this actor cannot see is a 404, the same
 * answer as one that does not exist or was removed. What is listed as being
 * here is read under RLS too, so a restricted entry is simply not counted.
 */
export default async function LocationPage({ params }: { params: Promise<{ siteId: string }> }) {
  const identity = await getServerIdentity();
  const { siteId } = await params;
  if (!isUuid(siteId)) notFound();

  const data = await withTenant(actorOf(identity), async (tx) => {
    const [row] = await tx<SiteRow[]>`
      SELECT s.id, s.organization_id, o.name AS organization_name,
             s.name, s.code, s.is_primary, s.address_line1, s.address_line2, s.city, s.region,
             s.postal_code, s.country, s.timezone, s.main_phone, s.after_hours_phone,
             ARRAY(SELECT abbrev(ip) FROM unnest(s.public_ips) AS ip) AS public_ips,
             s.access_notes, s.physical_security, s.notes, s.updated_at
      FROM site s
      JOIN organization o ON o.id = s.organization_id
      WHERE s.id = ${siteId}::uuid AND s.deleted_at IS NULL
    `;
    if (!row) return null;
    const contacts = await tx<{ id: string; name: string; title: string | null }[]>`
      SELECT id, first_name || ' ' || last_name AS name, title
      FROM contact
      WHERE site_id = ${siteId}::uuid AND deleted_at IS NULL AND archived_at IS NULL
      ORDER BY lower(last_name), lower(first_name)
    `;
    const assets = await tx<AssetHere[]>`
      SELECT id, name, node_type::text, status::text
      FROM asset_node
      WHERE site_id = ${siteId}::uuid AND archived_at IS NULL
      ORDER BY lower(name)
    `;
    return { row, contacts, assets };
  });
  if (!data) notFound();

  const { row, contacts, assets } = data;
  const canWrite = !isClientRole(identity.roleKey);
  const values = siteValuesFrom(row);

  const locality = [row.city, [row.region, row.postal_code].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  const addressLines = [row.address_line1, row.address_line2, locality, row.country].filter(
    (l): l is string => Boolean(l),
  );
  const hasStreet = Boolean(row.address_line1 || row.city);
  const mapsHref = hasStreet
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressLines.join(', '))}`
    : null;

  const groups = new Map<string, AssetHere[]>();
  for (const asset of assets) {
    const list = groups.get(asset.node_type) ?? [];
    list.push(asset);
    groups.set(asset.node_type, list);
  }
  const grouped = [...groups.entries()].sort(
    ([a], [b]) => (ORDER.get(a) ?? 999) - (ORDER.get(b) ?? 999) || a.localeCompare(b),
  );

  return (
    <>
      <PageHeader
        title={row.name}
        description={row.code ?? undefined}
        trail={[
          { label: 'Clients', href: '/organizations' },
          { label: row.organization_name, href: `/organizations/${row.organization_id}` },
          { label: 'Locations', href: `/organizations/${row.organization_id}/locations` },
        ]}
        actions={canWrite ? (
          <SitePageActions siteId={row.id} organizationId={row.organization_id} values={values} />
        ) : undefined}
      />
      <PageBody>
        {row.is_primary && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="brand">Primary location</Badge>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Address</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {hasStreet ? (
                <address className="not-italic text-ink">
                  {addressLines.map((line) => <div key={line}>{line}</div>)}
                </address>
              ) : (
                <p className="text-ink-faint">No address recorded.</p>
              )}
              {mapsHref && (
                <a href={mapsHref} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-brand hover:underline">
                  Open in maps <ExternalLink className="size-3.5" aria-hidden />
                </a>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-ink-muted">Main phone</dt>
                <dd className="text-ink">
                  {row.main_phone ? <PhoneLink number={row.main_phone} /> : '—'}
                </dd>
                <dt className="text-ink-muted">After hours</dt>
                <dd className="text-ink">
                  {row.after_hours_phone ? <PhoneLink number={row.after_hours_phone} /> : '—'}
                </dd>
                <dt className="text-ink-muted">Time zone</dt>
                <dd className="text-ink">{row.timezone ?? '—'}</dd>
                <dt className="text-ink-muted">Public IPs</dt>
                <dd className="text-ink">
                  {row.public_ips && row.public_ips.length > 0 ? (
                    <ul className="space-y-0.5 font-mono text-xs">
                      {row.public_ips.map((ip) => <li key={ip}>{ip}</li>)}
                    </ul>
                  ) : '—'}
                </dd>
                <dt className="text-ink-muted">Last updated</dt>
                <dd className="text-ink">{formatDateTime(row.updated_at.toISOString())}</dd>
              </dl>
            </CardContent>
          </Card>

          <TextCard title="Access" text={row.access_notes} empty="No access notes — alarm codes, key holders, parking." />
          <TextCard title="Physical security" text={row.physical_security} empty="Nothing recorded about physical security." />
        </div>

        <NotesCard endpoint={`/api/sites/${row.id}`} notes={row.notes} canEdit={canWrite} />

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>People here</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {contacts.length === 0 ? (
                <p className="text-ink-faint">No contacts are recorded at this location.</p>
              ) : (
                <ul className="space-y-1.5">
                  {contacts.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-baseline gap-2">
                      <Link href={`/contacts/${c.id}`} className="font-medium text-ink hover:underline">{c.name}</Link>
                      {c.title && <span className="text-ink-muted">{c.title}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recorded here</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {grouped.length === 0 && (
                <p className="text-ink-faint">Nothing is recorded at this location yet.</p>
              )}
              {grouped.map(([type, list]) => (
                <section key={type} className="space-y-1.5">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                    {categoryBySource(type)?.label ?? humanise(type)} · {list.length}
                  </h3>
                  <ul className="space-y-1">
                    {list.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-baseline gap-2">
                        <Link href={`/assets/${a.id}`} className="text-ink hover:underline">{a.name}</Link>
                        {a.status !== 'active' && <span className="text-xs text-ink-faint">{a.status}</span>}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </CardContent>
          </Card>
        </div>
      </PageBody>
    </>
  );
}

function PhoneLink({ number }: { number: string }) {
  return (
    <a href={`tel:${number}`} className="inline-flex items-center gap-1.5 tabular-nums hover:underline">
      <Phone className="size-3.5 text-ink-faint" aria-hidden />
      {number}
    </a>
  );
}

function TextCard({ title, text, empty }: { title: string; text: string | null; empty: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {text ? (
          <p className="whitespace-pre-wrap text-ink">{text}</p>
        ) : (
          <p className="text-ink-faint">{empty}</p>
        )}
      </CardContent>
    </Card>
  );
}
