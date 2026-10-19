import Link from 'next/link';
import { Building2, FileText, KeyRound, MapPin, Network, Search, Users } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { humanise } from '@/lib/ui/format';
import { isUuid } from '@/lib/ids';
import { KIND_LABELS, RESULT_KINDS, isResultKind, search, type ResultKind } from '@/lib/search/service';

const ICONS: Record<ResultKind, typeof Search> = {
  client: Building2,
  credential: KeyRound,
  site: MapPin,
  document: FileText,
  asset: Network,
  contact: Users,
};

/**
 * Global search across every client in the tenant — or one of them, with
 * ?org=, which is what the top bar's search box sends for "This client".
 *
 * A plain form with a GET, not a live-filtering client component. Search
 * results are tenant data, and a keystroke-per-request design would put a
 * partial hostname on the wire — and in the server log — on every character.
 * The full query is the thing worth logging once.
 *
 * Results are GROUPED rather than listed flat. A broad query like "acme"
 * returns a client, four assets and a credential, and as one list those are
 * seven rows that all look the same; under headings they are an answer. The
 * ranking is still global — the database orders everything together and this
 * page buckets the page it returned — so a broad query cannot come back as
 * twenty clients and no credentials.
 *
 * Secret material is never indexed: search_document holds labels, hostnames,
 * filenames and notes, and no projector may write anything that came out of
 * secret_version.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kind?: string | string[]; org?: string }>;
}) {
  const identity = await getServerIdentity();
  const params = await searchParams;
  const query = params.q?.trim() ?? '';

  const requested = (Array.isArray(params.kind) ? params.kind : params.kind ? [params.kind] : [])
    .filter(isResultKind);

  /*
   * One client, when the search box sent "This client" (?org=). Read under
   * RLS: an id the reader cannot see finds no client and the search is
   * everywhere they can see, which is the same as no ?org at all.
   */
  const scope = typeof params.org === 'string' && isUuid(params.org)
    ? (await withTenant(actorOf(identity), (tx) =>
        tx<{ id: string; name: string }[]>`SELECT id, name FROM organization WHERE id = ${params.org!}::uuid`,
      ))[0] ?? null
    : null;

  const results = query
    ? await withTenant(actorOf(identity), (tx) =>
        search(tx, {
          query,
          limit: 60,
          ...(requested.length > 0 ? { kinds: requested } : {}),
          ...(scope ? { organizationId: scope.id } : {}),
        }),
      )
    : null;

  const organizations = results?.hits.length
    ? await withTenant(actorOf(identity), async (tx) => {
        const ids = [...new Set(results.hits.map((h) => h.organizationId))];
        const rows = await tx<{ id: string; name: string }[]>`
          SELECT id, name FROM organization WHERE id = ANY(${ids}::uuid[])
        `;
        return new Map(rows.map((r) => [r.id, r.name]));
      })
    : new Map<string, string>();

  const link = (kind: ResultKind | null, org: string | null = scope?.id ?? null) => {
    const q = new URLSearchParams({ q: query });
    if (kind) q.set('kind', kind);
    if (org) q.set('org', org);
    return `/search?${q.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Search"
        description="Clients, sites, assets, credentials and documents — names, notes, addresses, filenames and tags."
      />
      <PageBody>
        <Card>
          <CardContent>
            <form method="GET" className="flex gap-2">
              <Input
                name="q"
                defaultValue={query}
                placeholder="Part of a hostname, a client, a street, a filename…"
                autoFocus
                aria-label="Search"
              />
              {/* The kind filter survives a new search, because somebody who
                  narrowed to credentials is usually about to search again. */}
              {requested.map((kind) => (
                <input key={kind} type="hidden" name="kind" value={kind} />
              ))}
              {scope && <input type="hidden" name="org" value={scope.id} />}
              <Button type="submit" variant="primary">
                <Search aria-hidden />
                Search
              </Button>
            </form>
          </CardContent>
        </Card>

        {scope && (
          <nav className="flex flex-wrap items-center gap-1.5" aria-label="Where to search">
            <FilterChip href={link(requested.length === 1 ? requested[0]! : null)} active>
              This client · {scope.name}
            </FilterChip>
            <FilterChip href={link(requested.length === 1 ? requested[0]! : null, null)} active={false}>
              All clients
            </FilterChip>
          </nav>
        )}

        {results && (
          <nav className="flex flex-wrap items-center gap-1.5">
            <FilterChip href={link(null)} active={requested.length === 0}>
              Everything
            </FilterChip>
            {RESULT_KINDS.map((kind) => {
              const count = results.groups.find((g) => g.kind === kind)?.hits.length ?? 0;
              // A filter that leads to an empty page is worse than no filter.
              // Only offered for kinds this query actually found something in.
              if (count === 0 && !requested.includes(kind)) return null;
              return (
                <FilterChip
                  key={kind}
                  href={link(kind)}
                  active={requested.length === 1 && requested[0] === kind}
                >
                  {KIND_LABELS[kind].plural}
                  <span className="ml-1 tabular-nums text-ink-faint">{count}</span>
                </FilterChip>
              );
            })}
          </nav>
        )}

        {results && results.groups.length === 0 && (
          <Card>
            <CardContent className="p-0">
              <EmptyState
                icon={Search}
                title={`Nothing matches “${query}”${scope ? ` in ${scope.name}` : ''}`}
                description="Search covers names, notes, addresses, filenames, identifiers and tags — and matches parts of words, not only whole ones. It never covers credential material."
              />
            </CardContent>
          </Card>
        )}

        {results?.groups.map((group) => {
          const Icon = ICONS[group.kind];
          return (
            <Card key={group.kind}>
              <CardContent className="p-0">
                <h2 className="flex items-center gap-2 border-b border-border px-5 py-2.5 text-xs font-medium text-ink-muted">
                  <Icon className="size-3.5 text-ink-faint" aria-hidden />
                  {group.label}
                  <span className="tabular-nums text-ink-faint">{group.hits.length}</span>
                </h2>
                <div className="divide-y divide-border">
                  {group.hits.map((hit) => (
                    <Link
                      key={`${hit.entityType}:${hit.entityId}`}
                      href={hit.href}
                      className="flex items-start justify-between gap-4 px-5 py-3 hover:bg-surface-sunken"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-ink">{hit.title}</span>
                          {/* Tier 5 is the title matched exactly. Worth saying:
                              it is the difference between "this is the thing"
                              and "this mentions the thing". */}
                          {hit.matchTier === 5 && <Badge tone="brand">Exact</Badge>}
                        </div>
                        {/*
                          A client's own name IS the title, so repeating it
                          underneath says the same thing twice. For a client the
                          second line carries the legal name when there is one,
                          and otherwise nothing.
                        */}
                        {hit.kind === 'client' ? (
                          hit.subtitle && (
                            <div className="mt-0.5 truncate text-xs text-ink-faint">
                              {hit.subtitle}
                            </div>
                          )
                        ) : (
                          <div className="mt-0.5 truncate text-xs text-ink-faint">
                            {organizations.get(hit.organizationId) ?? '—'}
                            {hit.subtitle && ` · ${humanise(hit.subtitle)}`}
                          </div>
                        )}
                        {hit.tags.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {hit.tags.slice(0, 5).map((tag) => (
                              <Badge key={tag} tone="neutral">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}

        {results?.hasMore && (
          <p className="text-center text-xs text-ink-faint">
            Showing the first {results.limit} matches. Narrow the query, or filter by kind.
          </p>
        )}
      </PageBody>
    </>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={
        active
          ? 'rounded-full border border-transparent bg-brand px-3 py-1 text-xs font-medium text-on-brand'
          : 'rounded-full border border-border px-3 py-1 text-xs text-ink-muted hover:border-border-strong hover:text-ink'
      }
    >
      {children}
    </Link>
  );
}
