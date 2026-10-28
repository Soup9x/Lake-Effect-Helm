'use client';

/**
 * A written document's dependencies (1130), in the page's sidebar: the
 * assets, documents, contacts, locations and diagrams it relies on, and the
 * documents that rely on it.
 *
 * The picker searches the client through /api/search, as the asset page's
 * dependency editor does, and keeps only the hits that can be a target: a
 * file, a client or a personal credential is a search hit and not a record
 * a document can depend on.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileText, KeyRound, Link2, Loader2, MapPin, Network, Plus, Server, User, X, type LucideIcon,
} from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label } from './ui/field';
import { Modal } from './ui/modal';
import { apiFetch } from '@/lib/ui/api';
import type { Dependency, DependencyKind, Dependent } from '@/lib/documents/links';

interface Candidate {
  kind: DependencyKind;
  targetId: string;
  title: string;
  subtitle: string | null;
}

/** The shape /api/search returns, as much of it as this reads. */
interface SearchResponse {
  hits?: { entityType: string; entityId: string; nodeId: string | null; kind: string; title: string; subtitle: string | null }[];
}

const KIND_ICON: Record<DependencyKind, LucideIcon> = {
  asset: Server, document: FileText, contact: User, site: MapPin, diagram: Network,
};

/** Which search hits can be linked, and as what. */
export function candidateOf(hit: NonNullable<SearchResponse['hits']>[number]): Candidate | null {
  const base = { title: hit.title, subtitle: hit.subtitle };
  switch (hit.entityType) {
    case 'document_page': return { ...base, kind: 'document', targetId: hit.entityId };
    case 'contact': return { ...base, kind: 'contact', targetId: hit.entityId };
    case 'site': return { ...base, kind: 'site', targetId: hit.entityId };
    case 'network_diagram': return { ...base, kind: 'diagram', targetId: hit.entityId };
    case 'attachment':
    case 'organization':
    case 'personal_credential':
      return null;
    default:
      return hit.nodeId ? { ...base, kind: 'asset', targetId: hit.nodeId } : null;
  }
}

