'use client';

/**
 * Writing down a procedure.
 *
 * ITS OWN FORM RATHER THAN NewAssetForm, for the reason POST /api/sops exists
 * rather than a line in /api/assets: a procedure's payload is its steps, and
 * the generic asset form would create the node and stop. What it asks for here
 * is the frame — what the procedure is called, what it is for, how often it
 * should be re-read — and the steps are written on the procedure's own page,
 * where there is room for them.
 *
 * THE REVIEW INTERVAL IS OFFERED HERE because an SOP with one takes part in the
 * expirations pane the moment it exists: 0090 gave `sop` review_interval_days
 * and last_reviewed_at precisely so "procedures rot" is surfaced in the same
 * place as an expiring certificate. Leaving it to a later edit means the ones
 * nobody edits are the ones that silently never get reviewed.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { Modal } from './ui/modal';

/** Intervals that mean something to somebody, rather than a free number box. */
const REVIEW_INTERVALS: [string, string][] = [
  ['', 'No review schedule'],
  ['90', 'Every three months'],
  ['180', 'Every six months'],
  ['365', 'Once a year'],
  ['730', 'Every two years'],
];

export function NewProcedureForm({
  organizationId,
  open,
  onOpenChange,
}: {
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [summary, setSummary] = useState('');
  const [reviewInterval, setReviewInterval] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/sops', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          name: name.trim(),
          ...(category.trim() === '' ? {} : { category: category.trim() }),
          ...(summary.trim() === '' ? {} : { summary: summary.trim() }),
          ...(reviewInterval === '' ? {} : { reviewIntervalDays: Number(reviewInterval) }),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `The procedure could not be created (${response.status}).`);
        return;
      }
      const created = (await response.json().catch(() => null)) as { sopId?: string } | null;
      onOpenChange(false);
      // Straight to the procedure, because the next thing to do is write its
      // steps and that is where they live.
      if (created?.sopId) router.push(`/assets/${created.sopId}`);
      else router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New procedure"
      icon={BookOpen}
      description="The frame now, the steps on the next screen — a checklist is easier to write with room for it."
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="sop-name">Name</Label>
          <Input
            id="sop-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            maxLength={200}
            placeholder="Offboard a user"
          />
        </div>

        <div>
          <Label htmlFor="sop-category">Category</Label>
          <Input
            id="sop-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            maxLength={80}
            placeholder="Lifecycle, Recovery, Onboarding…"
          />
          <FieldHint>Free text, used to group procedures in lists.</FieldHint>
        </div>

        <div>
          <Label htmlFor="sop-summary">What it is for</Label>
          <Textarea
            id="sop-summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={2}
            maxLength={2000}
          />
        </div>

        <div>
          <Label htmlFor="sop-review">Review</Label>
          <Select
            id="sop-review"
            value={reviewInterval}
            onChange={(e) => setReviewInterval(e.target.value)}
          >
            {REVIEW_INTERVALS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <FieldHint>
            A procedure past its review date appears in the expirations pane beside an expiring
            certificate. Procedures rot quietly otherwise.
          </FieldHint>
        </div>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy || name.trim() === ''}>
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            Create
          </Button>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
