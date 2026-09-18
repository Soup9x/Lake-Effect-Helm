'use client';

/**
 * Linking one asset to another.
 *
 * TWO THINGS WERE WRONG HERE, and they were unrelated.
 *
 * THE SEARCH RETURNED NOTHING, FOR EVERY QUERY. Not a scoping bug and not a
 * missing index: /api/search was reached, ran correctly and returned properly
 * tenant-scoped hits. This component read them from `payload.results`, and the
 * response has no such key — it is `{ hits, groups, limit, offset, hasMore }`.
 * `undefined ?? []` is an empty list, so every search silently produced
 * nothing. It now reads `hits`, and a test asserts the key by name so a rename
 * on either side fails loudly instead of emptying the picker again.
 *
 * THE FORM ASKED A QUESTION NOBODY HAD. It opened with "This asset [depends on
 * ▾] this one" and twenty-two relations to choose between — and the honest
 * answer to most of them is "it depends which end you are standing at". What a
 * technician wants to record is that two things are connected, and why. So the
 * form asks for the asset and an optional note, and sends `related_to`, which
 * is its own inverse and therefore canonicalises to one row whichever way round
 * it was entered.
 *
 * The relation vocabulary is NOT gone from the product. Intrinsic edges carry
 * real relations projected from foreign keys, and the impact graph still
 * traverses direction. It is gone from the question a person is asked.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Link2, Loader2, Plus, X } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';
import { Modal } from './ui/modal';

interface Candidate {
  nodeId: string;
  title: string;
  subtitle: string | null;
}

/** The shape /api/search actually returns. Named here so a drift is a type error. */
interface SearchResponse {
  hits?: { nodeId: string | null; title: string; subtitle: string | null }[];
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
        const payload = (await response.json()) as SearchResponse;
        if (seq !== searchSeq.current) return;
        setCandidates(
          (payload.hits ?? [])
            // Only things that ARE graph nodes can be linked — a site or a
            // client is a search hit with no node — and an asset cannot be
            // linked to itself.
            .filter((hit) => hit.nodeId !== null && hit.nodeId !== nodeId)
            .map((hit) => ({
              nodeId: hit.nodeId as string,
              title: hit.title,
              subtitle: hit.subtitle,
            })),
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
            <Label htmlFor="dep-target">Link to</Label>
            <Input
              id="dep-target"
              value={target ? target.title : query}
              onChange={(e) => {
                setTarget(null);
                setQuery(e.target.value);
              }}
              placeholder="Search this client&rsquo;s assets"
              autoComplete="off"
              autoFocus
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
 * One dependency, as a chip that goes where it says.
 *
 * The whole chip is the link, so the target is the obvious click rather than a
 * small piece of text beside a label. The remove control sits inside it and
 * stops the navigation, which is the one interaction that needs to not follow
 * the link.
 *
 * `relation` is not rendered, but it IS passed to the delete call: an edge
 * created before this change carries a real relation, and DELETE resolves the
 * row by (source, relation, target). Dropping it from the payload would leave
 * older links un-removable.
 */
export function DependencyChip({
  href,
  label,
  kind,
  note,
  removable,
  sourceNodeId,
  relation,
  targetNodeId,
}: {
  href: string;
  label: string;
  kind: string;
  note: string | null;
  removable: boolean;
  sourceNodeId: string;
  relation: string;
  targetNodeId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
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
    <a
      href={href}
      title={note ?? undefined}
      className="group inline-flex max-w-full items-center gap-2 rounded-full border border-border-strong bg-surface-raised py-1 pl-3 pr-1 text-sm text-ink transition-colors hover:border-brand hover:bg-surface-sunken"
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-xs text-ink-faint">{kind}</span>
      {removable ? (
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          aria-label={`Remove the link to ${label}`}
          title={`Remove the link to ${label}`}
          className="shrink-0 rounded-full p-1 text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
        </button>
      ) : (
        // Intrinsic edges are projected from a foreign key, so there is no row
        // to delete — unlinking one means editing the asset itself. The spacer
        // keeps the chips a consistent height.
        <span className="w-5 shrink-0" aria-hidden />
      )}
    </a>
  );
}
