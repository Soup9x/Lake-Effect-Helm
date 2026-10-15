'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint } from './ui/field';
import { KIND_LABELS, NOTIFICATION_KINDS, type NotificationKind } from '@/lib/notifications/kinds';
import type { NotificationPreference } from '@/lib/email/preferences';

type Feedback = { ok: boolean; message: string } | null;

/**
 * What I want to be emailed about.
 *
 * NOBODY ELSE CAN SET THIS, and that is enforced below the route: RLS on
 * user_notification_preference admits only rows where
 * `user_id = helm.current_actor_id()`, so there is no administrator screen for
 * it and no policy that would allow one. Same rule as the sidebar and the
 * dashboard, and for the stronger reason that what somebody chooses to be told
 * about says something about what they are watching.
 *
 * UNTICKING EVERYTHING IS A REAL ANSWER, not a reset to the default. The
 * difference is the whole reason `configured` exists: a saved empty list means
 * "nothing", and if it fell back to the shipped default the control would
 * appear to do nothing at all.
 *
 * AND IT SAYS SO WHEN THERE IS NO RELAY. A toggle with nothing behind it is a
 * control that lies — the tenant has to have configured mail before any of
 * this arrives, and that is an administrator's job on the settings page, so the
 * only honest thing to do here is say which of the two is missing.
 */
export function NotificationPreferencesCard({ initial }: { initial: NotificationPreference }) {
  const [kinds, setKinds] = useState<NotificationKind[]>([...initial.kinds]);
  const [saved, setSaved] = useState<NotificationKind[]>([...initial.kinds]);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  // Compared as sets in the catalogue's order, which normaliseKinds guarantees
  // on both sides — so this is a content comparison, not a reference one.
  const dirty = kinds.length !== saved.length || kinds.some((k, i) => k !== saved[i]);

  function toggle(kind: NotificationKind) {
    setFeedback(null);
    setKinds((current) => (
      current.includes(kind)
        ? current.filter((k) => k !== kind)
        : NOTIFICATION_KINDS.filter((k) => k === kind || current.includes(k))
    ));
  }

  async function save() {
    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch('/api/account/notifications', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kinds }),
      });
      const payload = (await response.json().catch(() => null)) as
        | (NotificationPreference & { error?: { message?: string } })
        | null;

      if (!response.ok) {
        setFeedback({
          ok: false,
          message: payload?.error?.message ?? `Save failed (${response.status}).`,
        });
        return;
      }

      // Taken from the response rather than from local state: the server
      // normalises the list, and believing the input is what was stored is how
      // a form and a database come to disagree.
      const stored = payload?.kinds ?? kinds;
      setKinds([...stored]);
      setSaved([...stored]);
      setFeedback({
        ok: true,
        message: stored.length === 0
          ? 'Saved. You will not be emailed about either of these.'
          : 'Saved.',
      });
    } catch {
      setFeedback({ ok: false, message: 'The request did not reach the server.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-ink-muted">
        Email about your own work. These are yours alone — no administrator can set
        them for you, and nobody else can see what you chose.
      </p>

      {!initial.emailConfigured && (
        <p className="max-w-3xl rounded-md border border-border bg-surface-sunken p-2.5 text-xs text-ink-muted">
          Your MSP has not set up a mail relay yet, so nothing will arrive whatever you
          choose here. Your choice is kept and takes effect the moment one is configured —
          an administrator does that under Settings.
        </p>
      )}

      <div className="space-y-2.5">
        {NOTIFICATION_KINDS.map((kind) => (
          <label key={kind} className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={kinds.includes(kind)}
              onChange={() => toggle(kind)}
            />
            <span>
              <span className="text-ink">{KIND_LABELS[kind].title}</span>
              <FieldHint>{KIND_LABELS[kind].hint}</FieldHint>
            </span>
          </label>
        ))}
      </div>

      {feedback && (
        <div
          role="status"
          className={
            feedback.ok
              ? 'flex items-start gap-2 rounded-md border border-ok/30 bg-ok/5 p-2.5 text-xs text-ok'
              : 'flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger'
          }
        >
          {feedback.ok ? (
            <CheckCircle2 aria-hidden className="mt-px size-3.5 shrink-0" />
          ) : (
            <ShieldAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          )}
          {feedback.message}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="primary" disabled={saving || !dirty} onClick={save}>
          {saving && <Loader2 aria-hidden className="animate-spin" />}
          Save
        </Button>
        {kinds.length === 0 && dirty && (
          <span className="text-xs text-ink-faint">
            Saving none of them means none — not the default.
          </span>
        )}
      </div>
    </div>
  );
}
