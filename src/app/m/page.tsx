import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { listFavorites, listRecent } from '@/lib/workspace/queries';
import { fieldHref, listFieldClients } from '@/lib/field/queries';
import { FieldEmpty, FieldHeading, FieldLinkRow, FieldList, FieldSearchBox, Initials } from './ui';

/**
 * Field view's home: search first, then what you opened last, your favourite
 * clients, and every client. On site the question is nearly always "the
 * firewall at this client", so the client list is one tap from a login.
 */
export default async function FieldHome() {
  const identity = await getServerIdentity();
  const { recent, favorites, clients } = await withTenant(actorOf(identity), async (tx) => {
    const [recent, favorites, clients] = await Promise.all([
      listRecent(tx, 6),
      listFavorites(tx),
      listFieldClients(tx),
    ]);
    return { recent, favorites, clients };
  });

  return (
    <>
      <FieldSearchBox />

      {recent.length > 0 && (
        <>
          <FieldHeading>Recent</FieldHeading>
          <FieldList>
            {recent.map((item) => (
              <FieldLinkRow
                key={`${item.kind}-${item.id}`}
                href={
                  item.kind === 'client'
                    ? `/m/c/${item.id}`
                    : fieldHref({ kind: 'asset', organizationId: null, nodeId: item.id })
                }
                title={item.name}
                subtitle={item.context}
              />
            ))}
          </FieldList>
        </>
      )}

      {favorites.length > 0 && (
        <>
          <FieldHeading>Favourite clients</FieldHeading>
          <FieldList>
            {favorites.map((client) => (
              <FieldLinkRow
                key={client.organizationId}
                href={`/m/c/${client.organizationId}`}
                title={client.name}
                lead={<Initials name={client.name} />}
              />
            ))}
          </FieldList>
        </>
      )}

      <FieldHeading>All clients</FieldHeading>
      {clients.length === 0 ? (
        <FieldEmpty>No clients you can see.</FieldEmpty>
      ) : (
        <FieldList>
          {clients.map((client) => (
            <FieldLinkRow
              key={client.id}
              href={`/m/c/${client.id}`}
              title={client.name}
              lead={<Initials name={client.name} />}
            />
          ))}
        </FieldList>
      )}
    </>
  );
}
