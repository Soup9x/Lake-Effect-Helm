import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MapPin, Phone } from 'lucide-react';
import { isUuid } from '@/lib/ids';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { recordView } from '@/lib/workspace/queries';
import { FIELD_SECTION_LABELS, readFieldViewPolicy, type FieldSection } from '@/lib/field/policy';
import {
  listFieldContacts, listFieldDevices, listFieldLocations, listFieldLogins, readFieldClient,
} from '@/lib/field/queries';
import { cn } from '@/lib/ui/cn';
import { FieldCard, FieldEmpty, FieldLinkRow, FieldList, FieldValue, SensitivityBadge } from '../../ui';

type Tab = Exclude<FieldSection, 'vault'>;

/** One client in Field view: how to reach them, then one list at a time. */
export default async function FieldClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const identity = await getServerIdentity();
  const { organizationId } = await params;
  if (!isUuid(organizationId)) notFound();
  const requested = (await searchParams).tab;

  const data = await withTenant(actorOf(identity), async (tx) => {
    const client = await readFieldClient(tx, organizationId);
    if (!client) return null;
    await recordView(tx, { organizationId });
    const policy = await readFieldViewPolicy(tx);
    const tabs = policy.sections.filter((s): s is Tab => s !== 'vault');
    const tab: Tab | undefined = tabs.find((t) => t === requested) ?? tabs[0];
    const list = tab === 'logins' ? { tab, rows: await listFieldLogins(tx, organizationId) }
      : tab === 'devices' ? { tab, rows: await listFieldDevices(tx, organizationId) }
      : tab === 'contacts' ? { tab, rows: await listFieldContacts(tx, organizationId) }
      : tab === 'locations' ? { tab, rows: await listFieldLocations(tx, organizationId) }
      : null;
    return { client, tabs, list };
  });
  if (!data) notFound();
  const { client, tabs, list } = data;

  return (
    <>
      <h1 className="px-1 pb-2 text-xl font-semibold tracking-tight text-ink">{client.name}</h1>

      {(client.address || client.mainPhone || client.contactName) && (
        <FieldCard>
          {client.address && (
            <FieldValue label="Address" action={<MapLink address={client.address} />}>{client.address}</FieldValue>
          )}
          {client.mainPhone && (
            <FieldValue label="Main phone" action={<CallLink phone={client.mainPhone} />}>{client.mainPhone}</FieldValue>
          )}
          {client.contactName && (
            <FieldValue
              label="Main contact"
              action={client.contactPhone ? <CallLink phone={client.contactPhone} /> : undefined}
            >
              {client.contactName}
              {client.contactPhone && <span className="block text-sm text-ink-muted">{client.contactPhone}</span>}
            </FieldValue>
          )}
        </FieldCard>
      )}

      {tabs.length > 0 && (
        <nav aria-label="Sections" className="-mx-3 my-3 flex gap-2 overflow-x-auto px-3 pb-1">
          {tabs.map((t) => (
            <Link
              key={t}
              href={`/m/c/${client.id}?tab=${t}`}
              replace
              aria-current={list?.tab === t ? 'page' : undefined}
              className={cn(
                'shrink-0 rounded-full border px-3.5 py-1.5 text-sm',
                list?.tab === t
                  ? 'border-brand bg-brand text-on-brand'
                  : 'border-border bg-surface-raised text-ink',
              )}
            >
              {FIELD_SECTION_LABELS[t]}
            </Link>
          ))}
        </nav>
      )}

      {list?.tab === 'logins' && (list.rows.length === 0 ? <FieldEmpty>No logins documented.</FieldEmpty> : (
        <FieldList>
          {list.rows.map((row) => (
            <FieldLinkRow
              key={row.id}
              href={`/m/s/${row.id}`}
              title={row.name}
              subtitle={[row.username, row.siteName].filter(Boolean).join(' · ') || null}
              badge={<SensitivityBadge sensitivity={row.sensitivity} />}
            />
          ))}
        </FieldList>
      ))}

      {list?.tab === 'devices' && (list.rows.length === 0 ? <FieldEmpty>No devices documented.</FieldEmpty> : (
        <FieldList>
          {list.rows.map((row) => (
            <FieldLinkRow
              key={row.id}
              href={`/m/a/${row.id}`}
              title={row.name}
              subtitle={[row.primaryIp, row.hostname, row.siteName].filter(Boolean).join(' · ') || row.deviceType}
            />
          ))}
        </FieldList>
      ))}

      {list?.tab === 'contacts' && (list.rows.length === 0 ? <FieldEmpty>No contacts documented.</FieldEmpty> : (
        <FieldCard>
          {list.rows.map((row) => (
            <FieldValue
              key={row.id}
              label={row.title || 'Contact'}
              action={row.mobile || row.phone ? <CallLink phone={(row.mobile || row.phone)!} /> : undefined}
            >
              {row.name}
              {(row.mobile || row.phone) && (
                <span className="block text-sm text-ink-muted">{row.mobile || row.phone}</span>
              )}
              {row.email && (
                <a href={`mailto:${row.email}`} className="block truncate text-sm text-brand">{row.email}</a>
              )}
            </FieldValue>
          ))}
        </FieldCard>
      ))}

      {list?.tab === 'locations' && (list.rows.length === 0 ? <FieldEmpty>No locations documented.</FieldEmpty> : (
        <div className="space-y-3">
          {list.rows.map((row) => (
            <FieldCard key={row.id}>
              <FieldValue label="Location" action={row.address ? <MapLink address={row.address} /> : undefined}>
                {row.name}
                {row.address && <span className="block text-sm text-ink-muted">{row.address}</span>}
              </FieldValue>
              {row.mainPhone && (
                <FieldValue label="Phone" action={<CallLink phone={row.mainPhone} />}>{row.mainPhone}</FieldValue>
              )}
              {row.afterHoursPhone && (
                <FieldValue label="After hours" action={<CallLink phone={row.afterHoursPhone} />}>
                  {row.afterHoursPhone}
                </FieldValue>
              )}
              {row.accessNotes && (
                <FieldValue label="Access notes">
                  <span className="whitespace-pre-wrap text-sm">{row.accessNotes}</span>
                </FieldValue>
              )}
            </FieldCard>
          ))}
        </div>
      ))}
    </>
  );
}

function CallLink({ phone }: { phone: string }) {
  return (
    <a
      href={`tel:${phone.replace(/[^\d+]/g, '')}`}
      aria-label={`Call ${phone}`}
      className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-tint text-brand"
    >
      <Phone className="size-4" aria-hidden />
    </a>
  );
}

function MapLink({ address }: { address: string }) {
  return (
    <a
      href={`https://maps.google.com/?q=${encodeURIComponent(address)}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Map of ${address}`}
      className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-tint text-brand"
    >
      <MapPin className="size-4" aria-hidden />
    </a>
  );
}
