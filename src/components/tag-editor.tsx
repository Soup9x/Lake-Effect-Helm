'use client';

/**
 * Tags you can take off again.
 *
 * WHAT WAS MISSING, and it was less than it looked. The API has always
 * supported removal: /api/bulk/tags takes `mode: 'remove'` and
 * bulkRemoveTags() has been in lib/bulk/service.ts since the bulk toolbar was
 * built. What existed was an ADD-only interface — the bulk bar offers "Add
 * tags" and nothing offers the other direction — and tags rendered as plain
 * badges with nothing to click.
 *
 * So this is a control over a route that was already there, not a new
 * capability, and it uses the bulk endpoint with a selection of one rather than
 * a second single-item route. One endpoint, one audit shape, one place where
 * RLS decides whether this actor may write this row.
 *
 * THE CLIENT'S OWN TAGS WERE NOT DISPLAYED ANYWHERE except the client list,
 * which is part of why removing one felt impossible: the only place you could
 * see a client's tags was the one place you could not act on a single client.
 * The detail page now shows them.
 *
 * OPTIMISTIC, and deliberately so for a removal: the chip disappears on click
 * and comes back if the server refuses. Waiting on a round trip to remove a
 * label makes the interface feel broken in exactly the case where the person is
 * tidying up several at once.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, X } from 'lucide-react';
import { Badge } from './ui/badge';
import { Input } from './ui/field';
import { Button } from './ui/button';
import { parseTagDraft } from '@/lib/ui/tags';

export function TagEditor({
  target,
  id,
  tags,
  canWrite,
}: {
  /** Matches /api/bulk/tags: a client row or an asset node. */
  target: 'client' | 'node';
  id: string;
  tags: string[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(tags);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(mode: 'add' | 'remove', values: string[]): Promise<boolean> {
    const response = await fetch('/api/bulk/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target, ids: [id], tags: values, mode }),
    });
    if (!response.ok) return false;
    // `affected` is the count of rows the UPDATE actually matched. Zero means
    // RLS refused this row, which is a 200 with nothing done — reporting
    // success there would show a tag removed that is still on the record.
    const body = (await response.json().catch(() => null)) as { affected?: number } | null;
    return (body?.affected ?? 0) > 0;
  }

  async function remove(tag: string) {
    const previous = current;
    setBusy(tag);
    setError(null);
    setCurrent((list) => list.filter((t) => t !== tag));
    try {
      if (!(await call('remove', [tag]))) {
        setCurrent(previous);
        setError(`"${tag}" could not be removed.`);
        return;
      }
      router.refresh();
    } catch {
      setCurrent(previous);
      setError('The request did not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const values = parseTagDraft(draft, current);
    if (values.length === 0) {
      setDraft('');
      setAdding(false);
      return;
    }
    const previous = current;
    setBusy('__add__');
    setError(null);
    setCurrent((list) => [...list, ...values]);
    try {
      if (!(await call('add', values))) {
        setCurrent(previous);
        setError('Those tags could not be added.');
        return;
      }
      setDraft('');
      setAdding(false);
      router.refresh();
    } catch {
      setCurrent(previous);
      setError('The request did not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  if (!canWrite && current.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {current.map((tag) => (
        <Badge key={tag} tone="neutral" className="gap-1 pr-1">
          {tag}
          {canWrite && (
            <button
              type="button"
              onClick={() => remove(tag)}
              disabled={busy !== null}
              aria-label={`Remove the ${tag} tag`}
              className="rounded-sm p-0.5 text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
            >
              {busy === tag ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : (
                <X className="size-3" aria-hidden />
              )}
            </button>
          )}
        </Badge>
      ))}

      {canWrite &&
        (adding ? (
          <form onSubmit={add} className="flex items-center gap-1">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => !draft.trim() && setAdding(false)}
              placeholder="tag, tag"
              autoFocus
              maxLength={200}
              className="h-7 w-40 text-xs"
              disabled={busy === '__add__'}
            />
            <Button type="submit" size="sm" variant="secondary" disabled={busy === '__add__'}>
              {busy === '__add__' ? <Loader2 className="animate-spin" /> : 'Add'}
            </Button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-0.5 rounded-md border border-dashed border-border px-1.5 py-0.5 text-xs text-ink-faint transition-colors hover:border-brand hover:text-brand"
          >
            <Plus className="size-3" aria-hidden />
            Tag
          </button>
        ))}

      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
