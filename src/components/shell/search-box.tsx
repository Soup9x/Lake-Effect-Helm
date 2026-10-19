'use client';

/**
 * The top bar's search box: suggestions as you type, in this client or all.
 *
 * WHAT IT SENDS. POST /api/search/suggest with the query in the body — never in
 * a URL, so typing does not write a partial hostname into an access log per
 * keystroke (that route says more). Two characters before the first request,
 * 200ms after the last keystroke, and a newer request aborts the one before it,
 * so the list never shows the answer to a query you have already typed past.
 *
 * THIS CLIENT OR ALL CLIENTS. "This client" means the client the page is
 * about — the server works it out from the path (lib/search/scope.ts), under
 * RLS. Outside a client only "All clients" exists, and the toggle is not drawn.
 * The choice is remembered per browser; it is a habit, not a fact about a page.
 *
 * Enter on a highlighted suggestion opens it; Enter otherwise opens /search
 * with the same query and the same scope, which is also what "See all
 * results" does.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2, Search } from 'lucide-react';
import { apiFetch } from '@/lib/ui/api';
import { cn } from '@/lib/ui/cn';

interface Suggestion { key: string; title: string; subtitle: string | null; organizationName: string | null; href: string }
interface Group { kind: string; label: string; hits: Suggestion[] }
interface SuggestResponse {
  client: { id: string; name: string } | null;
  scoped: boolean;
  hasMore: boolean;
  groups: Group[];
}

type Scope = 'client' | 'all';
const SCOPE_KEY = 'helm:search-scope';
const MIN_LENGTH = 2;
const DEBOUNCE_MS = 200;

export function SearchBox() {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const [query, setQuery] = useState('');
  const [scope, setScopeState] = useState<Scope>('client');
  const [client, setClient] = useState<SuggestResponse['client']>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const inFlight = useRef<AbortController | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(SCOPE_KEY) === 'all') setScopeState('all');
    } catch {
      // Private windows throw on storage access; the default is fine.
    }
  }, []);

  const setScope = (next: Scope) => {
    setScopeState(next);
    try { window.localStorage.setItem(SCOPE_KEY, next); } catch { /* as above */ }
  };

  const fetchSuggestions = useCallback(async (q: string, s: Scope, path: string) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(q.length >= MIN_LENGTH);
    const result = await apiFetch<SuggestResponse>('/api/search/suggest', {
      json: { q: q.length >= MIN_LENGTH ? q : '', path, scope: s },
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    setLoading(false);
    if (!result.ok || !result.value) return;
    setClient(result.value.client);
    setGroups(result.value.groups);
    setHasMore(result.value.hasMore);
    setActive(-1);
  }, []);

  // Which client "This client" means, whenever the page changes.
  useEffect(() => {
    setGroups([]);
    void fetchSuggestions('', 'client', pathname);
  }, [pathname, fetchSuggestions]);

  // Suggestions, after a pause in typing.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_LENGTH) {
      inFlight.current?.abort();
      setGroups([]);
      setLoading(false);
      return;
    }
    const timer = setTimeout(() => void fetchSuggestions(q, scope, pathname), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, scope, pathname, fetchSuggestions]);

  // Closes on a click anywhere else.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const scoped = scope === 'client' && client !== null;
  const flat = groups.flatMap((g) => g.hits);
  const allResultsHref = () => {
    const params = new URLSearchParams({ q: query.trim() });
    if (scoped) params.set('org', client.id);
    return `/search?${params.toString()}`;
  };

  const go = (href: string) => {
    setOpen(false);
    setQuery('');
    router.push(href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = active >= 0 ? flat[active] : undefined;
      if (chosen) go(chosen.href);
      else if (query.trim()) go(allResultsHref());
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const showPanel = open && (query.trim().length >= MIN_LENGTH || client !== null);
  let index = -1;

  return (
    <div ref={boxRef} className="relative">
      <div className="flex h-8 w-44 items-center gap-1.5 rounded-md bg-white/10 px-2 text-nav-ink focus-within:bg-white/15 focus-within:text-nav-ink-active sm:w-64">
        {loading ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : <Search className="size-4 shrink-0" aria-hidden />}
        <input
          type="search"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={scoped ? `Search ${client.name}` : 'Search all clients'}
          aria-label="Search"
          className="min-w-0 flex-1 bg-transparent text-sm text-nav-ink-active placeholder:text-nav-ink outline-none"
        />
      </div>

      {showPanel && (
        <div
          id="search-suggestions"
          className="absolute right-0 top-10 z-40 w-[min(26rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-surface-raised text-sm shadow-lg"
        >
          {client && (
            <fieldset className="flex gap-1 border-b border-border p-2" aria-label="Where to search">
              {(['client', 'all'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  aria-pressed={scope === s}
                  className={cn(
                    'min-w-0 truncate rounded-full border px-3 py-1 text-xs',
                    scope === s
                      ? 'border-transparent bg-brand font-medium text-on-brand'
                      : 'border-border text-ink-muted hover:border-border-strong hover:text-ink',
                  )}
                >
                  {s === 'client' ? `This client · ${client.name}` : 'All clients'}
                </button>
              ))}
            </fieldset>
          )}

          {query.trim().length < MIN_LENGTH ? (
            <p className="px-3 py-3 text-xs text-ink-faint">Type at least two characters.</p>
          ) : groups.length === 0 ? (
            <p className="px-3 py-3 text-xs text-ink-faint">
              {loading ? 'Searching…' : `Nothing matches “${query.trim()}”${scoped ? ` in ${client.name}` : ''}.`}
            </p>
          ) : (
            <ul className="max-h-96 overflow-y-auto py-1">
              {groups.map((group) => (
                <li key={group.kind}>
                  <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                    {group.label}
                  </p>
                  <ul>
                    {group.hits.map((hit) => {
                      index += 1;
                      const mine = index;
                      return (
                        <li key={hit.key}>
                          <button
                            type="button"
                            onMouseEnter={() => setActive(mine)}
                            onClick={() => go(hit.href)}
                            className={cn(
                              'block w-full px-3 py-1.5 text-left',
                              active === mine ? 'bg-surface-sunken' : 'hover:bg-surface-sunken',
                            )}
                          >
                            <span className="block truncate text-ink">{hit.title}</span>
                            {(hit.subtitle || (!scoped && hit.organizationName)) && (
                              <span className="block truncate text-xs text-ink-faint">
                                {[!scoped ? hit.organizationName : null, hit.subtitle].filter(Boolean).join(' · ')}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}

          {query.trim().length >= MIN_LENGTH && (
            <button
              type="button"
              onClick={() => go(allResultsHref())}
              className="block w-full border-t border-border px-3 py-2 text-left text-xs font-medium text-brand hover:bg-surface-sunken"
            >
              {hasMore ? 'See all results' : 'Open the search page'} for “{query.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  );
}
