'use client';

/**
 * When the team is warned that something is about to expire.
 *
 * Edits the tenant's default alert rule (0730). Where a warning GOES is not
 * decided here: it is queued for every notification destination subscribed to
 * "Expiring soon", and the form says so, because "I turned alerts on and
 * nothing arrived" is otherwise the first support question.
 *
 * Re-seeds its draft when the dialog opens, for the reason health-window-form
 * gives: after a save, router.refresh() delivers new props while the draft
 * still holds the old values.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';
import { Modal, ModalTrigger } from './ui/modal';
import { LEAD_DAY_MAX, MAX_LEAD_DAYS, parseLeadDays, type ExpiryAlertSetting } from '@/lib/alerts/expiry';
import { apiFetch } from '@/lib/ui/api';

export function ExpiryAlertForm({
  setting,
  trigger,
}: {
  setting: ExpiryAlertSetting;
  trigger: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(setting.enabled);
  const [leadDays, setLeadDays] = useState(setting.leadDays.join(', '));

  function openWith(next: boolean) {
    if (next) {
      setEnabled(setting.enabled);
      setLeadDays(setting.leadDays.join(', '));
      setError(null);
    }
    setOpen(next);
  }

  async function save() {
    const parsed = parseLeadDays(leadDays);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch('/api/tenant/expiry-alerts', {
        method: 'PUT',
        json: { enabled, leadDays: parsed.leadDays },
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
      <ModalTrigger onOpen={() => openWith(true)}>{trigger}</ModalTrigger>
      <Modal
        open={open}
        onOpenChange={openWith}
        title="Expiry warnings"
        description="Certificates, domains, warranties and contracts, across every client."
      >
        <div className="space-y-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium text-ink">Warn before things expire</span>
              <FieldHint>
                One warning per item at each lead time below, never repeated. If several lead
                times have already passed — a certificate added a week before it expires — only
                the most urgent is sent.
              </FieldHint>
            </span>
          </label>

          <div className="space-y-1.5">
            <Label htmlFor="lead-days">Days before expiry</Label>
            <Input
              id="lead-days"
              inputMode="numeric"
              value={leadDays}
              disabled={!enabled}
              onChange={(event) => setLeadDays(event.target.value)}
            />
            <FieldHint>
              Up to {MAX_LEAD_DAYS}, separated by commas, each from 0 (the day itself)
              to {LEAD_DAY_MAX}.
            </FieldHint>
          </div>

          <p className="rounded-md bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
            Warnings go to every notification destination subscribed to
            &ldquo;Expiring soon&rdquo; in the notification settings on this page. With none
            subscribed they are recorded and not sent.
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
