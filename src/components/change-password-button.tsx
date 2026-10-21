'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Loader2, Pencil } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';
import { Modal } from './ui/modal';
import { PasswordGenerator } from './password-generator';
import { useStepUp } from './step-up-dialog';
import { iconActionClass } from './field-row';
import { withStepUp } from '@/lib/ui/step-up';
import { apiFetch } from '@/lib/ui/api';

/**
 * Changing a credential's password, from the Password row itself.
 *
 * A ROTATION, NOT AN EDIT. The new value is stored as a new version through
 * /api/secrets/:id/rotate; the old one is superseded rather than overwritten,
 * so an export taken yesterday still makes sense, and the reason is what the
 * audit log says a year from now. That is why the reason is required here
 * when nothing else on the row asks for one.
 *
 * The value only ever travels to the server. Nothing here reads the current
 * password, and the box is emptied whether the save succeeds or is cancelled.
 */
export function ChangePasswordButton({ secretId, label }: { secretId: string; label: string }) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setValue('');
      setReason('');
      setError(null);
    }
  };

  // Read at call time, so the step-up retry sends what is in the boxes then.
  const attempt = () =>
    apiFetch<{ version?: number } | undefined>(`/api/secrets/${secretId}/rotate`, {
      json: { value, reason: reason.trim() },
    });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await withStepUp(attempt, stepUp.prompt);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      reset(false);
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {stepUp.dialog}
      <button
        type="button"
        className={iconActionClass}
        onClick={() => setOpen(true)}
        title="Change password"
        aria-label={`Change ${label}`}
      >
        <Pencil aria-hidden />
      </button>

      <Modal
        open={open}
        onOpenChange={reset}
        title="Change password"
        icon={KeyRound}
        description="Stored as a new version. The previous one is superseded, not deleted."
      >
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`new-password-${secretId}`}>New password</Label>
            <div className="flex gap-2">
              <Input
                id={`new-password-${secretId}`}
                type="password"
                value={value}
                autoComplete="new-password"
                onChange={(e) => setValue(e.target.value)}
                // The dialog exists to be typed into the moment it opens.
                autoFocus
              />
              <PasswordGenerator onUse={setValue} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`change-reason-${secretId}`}>Why</Label>
            <Input
              id={`change-reason-${secretId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. rotated after the Miller offboarding"
              maxLength={500}
            />
            <FieldHint>At least ten characters. Recorded in the audit log with the change.</FieldHint>
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => reset(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !value || reason.trim().length < 10}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Save password
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
