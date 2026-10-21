'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from './ui/button';
import { Input, Label } from './ui/field';
import { useStepUp } from './step-up-dialog';
import { FieldLine, iconActionClass } from './field-row';
import { STEP_UP_CODE, withStepUp } from '@/lib/ui/step-up';
import { apiFetch } from '@/lib/ui/api';
import { copyAudited, copyFailureMessage, type CopyOutcome } from '@/lib/ui/clipboard';
import { cn } from '@/lib/ui/cn';

/**
 * Revealing a credential.
 *
 * THE IMPORTANT PART: this is a client component that fetches from the API, and
 * that is not a stylistic choice. A server component rendering the plaintext
 * would put it in the RSC payload, in Next's data cache, in any reverse proxy
 * or CDN between the server and the browser, and in the browser's own back-
 * forward cache. Fetching it into a client component keeps the plaintext in one
 * tab's memory, tied to the click that asked for it and to the audit row the
 * database wrote in the same transaction.
 *
 * Three further deliberate behaviours:
 *
 *   The value auto-hides after a timeout and is dropped from state, so a
 *   technician who walks away from a screen-shared session does not leave a
 *   domain admin password on it.
 *
 *   A copy is a SEPARATE audited call. "Was it copied" is a different question
 *   from "was it looked at" — one of them means it probably left the building,
 *   so the copy button posts its own event before the text moves. What it then
 *   writes is the plaintext ALREADY on screen: /copy records, it does not
 *   decrypt, and asking the server for the value a second time would hand
 *   plaintext to a `secret:read` holder through a route that never required
 *   `secret:reveal`. For a long time this component wrote `body.value` from
 *   that recording response, a field that does not exist, and put the word
 *   `undefined` on the clipboard under a green "Copied". See
 *   src/lib/ui/clipboard.ts.
 *
 *   A QUICK COPY skips the display. It is a reveal with purpose 'copy', so the
 *   same gate decides it and the database writes one audit row saying the
 *   value was taken for copying rather than looked at — which is the truth.
 *   The plaintext goes from the response to the clipboard and is never put in
 *   state, so there is nothing on screen to hide afterwards. /copy is not
 *   called: it records a copy of a value already revealed, and this one was
 *   not.
 *
 *   A refusal renders its cause and its audit event id. When a technician says
 *   "it says I can't see this", support answers with one audit lookup instead
 *   of a log trawl.
 *
 * AND ONE REFUSAL IS NOW ACTIONABLE. `step_up_required` used to render the
 * sentence "Re-authenticate to view this credential, then try again" — advice
 * with nothing behind it, because the product had no step-up anywhere.
 * helm.record_step_up() had been in the schema since 0340 and was called by
 * nothing. The refusal now opens the prompt, and a success retries the reveal
 * the person actually asked for; see src/lib/ui/step-up.ts for the retry rule.
 */
const AUTO_HIDE_MS = 45_000;

interface RevealState {
  status: 'idle' | 'loading' | 'shown' | 'denied' | 'error';
  value?: string;
  message?: string;
  auditEventUid?: string;
  needsReason?: boolean;
  needsStepUp?: boolean;
}

/** The JSON a granted reveal returns. */
interface RevealOk {
  value: string;
  auditEventUid?: string;
}

