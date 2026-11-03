import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { search } from '@/lib/search/service';
import { fieldHref } from '@/lib/field/queries';
import { FieldEmpty, FieldHeading, FieldLinkRow, FieldList, FieldSearchBox } from '../ui';

/** Field view search: the full site's search, restricted to what Field view can open. */
export default async function FieldSearch({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const identity = await getServerIdentity();
  const q = ((await searchParams).q ?? '').trim().slice(0, 200);

  const result = q.length >= 2
    ? await withTenant(actorOf(identity), async (tx) => {
        const found = await search(tx, {
          query: q,
          kinds: ['client', 'credential', 'asset', 'contact', 'site'],
          limit: 50,
        });
        // Which client each hit belongs to: at a client site, five "Firewall"
        // logins are only told apart by whose they are.
        const orgIds = [...new Set(found.groups.flatMap((g) => g.hits.map((h) => h.organizationId)))];
        const orgs = orgIds.length
          ? await tx<{ id: string; name: string }[]>`
              SELECT id, name FROM organization WHERE id = ANY(${orgIds}::uuid[])`
          : [];
        return { ...found, orgNames: new Map(orgs.map((o) => [o.id, o.name])) };
      })
    : null;

  return (
    <>
      <FieldSearchBox defaultValue={q} />
      {!result ? (
        <p className="mt-4 px-1 text-sm text-ink-muted">Type at least two characters, then search.</p>
      ) : result.groups.length === 0 ? (
        <div className="mt-4"><FieldEmpty>Nothing matches “{q}”.</FieldEmpty></div>
      ) : (
        result.groups.map((group) => (
          <section key={group.kind}>
            <FieldHeading>{group.label}</FieldHeading>
            <FieldList>
              {group.hits.map((hit) => (
                <FieldLinkRow
                  key={`${hit.entityType}-${hit.entityId}`}
                  href={fieldHref(hit)}
                  title={hit.title}
                  subtitle={
                    hit.kind === 'client'
                      ? hit.subtitle
                      : [result.orgNames.get(hit.organizationId), hit.subtitle].filter(Boolean).join(' · ') || null
                  }
                />
              ))}
            </FieldList>
          </section>
        ))
      )}
    </>
  );
}
