'use client';

/**
 * How long before documentation counts as having gone quiet.
 *
 * TWO NUMBERS, AND THE FORM SAYS WHAT EACH ONE MEANS, because they are easy to
 * confuse and the consequence of confusing them is a ring that reports the
 * wrong thing on every client. "Not revised" is about whether the
 * documentation is still correct; "not opened" is about whether anybody still
 * needs it. The first leads to a correction, the second to a retirement.
 *
 * IT CHANGES WHAT EVERY CLIENT READS AS, and the form says that too. This is
 * not a per-user display preference — move it from 180 days to 90 and every
 * client's ring grows a warning segment at once. Somebody doing that should
 * know before they save, not find out from a colleague.
 *
 * Re-seeds its draft when the dialog OPENS, which is C2's lesson: after a
 * successful save, router.refresh() delivers the new values as props while the
 * draft still holds the pre-edit ones, so reopening would offer to put them
 * back.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';
import { Modal } from './ui/modal';
import { HEALTH_DAYS_MAX, HEALTH_DAYS_MIN, type HealthSetting } from '@/lib/health/window';
import { apiFetch } from '@/lib/ui/api';

export function HealthWindowForm({
  setting,
  trigger,
}: {
  setting: HealthSetting;
  trigger: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(String(setting.staleAfterDays));
  const [unviewed, setUnviewed] = useState(String(setting.unviewedAfterDays));

  function openWith(next: boolean) {
    if (next) {
      setStale(String(setting.staleAfterDays));
      setUnviewed(String(setting.unviewedAfterDays));
      setError(null);
    }
    setOpen(next);
  }

  async function save() {
    const staleDays = Number.parseInt(stale, 10);
    const unviewedDays = Number.parseInt(unviewed, 10);
    for (const [label, value] of [['revised', staleDays], ['opened', unviewedDays]] as const) {
      if (!Number.isFinite(value) || value < HEALTH_DAYS_MIN || value > HEALTH_DAYS_MAX) {
        setError(
          `The "not ${label}" window must be between ${HEALTH_DAYS_MIN} and `
          + `${HEALTH_DAYS_MAX} days.`,
        );
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch('/api/tenant/documentation-health', {
        method: 'PUT',
        json: {
          staleAfterDays: staleDays,
          unviewedAfterDays: unviewedDays,
        },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* The same trigger shape every other modal in this project uses: the
          caller renders the button, this wraps it. A server component cannot
          pass a component reference across the boundary. */}
      <span onClick={() => openWith(true)}>{trigger}</span>
      <Modal
        open={open}
        onOpenChange={openWith}
        title="Documentation health"
        description="What counts as having gone quiet. These windows apply to every client at once."
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="stale-days">Not revised after</Label>
            <Input
              id="stale-days"
              type="number"
              inputMode="numeric"
              min={HEALTH_DAYS_MIN}
              max={HEALTH_DAYS_MAX}
              value={stale}
              onChange={(event) => setStale(event.target.value)}
            />
            <FieldHint>
              Days since a record was last edited. Past this it is counted as stale —
              the documentation may no longer match what is installed.
            </FieldHint>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="unviewed-days">Not opened after</Label>
            <Input
              id="unviewed-days"
              type="number"
              inputMode="numeric"
              min={HEALTH_DAYS_MIN}
              max={HEALTH_DAYS_MAX}
              value={unviewed}
              onChange={(event) => setUnviewed(event.target.value)}
            />
            <FieldHint>
              Days since anybody on your team opened it. A different question: it
              says what nobody needs any more, not what is wrong. Helm records
              when a record was opened and never by whom.
            </FieldHint>
          </div>

          <p className="rounded-md bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
            Changing these changes what every client&rsquo;s health reads as, at once.
            Nothing is edited and nothing is deleted — only the line between
            &ldquo;recent&rdquo; and &ldquo;a while ago&rdquo; moves.
          </p>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void save()} disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Save
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