export function DocumentDependencies({
  pageId,
  organizationId,
  dependencies,
  dependents,
  canWrite,
}: {
  pageId: string;
  organizationId: string;
  dependencies: readonly Dependency[];
  dependents: readonly Dependent[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [target, setTarget] = useState<Candidate | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const linked = new Set(dependencies.map((d) => `${d.kind}:${d.targetId}`));
  const linkedKey = [...linked].join(',');

  const runSearch = useCallback(
    async (term: string) => {
      const seq = ++searchSeq.current;
      if (term.trim().length < 2) {
        setCandidates([]);
        return;
      }
      setSearching(true);
      try {
        const params = new URLSearchParams({ q: term.trim(), organizationId, limit: '15' });
        const result = await apiFetch<SearchResponse>(`/api/search?${params.toString()}`);
        if (!result.ok || seq !== searchSeq.current) return;
        const taken = new Set(linkedKey ? linkedKey.split(',') : []);
        const seen = new Set<string>();
        setCandidates(
          (result.value.hits ?? [])
            .map(candidateOf)
            .filter((c): c is Candidate => {
              if (!c) return false;
              const key = `${c.kind}:${c.targetId}`;
              if (seen.has(key) || taken.has(key)) return false;
              if (c.kind === 'document' && c.targetId === pageId) return false;
              seen.add(key);
              return true;
            }),
        );
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [organizationId, pageId, linkedKey],
  );

  useEffect(() => {
    const timer = setTimeout(() => void runSearch(query), 250);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  function reset() {
    setQuery('');
    setCandidates([]);
    setTarget(null);
    setNote('');
    setError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch(`/api/document-pages/${pageId}/dependencies`, {
        json: { kind: target.kind, targetId: target.targetId, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      if (!result.ok) { setError(result.message); return; }
      reset();
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setRemoving(id);
    try {
      const result = await apiFetch(`/api/document-pages/${pageId}/dependencies`, { method: 'DELETE', json: { id } });
      if (result.ok) router.refresh();
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Link2 className="size-4 text-ink-faint" aria-hidden /> Dependencies
          {dependencies.length > 0 && <Badge tone="neutral">{dependencies.length}</Badge>}
        </CardTitle>
        {canWrite && (
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <Plus aria-hidden /> Add
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {dependencies.length === 0 ? (
          <p className="text-sm text-ink-faint">
            Nothing linked. Add the assets, credentials, contacts, locations or other documents this one relies on.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {dependencies.map((d) => {
              const Icon = d.kind === 'asset' && d.label === 'Credential' ? KeyRound : KIND_ICON[d.kind];
              return (
                <li key={d.id} className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-sunken">
                  <Icon className="size-4 shrink-0 text-ink-faint" aria-hidden />
                  <a href={d.href} title={d.note ?? undefined} className="min-w-0 flex-1">
                    <span className={d.archived ? 'block truncate text-ink-faint line-through' : 'block truncate text-ink hover:text-brand'}>
                      {d.title}
                    </span>
                    <span className="block truncate text-xs text-ink-faint">
                      {d.label}{d.archived && ' · archived'}{d.note && ` · ${d.note}`}
                    </span>
                  </a>
                  {canWrite && (
                    <button type="button" disabled={removing !== null} onClick={() => void remove(d.id)}
                            aria-label={`Remove the dependency on ${d.title}`} title={`Remove the dependency on ${d.title}`}
                            className="shrink-0 rounded p-1 text-ink-faint hover:bg-danger/10 hover:text-danger disabled:opacity-40">
                      {removing === d.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <X className="size-3.5" aria-hidden />}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {dependents.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Used by</p>
            <ul className="space-y-1 text-sm">
              {dependents.map((d) => (
                <li key={d.id} className="flex items-center gap-2 px-1 py-0.5">
                  <FileText className="size-4 shrink-0 text-ink-faint" aria-hidden />
                  <a href={d.href} title={d.note ?? undefined}
                     className={d.archived ? 'truncate text-ink-faint line-through' : 'truncate text-ink hover:text-brand'}>
                    {d.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>

      <Modal
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title="Add a dependency"
        icon={Link2}
        description="Something this document relies on: the server it covers, the credential it uses, the person to call."
      >
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="doc-dep-target">Depends on</Label>
            <Input
              id="doc-dep-target"
              value={target ? target.title : query}
              onChange={(e) => {
                setTarget(null);
                setQuery(e.target.value);
              }}
              placeholder="Search this client&rsquo;s records"
              autoComplete="off"
              autoFocus
            />
            {target ? (
              <FieldHint className="mt-1">
                Linking to <span className="text-ink">{target.title}</span>. Type to choose a different one.
              </FieldHint>
            ) : (
              <FieldHint className="mt-1">
                {searching
                  ? 'Searching…'
                  : query.trim().length < 2
                    ? 'Two characters or more.'
                    : candidates.length === 0
                      ? 'Nothing matching in this client.'
                      : 'Pick one below.'}
              </FieldHint>
            )}
            {!target && candidates.length > 0 && (
              <ul className="mt-2 max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
                {candidates.map((c) => {
                  const Icon = KIND_ICON[c.kind];
                  return (
                    <li key={`${c.kind}:${c.targetId}`}>
                      <button type="button" onClick={() => { setTarget(c); setCandidates([]); }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-sunken">
                        <Icon className="size-4 shrink-0 text-ink-faint" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-ink">{c.title}</span>
                        {c.subtitle && <span className="shrink-0 truncate text-xs text-ink-faint">{c.subtitle}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div>
            <Label htmlFor="doc-dep-note">Note</Label>
            <Input id="doc-dep-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000}
                   placeholder="Optional. Why this document needs it." />
          </div>

          {error && <p role="alert" className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy || !target}>
              {busy && <Loader2 className="animate-spin" aria-hidden />} Add dependency
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}
