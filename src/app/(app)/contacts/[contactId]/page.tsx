import { notFound } from 'next/navigation';
import { Mail, Phone } from 'lucide-react';
import { isUuid } from '@/lib/ids';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { NotesCard } from '@/components/notes-card';
import { ContactPageActions } from '@/components/contact-page-actions';
import { ContactForCard } from '@/components/contact-for-card';
import { readChannels } from '@/lib/contacts/channels';
import { contactTags, type ContactFlags } from '@/lib/contacts/tags';
import { isClientRole } from '@/lib/ui/roles';
import { formatDateTime } from '@/lib/ui/format';

export const dynamic = 'force-dynamic';

/**
 * One person at a client: everything recorded about them, on one page.
 *
 * A contact had no page — its name in the list was plain text and the only way
 * to read a second phone number was to open the edit dialog. This is the read
 * view the list now links to; Edit opens that same dialog.
 *
 * UNDER RLS like every read: a contact this actor cannot see is a 404, the same
 * answer as one that does not exist. An archived contact is shown, marked, with
 * Restore — the archive view links here too.
 */
export default async function ContactPage({ params }: { params: Promise<{ contactId: string }> }) {
  const identity = await getServerIdentity();
  const { contactId } = await params;
  if (!isUuid(contactId)) notFound();

  const data = await withTenant(actorOf(identity), async (tx) => {
    const [row] = await tx<({
      id: string; organization_id: string; organization_name: string;
      first_name: string; last_name: string; title: string | null; notes: string | null;
      site_name: string | null; login_name: string | null; login_email: string | null;
      psa_contact_id: string | null; archived_at: Date | null; updated_at: Date;
    } & ContactFlags)[]>`
      SELECT c.id, c.organization_id, o.name AS organization_name,
             c.first_name, c.last_name, c.title, c.notes,
             s.name AS site_name, u.name AS login_name, u.email::text AS login_email,
             c.psa_contact_id, c.archived_at, c.updated_at,
             c.is_primary, c.is_technical, c.is_billing, c.is_emergency, c.is_authorised
      FROM contact c
      JOIN organization o ON o.id = c.organization_id
      LEFT JOIN site s ON s.id = c.site_id AND s.deleted_at IS NULL
      LEFT JOIN app_user u ON u.id = c.app_user_id
      WHERE c.id = ${contactId}::uuid AND c.deleted_at IS NULL
    `;
    if (!row) return null;
    // This client's configurations, and who each names as its contact (0800):
    // the ones naming this person are "Contact for", the rest can be added.
    const configurations = await tx<{ id: string; name: string; contact_id: string | null; contact_name: string | null }[]>`
      SELECT n.id, n.name, d.contact_id,
             CASE WHEN c.id IS NULL THEN NULL ELSE c.first_name || ' ' || c.last_name END AS contact_name
      FROM device d JOIN asset_node n ON n.id = d.id
      LEFT JOIN contact c ON c.id = d.contact_id AND c.deleted_at IS NULL
      WHERE n.organization_id = ${row.organization_id}::uuid AND n.archived_at IS NULL
      ORDER BY lower(n.name)
    `;
    return { row, channels: await readChannels(tx, contactId), configurations };
  });
  if (!data) notFound();

  const { row, channels, configurations } = data;
  const name = `${row.first_name} ${row.last_name}`.trim();
  const tags = contactTags(row);
  const canWrite = !isClientRole(identity.roleKey);
  const archived = row.archived_at !== null;

  return (
    <>
      <PageHeader
        title={name}
        description={row.title ?? undefined}
        trail={[
          { label: 'Clients', href: '/organizations' },
          { label: row.organization_name, href: `/organizations/${row.organization_id}` },
          { label: 'Contacts', href: `/organizations/${row.organization_id}/contacts` },
        ]}
        actions={canWrite ? (
          <ContactPageActions
            contactId={row.id}
            organizationId={row.organization_id}
            name={name}
            archived={archived}
          />
        ) : undefined}
      />
      <PageBody>
        {(tags.length > 0 || archived) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {archived && <Badge tone="warning">Archived {formatDateTime(row.archived_at!.toISOString())}</Badge>}
            {tags.map((tag) => <Badge key={tag} tone="brand">{tag}</Badge>)}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>How to reach them</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {channels.emails.length === 0 && channels.phones.length === 0 && (
                <p className="text-ink-faint">No email address or number recorded.</p>
              )}
              {channels.emails.length > 0 && (
                <ul className="space-y-1.5">
                  {channels.emails.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-2">
                      <Mail className="size-4 text-ink-faint" aria-hidden />
                      <a href={`mailto:${e.address}`} className="text-ink hover:underline">{e.address}</a>
                      <span className="text-xs capitalize text-ink-faint">{e.label}</span>
                      {e.isPrimary && channels.emails.length > 1 && <Badge tone="neutral">Primary</Badge>}
                    </li>
                  ))}
                </ul>
              )}
              {channels.phones.length > 0 && (
                <ul className="space-y-1.5">
                  {channels.phones.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-2">
                      <Phone className="size-4 text-ink-faint" aria-hidden />
                      <a href={`tel:${p.number}`} className="tabular-nums text-ink hover:underline">{p.number}</a>
                      {p.extension && <span className="text-ink-muted">ext. {p.extension}</span>}
                      <span className="text-xs capitalize text-ink-faint">{p.label}</span>
                      {p.isPrimary && channels.phones.length > 1 && <Badge tone="neutral">Primary</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-ink-muted">Title</dt>
                <dd className="text-ink">{row.title ?? '—'}</dd>
                <dt className="text-ink-muted">Location</dt>
                <dd className="text-ink">{row.site_name ?? 'Not at a specific location'}</dd>
                <dt className="text-ink-muted">May authorise changes</dt>
                <dd className="text-ink">{row.is_authorised ? 'Yes' : 'No'}</dd>
                <dt className="text-ink-muted">Helm login</dt>
                <dd className="text-ink">
                  {row.login_email ? `${row.login_name ?? row.login_email} (${row.login_email})` : 'None'}
                </dd>
                {row.psa_contact_id && (
                  <>
                    <dt className="text-ink-muted">PSA contact</dt>
                    <dd className="font-mono text-xs text-ink">{row.psa_contact_id}</dd>
                  </>
                )}
                <dt className="text-ink-muted">Last updated</dt>
                <dd className="text-ink">{formatDateTime(row.updated_at.toISOString())}</dd>
              </dl>
            </CardContent>
          </Card>
        </div>

        <NotesCard endpoint={`/api/contacts/${row.id}`} notes={row.notes} canEdit={canWrite} />

        <ContactForCard
          contactId={row.id}
          linked={configurations.filter((c) => c.contact_id === row.id).map((c) => ({ id: c.id, name: c.name }))}
          options={configurations
            .filter((c) => c.contact_id !== row.id)
            .map((c) => ({ id: c.id, name: c.name, currentContact: c.contact_name }))}
          canEdit={canWrite}
        />
      </PageBody>
    </>
  );
}
