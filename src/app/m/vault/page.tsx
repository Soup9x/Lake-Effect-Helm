import { notFound } from 'next/navigation';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { listVault } from '@/lib/personal/vault';
import { readFieldViewPolicy } from '@/lib/field/policy';
import { FieldEmpty, FieldHeading, FieldLinkRow, FieldList } from '../ui';

/** Your own vault, in Field view. Private to you, as on the full site. */
export default async function FieldVault() {
  const identity = await getServerIdentity();
  const data = await withTenant(actorOf(identity), async (tx) => {
    const policy = await readFieldViewPolicy(tx);
    if (!policy.sections.includes('vault')) return null;
    return listVault(tx);
  });
  if (!data) notFound();

  return (
    <>
      <FieldHeading>My vault</FieldHeading>
      {data.length === 0 ? (
        <FieldEmpty>Nothing in your vault yet. Add entries on the full site.</FieldEmpty>
      ) : (
        <FieldList>
          {data.map((entry) => (
            <FieldLinkRow key={entry.id} href={`/m/vault/${entry.id}`} title={entry.name} subtitle={entry.username} />
          ))}
        </FieldList>
      )}
    </>
  );
}