export function RevealButton({
  secretId,
  label,
  requiresReason,
  requiresStepUp,
  extraAction,
}: {
  secretId: string;
  label: string;
  requiresReason: boolean;
  requiresStepUp: boolean;
  /** Another action on the same line, before show and copy — such as changing it. */
  extraAction?: ReactNode;
}) {
  const stepUp = useStepUp();
  const [state, setState] = useState<RevealState>({ status: 'idle' });
  const [reason, setReason] = useState('');
  const [copyOutcome, setCopyOutcome] = useState<CopyOutcome | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which of the two a refusal's retry should repeat.
  const lastAttempt = useRef<'view' | 'copy'>('view');

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setState({ status: 'idle' });
    setCopyOutcome(null);
  };

  /**
   * One attempt at the reveal, reduced to granted-or-refused.
   *
   * Deliberately NOT capturing `reason` in a closure variable read later: the
   * retry re-runs this, and it must send whatever is in the box at that moment
   * — the person may have typed a justification while the prompt was open.
   */
  const attemptReveal = (purpose: 'view' | 'copy') =>
    apiFetch<RevealOk>(`/api/secrets/${secretId}/reveal`, {
      json: { purpose, ...(reason ? { reason } : {}) },
    });

  const refused = (result: { message: string; code?: string; auditEventUid?: string }) =>
    setState({
      status: 'denied',
      message: result.message,
      ...(result.auditEventUid ? { auditEventUid: result.auditEventUid } : {}),
      needsReason: result.code === 'reason_required',
      needsStepUp: result.code === STEP_UP_CODE,
    });

  const reveal = async () => {
    lastAttempt.current = 'view';
    setState({ status: 'loading' });
    try {
      // A step-up refusal opens the prompt and, on success, retries once. Any
      // other refusal falls straight through — a password box cannot fix a rank
      // that is too low, and offering one would say it can.
      const result = await withStepUp(() => attemptReveal('view'), stepUp.prompt);

      if (!result.ok) {
        refused(result);
        return;
      }

      setState({
        status: 'shown',
        value: result.value.value,
        ...(result.value.auditEventUid ? { auditEventUid: result.value.auditEventUid } : {}),
      });
      timer.current = setTimeout(hide, AUTO_HIDE_MS);
    } catch {
      setState({ status: 'error', message: 'The request failed. Check your connection and retry.' });
    }
  };

  const quickCopy = async () => {
    lastAttempt.current = 'copy';
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopyOutcome(null);
    setState({ status: 'loading' });
    try {
      const result = await withStepUp(() => attemptReveal('copy'), stepUp.prompt);
      if (!result.ok) {
        refused(result);
        return;
      }
      // The reveal was the recording, so there is nothing left to record.
      const outcome = await copyAudited({ value: result.value.value, record: async () => true });
      setState({ status: 'idle' });
      setCopyOutcome(outcome);
      if (outcome === 'copied') {
        copyTimer.current = setTimeout(() => setCopyOutcome(null), 2500);
      }
    } catch {
      setState({ status: 'error', message: 'The request failed. Check your connection and retry.' });
    }
  };

  const copy = async () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);

    const outcome = await copyAudited({
      // The plaintext this component is already displaying. Only reachable
      // while status === 'shown', which is the only state that renders the
      // button — but copyAudited checks rather than trusting that.
      value: state.value,
      // The audit event, and nothing else: the route answers {auditEventUid}.
      // No `reason` is sent because there is nowhere for one to go —
      // helm.record_secret_copy() takes a field and no justification, and the
      // route's schema drops any other key.
      record: async () => (await apiFetch(`/api/secrets/${secretId}/copy`, { json: {} })).ok,
    });

    setCopyOutcome(outcome);
    // Clear the success line on its own; a failure stays until the value hides
    // or the person tries again, because it is asking them to do something.
    if (outcome === 'copied') {
      copyTimer.current = setTimeout(() => setCopyOutcome(null), 2500);
    }
  };

  const needsReason = requiresReason || state.needsReason;
  const copyFailure = copyOutcome ? copyFailureMessage(copyOutcome) : null;
  const blocked = state.status === 'loading' || (Boolean(needsReason) && reason.trim().length < 10);

  const shown = state.status === 'shown';
  const copied = copyOutcome === 'copied';

  return (
    <div className="space-y-1.5" data-secret>
      {stepUp.dialog}
      <FieldLine
        mono
        actions={
          <>
            {extraAction}
            <button
              type="button"
              className={iconActionClass}
              onClick={shown ? hide : reveal}
              disabled={!shown && blocked}
              title={shown ? 'Hide' : requiresStepUp ? 'Reveal (asks you to confirm it is you)' : 'Reveal'}
              aria-label={`${shown ? 'Hide' : 'Reveal'} ${label}`}
            >
              {state.status === 'loading' && lastAttempt.current === 'view' ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : shown ? (
                <EyeOff aria-hidden />
              ) : (
                <Eye aria-hidden />
              )}
            </button>
            <button
              type="button"
              className={iconActionClass}
              // On screen, copy what is shown and record it; hidden, reveal
              // for copying and never show it.
              onClick={shown ? copy : quickCopy}
              disabled={!shown && blocked}
              title={shown ? 'Copy (recorded)' : 'Copy without showing it (recorded)'}
              aria-label={`Copy ${label}`}
            >
              {state.status === 'loading' && lastAttempt.current === 'copy' ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : copied ? (
                <Check className="text-ok" aria-hidden />
              ) : (
                <Copy aria-hidden />
              )}
            </button>
          </>
        }
      >
        {shown ? (
          <span className="select-all">{state.value}</span>
        ) : (
          // A fixed run of dots, so the mask says nothing about the length.
          <>
            <span className="tracking-[0.2em] text-ink-muted" aria-hidden>••••••••••••</span>
            <span className="sr-only">Hidden</span>
          </>
        )}
      </FieldLine>

      {needsReason && !shown && (
        <div className="space-y-1">
          <Label htmlFor={`reason-${secretId}`}>Reason (recorded in the audit log)</Label>
          <Input
            id={`reason-${secretId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ticket number and what you are doing"
            minLength={10}
          />
        </div>
      )}

      {(shown || copied || copyFailure) && (
        <p className="text-xs text-ink-faint">
          {shown && `Hides automatically in ${AUTO_HIDE_MS / 1000}s.`}
          {copied && <span className={cn('text-ok', shown && 'ml-2')}>Copied — recorded as a copy event.</span>}
          {copyFailure && <span className={cn('text-danger', shown && 'ml-2')}>{copyFailure}</span>}
        </p>
      )}

      {(state.status === 'denied' || state.status === 'error') && (
        <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-ink">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
          <div>
            <p>{state.message}</p>
            {state.needsStepUp && (
              // Reached only when the prompt was dismissed or its verification
              // did not hold — withStepUp has already offered it once. A button
              // rather than the old sentence, which told the person to do
              // something the product could not do.
              <Button
                variant="secondary"
                size="sm"
                className="mt-2"
                onClick={() => (lastAttempt.current === 'copy' ? quickCopy() : reveal())}
              >
                <ShieldCheck aria-hidden />
                Re-authenticate and retry
              </Button>
            )}
            {state.auditEventUid && (
              <p className="mt-1 font-mono text-[11px] text-ink-faint">
                audit event {state.auditEventUid}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
