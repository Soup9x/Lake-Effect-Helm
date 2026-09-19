'use client';

/**
 * The re-authentication prompt.
 *
 * WHAT IT REPLACES. Two components rendered "Re-authenticate to view this
 * credential, then try again" and one offered a "Critical" sensitivity that
 * could never be saved. None of those instructions could be followed: there was
 * no step-up anywhere in the product. helm.record_step_up() had been sitting in
 * the schema since 0340, correct and uncalled.
 *
 * A HOOK RATHER THAN A `<StepUpDialog>` THE CALLER RENDERS CONDITIONALLY.
 * The prompt has to interrupt an action in flight and then let it continue,
 * which is a promise, not a render. `useStepUp()` hands back a `prompt()` that
 * resolves true when the person re-authenticated and false when they gave up —
 * so a caller reads as the sequence it actually is:
 *
 *     const result = await withStepUp(attempt, stepUp.prompt);
 *
 * rather than as a state machine spread across three effects. The dialog itself
 * is returned as an element the caller drops into its tree.
 *
 * THE PASSWORD NEVER LEAVES THIS COMPONENT except in the body of the POST to
 * /api/auth/step-up, and it is cleared on every close — including the closes
 * that are not a submit (Escape, the backdrop, the X). Radix unmounts the
 * content, but the state lives here, and a password left in a closed dialog's
 * state is a password still in the tab.
 *
 * WHY A PASSWORD AND NOT A SECOND FACTOR. It is the factor this product has.
 * step_up_verification.method already permits 'webauthn', 'totp' and
 * 'sso_reauth'; 0340's own header describes the password path. When one of the
 * others is built, it belongs here as another way to satisfy the same prompt.
 */
import { useCallback, useRef, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from './ui/button';
import { Input, Label } from './ui/field';
import { Modal } from './ui/modal';

export interface UseStepUp {
  /**
   * Open the prompt and resolve once it is settled: true if the person
   * re-authenticated, false if they dismissed it.
   */
  prompt: () => Promise<boolean>;
  /** Drop this into the tree. Renders nothing while closed. */
  dialog: React.ReactNode;
}

export function useStepUp(): UseStepUp {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The waiting caller's resolver.
   *
   * A ref rather than state: settling it must not depend on a re-render having
   * happened, and storing a function in useState would have React call it as a
   * lazy initialiser.
   */
  const settle = useRef<((verified: boolean) => void) | null>(null);

  const finish = useCallback((verified: boolean) => {
    setOpen(false);
    setPassword('');
    setBusy(false);
    setError(null);
    settle.current?.(verified);
    settle.current = null;
  }, []);

  const prompt = useCallback(() => {
    setError(null);
    setPassword('');
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      settle.current = resolve;
    });
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/step-up', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        finish(true);
        return;
      }

      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      // Stays open on a wrong password. Closing would drop the caller back to
      // its own refusal message and hide the one that says what went wrong
      // here, which is how somebody concludes the button is broken.
      setError(body?.error?.message ?? `Verification failed (${response.status}).`);
      setPassword('');
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <Modal
      open={open}
      // Escape, the backdrop and the X all land here. Each of them is a
      // dismissal, and the caller is told so rather than left awaiting a
      // promise nothing will settle.
      onOpenChange={(next) => {
        if (!next) finish(false);
      }}
      title="Confirm it is you"
      icon={ShieldCheck}
      description="This credential requires a fresh re-authentication. Your password is not stored and no new session is created."
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="step-up-password">Your Helm password</Label>
          <Input
            id="step-up-password"
            type="password"
            autoComplete="current-password"
            // The dialog exists to be typed into the moment it opens.
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
        </div>

        {error && (
          <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-ink">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => finish(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || password.length === 0}>
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            Verify
          </Button>
        </div>
      </form>
    </Modal>
  );

  return { prompt, dialog };
}
