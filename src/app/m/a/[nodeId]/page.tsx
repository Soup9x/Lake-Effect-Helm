import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isUuid } from '@/lib/ids';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { recordView } from '@/lib/workspace/queries';
import { readFieldDevice } from '@/lib/field/queries';
import { humanise } from '@/lib/ui/format';
import { FieldCard, FieldHeading, FieldLinkRow, FieldList, FieldValue } from '../../ui';

/** A device (or any other record) in Field view: the facts you need at the rack. */
export default async function FieldAssetPage({ params }: { params: Promise<{ nodeId: string }> }) {
  const identity = await getServerIdentity();
  const { nodeId } = await params;
  if (!isUuid(nodeId)) notFound();

  const asset = await withTenant(actorOf(identity), async (tx) => {
    const found = await readFieldDevice(tx, nodeId);
    if (found) await recordView(tx, { nodeId });
    return found;
  });
  if (!asset) notFound();
  if (asset.nodeType === 'credential') redirect(`/m/s/${asset.id}`);

  return (
    <>
      <Link href={`/m/c/${asset.organizationId}?tab=devices`} className="px-1 text-sm text-brand">
        ‹ {asset.organizationName}
      </Link>
      <h1 className="px-1 pb-1 pt-1 text-xl font-semibold tracking-tight text-ink">{asset.name}</h1>
      <p className="px-1 pb-3 text-sm text-ink-muted">
        {[humanise(asset.nodeType), asset.siteName].filter(Boolean).join(' · ')}
      </p>

      {asset.fields.length > 0 && (
        <FieldCard>
          {asset.fields.map((field) => (
            <FieldValue key={field.label} label={field.label}>
              <span className="break-all">{field.value}</span>
            </FieldValue>
          ))}
        </FieldCard>
      )}

      {asset.logins.length > 0 && (
        <>
          <FieldHeading>Logins</FieldHeading>
          <FieldList>
            {asset.logins.map((login) => (
              <FieldLinkRow key={login.id} href={`/m/s/${login.id}`} title={login.name} />
            ))}
          </FieldList>
        </>
      )}

      {asset.notes && (
        <>
          <FieldHeading>Notes</FieldHeading>
          <FieldCard>
            <div className="whitespace-pre-wrap px-3.5 py-3 text-sm text-ink">{asset.notes}</div>
          </FieldCard>
        </>
      )}
    </>
  );
}
