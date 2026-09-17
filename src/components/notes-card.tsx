'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { NotebookPen, Pencil } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Textarea } from './ui/field';

const LIMIT = 4000;

/**
 * Free-text context on a client, a site, an asset or a credential.
 *
 * ONE component for all four, taking the endpoint rather than the kind. The
 * field means the same thing everywhere it appears — "what somebody needs to
 * know about this that the structured fields do not say" — and a component per
 * entity is how that stops being true: four copies, and by the third one has a
 * character counter the others lack and a save button in a different place.
 *
 * Deliberately not versioned, not threaded and not attributed. Notes are
 * informal; a SOP, a flexible asset or an attachment is where something that
 * has to be findable, reviewable and dated belongs. A comment system nobody
 * maintains is worse than a text box everybody understands.
 */
export function NotesCard({
  endpoint,
  notes,
  canEdit,
  title = 'Notes',
}: {
  /** The PATCH endpoint for the thing these notes belong to. */
  endpoint: string;
  notes: string | null;
  canEdit: boolean;
  title?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        // Emptied means cleared, not "an empty string". null is what the column
        // holds for "nothing written here", and it is what every reader checks.
        body: JSON.stringify({ notes: value.trim() === '' ? null : value.trim() }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? `Saving failed (${response.status}).`);
        return;
      }
      setEditing(false);
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <NotebookPen className="size-4 text-ink-faint" aria-hidden /> {title}
        </CardTitle>
        {canEdit && !editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)} className="gap-1.5">
            <Pencil className="size-3.5" aria-hidden />
            {notes ? 'Edit' : 'Add'}
          </Button>
        )}
      </CardHeader>
      <CardContent className="text-sm">
        {editing ? (
          <form onSubmit={save} className="space-y-2">
            <Textarea
              value={value}
              onChange={(event) => setValue(event.target.value.slice(0, LIMIT))}
              rows={6}
              autoFocus
              placeholder="Anything the next person opening this would want to know."
            />
            <div className="flex items-center justify-between gap-3">
              <FieldHint>
                {value.length} / {LIMIT}
              </FieldHint>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setValue(notes ?? '');
                    setEditing(false);
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
          </form>
        ) : notes ? (
          // whitespace-pre-wrap: somebody typed line breaks and meant them.
          <p className="whitespace-pre-wrap break-words text-ink-muted">{notes}</p>
        ) : (
          <p className="text-ink-faint">
            {canEdit ? 'Nothing noted yet.' : 'Nothing noted.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
