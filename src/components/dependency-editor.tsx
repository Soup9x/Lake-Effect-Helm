'use client';

/**
 * Adding and removing dependencies on an asset.
 *
 * WHY THIS COMPONENT DID NOT EXIST AND HAD TO. The link engine, its
 * canonicalisation, the bi-directional view, the API routes and their
 * integration tests were all built and all work. Nothing in the interface ever
 * called them. The Dependencies card rendered `edges` and an empty state, so
 * every asset in the product said "Nothing is linked to this asset yet" forever
 * and the only way to link anything was to POST it by hand.
 *
 * RELATIONS ARE OFFERED AS SENTENCES, not as enum values. "depends_on" in a
 * dropdown makes the reader translate; "This asset depends on…" tells them what
 * the row will mean when somebody else reads it in a year. The pairs are listed
 * in both directions because which way round a person thinks of a relationship
 * depends entirely on which end they are standing at — and the engine
 * canonicalises either spelling into one stored row, so offering both costs
 * nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Link2, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label, Select } from './ui/field';
import { Modal } from './ui/modal';

/** How each relation reads with this asset as the subject. */
const RELATION_PHRASING: Record<string, string> = {
  depends_on: 'depends on',
  supports: 'supports',
  hosted_on: 'is hosted on',
  hosts: 'hosts',
  connects_to: 'connects to',
  member_of: 'is a member of',
  contains: 'contains',
  secures: 'secures',
  secured_by: 'is secured by',
  resolves_to: 'resolves to',
  resolved_by: 'is resolved by',
  authenticates_to: 'authenticates to',
  authenticates: 'authenticates',
  backs_up: 'backs up',
  backed_up_by: 'is backed up by',
  licenses: 'licenses',
  licensed_by: 'is licensed by',
  documents: 'documents',
  documented_by: 'is documented by',
  replaces: 'replaces',
  replaced_by: 'is replaced by',
  related_to: 'is related to',
};

/** The order the picker offers them in: the ones people reach for first. */
const RELATION_ORDER = [
  'depends_on', 'supports', 'connects_to', 'hosted_on', 'hosts',
  'member_of', 'contains', 'secures', 'secured_by',
  'authenticates_to', 'authenticates', 'backs_up', 'backed_up_by',
  'resolves_to', 'resolved_by', 'licenses', 'licensed_by',
  'documents', 'documented_by', 'replaces', 'replaced_by', 'related_to',
];

export function relationPhrase(relation: string): string {
  return RELATION_PHRASING[relation] ?? relation.replace(/_/g, ' ');
}

interface Candidate {
  nodeId: string;
  title: string;
  subtitle: string | null;
}

export function DependencyEditor({
  nodeId,
  organizationId,
  canLink,
}: {
  nodeId: string;
  organizationId: string;
  canLink: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [relation, setRelation] = useState('depends_on');
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [target, setTarget] = useState<Candidate | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One in-flight search at a time. Without this, typing quickly resolves
  // responses out of order and the list flickers back to an earlier query.
  const searchSeq = useRef(0);

  const runSearch = useCallback(
    async (term: string) => {
      const seq = ++searchSeq.current;
      if (term.trim().length < 2) {
        setCandidates([]);
        return;
      }
      setSearching(true);
      try {
        const params = new URLSearchParams({ q: term.trim(), organizationId, limit: '10' });
        const response = await fetch(`/api/search?${params.toString()}`);
        if (!response.ok) return;
        const payload = (await response.json()) as {
          results?: { nodeId?: string; node_id?: string; title: string; subtitle: string | null }[];
        };
        if (seq !== searchSeq.current) return;
        setCandidates(
          (payload.results ?? [])
            .map((r) => ({
              nodeId: r.nodeId ?? r.node_id ?? '',
              title: r.title,
              subtitle: r.subtitle,
            }))
            // Only things that ARE graph nodes can be linked, and an asset
            // cannot depend on itself.
            .filter((r) => r.nodeId && r.nodeId !== nodeId),
        );
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [nodeId, organizationId],
  );

  useEffect(() => {
    const timer = setTimeout(() => void runSearch(query), 250);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  function reset() {
    setRelation('depends_on');
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
      const response = await fetch('/api/assets/links', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceNodeId: nodeId,
          relation,
          targetNodeId: target.nodeId,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? `The link could not be saved (${response.status}).`);
        return;
      }
      reset();
      setOpen(false);
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!canLink) return null;

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} className="gap-2">
        <Plus />
        Add a dependency
      </Button>

      <Modal
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title="Add a dependency"
        icon={Link2}
        description="Links are what make an impact assessment possible: what breaks if this goes offline."
      >
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="dep-relation">This asset…</Label>
            <Select
              id="dep-relation"
              value={relation}
              onChange={(e) => setRelation(e.target.value)}
            >
              {RELATION_ORDER.map((value) => (
                <option key={value} value={value}>
                  {relationPhrase(value)}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="dep-target">…this one</Label>
            <Input
              id="dep-target"
              value={target ? target.title : query}
              onChange={(e) => {
                setTarget(null);
                setQuery(e.target.value);
              }}
              placeholder="Search this client's assets"
              autoComplete="off"
            />
            {target ? (
              <FieldHint className="mt-1">
                Linking to <span className="text-ink">{target.title}</span>. Type to choose a
                different one.
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
              <ul className="mt-2 max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
                {candidates.map((candidate) => (
                  <li key={candidate.nodeId}>
                    <button
                      type="button"
                      onClick={() => {
                        setTarget(candidate);
                        setCandidates([]);
                      }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-surface-sunken"
                    >
                      <span className="text-ink">{candidate.title}</span>
                      {candidate.subtitle && (
                        <span className="ml-2 text-xs text-ink-faint">{candidate.subtitle}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <Label htmlFor="dep-note">Note</Label>
            <Input
              id="dep-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              placeholder="Optional. Why these are linked."
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy || !target}>
              {busy && <Loader2 className="animate-spin" />}
              Add dependency
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/**
 * Removing one link.
 *
 * Takes the relationship as the page is displaying it — "these two, this way
 * round" — which is what DELETE /api/assets/links expects and what the person
 * clicking is looking at. The engine resolves it to whichever direction the row
 * is actually stored in.
 *
 * Intrinsic edges get no button: they are projected from a foreign key (a
 * device's primary network, a certificate's domain), so there is no link row to
 * delete. Unlinking one means changing the asset itself.
 */
export function RemoveDependency({
  sourceNodeId,
  relation,
  targetNodeId,
}: {
  sourceNodeId: string;
  relation: string;
  targetNodeId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      const response = await fetch('/api/assets/links', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceNodeId, relation, targetNodeId }),
      });
      if (response.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={remove}
      disabled={busy}
      aria-label="Remove this dependency"
      title="Remove this dependency"
    >
      {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
    </Button>
  );
}
