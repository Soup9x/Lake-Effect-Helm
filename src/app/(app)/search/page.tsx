import Link from 'next/link';
import { Search } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { humanise } from '@/lib/ui/format';

interface SearchRow {
  node_id: string | null;
  entity_type: string;
  entity_id: string;
  organization_id: string;
  organization_name: string;
  title: string;
  subtitle: string | null;
  rank: number;
}

/**
 * Global search across every client in the tenant.
 *
 * A plain form with a GET, not a live-filtering client component. Search
 * results are tenant data, and a keystroke-per-request design would put a
 * partial hostname on the wire — and in the server log — on every character.
 * The full query is the thing worth logging once.
 *
 * Secret material is never indexed: search_document holds labels, hostnames and
 * notes, and the trigger in 0080 refuses inline secret fields.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const identity = await getServerIdentity();
  const params = await searchParams;
  const query = params.q?.trim() ?? '';

  const results = query
    ? await withTenant(actorOf(identity), async (tx) => {
        return tx<SearchRow[]>`
          SELECT s.node_id, s.entity_type, s.entity_id, s.organization_id,
                 o.name AS organization_name, s.title, s.subtitle, s.rank
          FROM helm.search(${query}, NULL, NULL, 60) s
          JOIN organization o ON o.id = s.organization_id
        `;
      })
    : [];

  return (
    <>
      <PageHeader
        title="Search"
        description="Assets, credentials, procedures and documentation across every client."
      />
      <PageBody>
        <Card>
          <CardContent>
            <form method="GET" className="flex gap-2">
              <Input
                name="q"
                defaultValue={query}
                placeholder="Hostname, serial number, domain, procedure…"
                autoFocus
                aria-label="Search"
              />
              <Button type="submit" variant="primary">
                <Search aria-hidden />
                Search
              </Button>
            </form>
          </CardContent>
        </Card>

        {query && (
          <Card>
            <CardContent className={results.length === 0 ? 'p-0' : 'divide-y divide-border p-0'}>
              {results.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title={`Nothing matches “${query}”`}
                  description="Search covers titles, identifiers, tags and body text — never credential material."
                />
              ) : (
                results.map((result) => (
                  <Link
                    key={`${result.entity_type}:${result.entity_id}`}
                    href={result.node_id ? `/assets/${result.node_id}` : `/organizations/${result.organization_id}`}
                    className="flex items-start justify-between gap-4 px-5 py-3 hover:bg-surface-sunken"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink">{result.title}</div>
                      <div className="mt-1 text-xs text-ink-faint">{result.organization_name}</div>
                    </div>
                    {/*
                      The subtitle is the specific kind — "device", "credential",
                      "network" — where entity_type is the generic "asset_node".
                      Showing the generic one makes every result look identical.
                    */}
                    <Badge tone="neutral">
                      {humanise(result.subtitle ?? result.entity_type)}
                    </Badge>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>
        )}
      </PageBody>
    </>
  );
}
