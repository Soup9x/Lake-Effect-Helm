'use client';

/**
 * The live TOTP code for a credential.
 *
 * WHY THIS ASKS THE SERVER EVERY WINDOW rather than fetching a seed once.
 *
 * The seed is the whole account, forever. If this component held it, every
 * future code would be computable in a browser tab — and in anything that read
 * the response out of a proxy log or a devtools panel — with no audit row for
 * any of it. The `secret:reveal` gate would then be a gate on the first code
 * only, which is the same as no gate.
 *
 * So each window costs one POST to /api/assets/{nodeId}/totp/code, which writes
 * one audit row and returns six digits. That is also the honest accounting: a
 * technician who watched the code roll over eight times accessed the credential
 * eight times.
 *
 * The consequence is a refresh that can fail or be refused mid-sequence, which
 * is why the countdown does not simply keep counting: a window that expires
 * without a new code showing has to stop claiming the old one is current.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, ShieldAlert, Timer } from 'lucide-react';
import { Button } from './ui/button';
import { Input, Label } from './ui/field';
import { useStepUp } from './step-up-dialog';
import { STEP_UP_CODE, toAttemptResult, withStepUp } from '@/lib/ui/step-up';
import { cn } from '@/lib/ui/cn';

interface CodeOk {
  code: string;
  secondsRemaining: number;
  periodSeconds: number;
  digits: number;
  auditEventUid?: string;
}

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'shown'; code: string; secondsRemaining: number; periodSeconds: number;
      auditEventUid?: string }
  | { status: 'denied'; message: string; auditEventUid?: string; needsReason: boolean;
      needsStepUp: boolean }
  | { status: 'error'; message: string };

/**
 * How long the panel keeps refreshing on its own.
 *
 * It stops rather than running forever, for the same reason RevealButton
 * auto-hides: a screen-shared session left open should not keep producing valid
 * MFA codes for a client's domain admin after everybody stopped looking. Five
 * minutes is long enough to finish a login and short enough to matter.
 */
const AUTO_REFRESH_LIMIT_MS = 5 * 60 * 1000;

/** Space the digits: 6 reads as two groups, 8 as two groups of four. */
function groupDigits(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}

export function TotpPanel({
  nodeId,
  issuer,
  account,
  canReveal,
}: {
  nodeId: string;
  issuer: string | null;
  account: string | null;
  /** False for somebody without secret:reveal: the panel explains, not offers. */
  canReveal: boolean;
}) {
  const stepUp = useStepUp();
  const [state, setState] = useState<PanelState>({ status: 'idle' });
  const [reason, setReason] = useState('');
  /** Ticks the countdown between fetches, without asking the server. */
  const [elapsed, setElapsed] = useState(0);

  const startedAt = useRef<number | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTick = () => {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
  };

  useEffect(() => clearTick, []);

  const stop = () => {
    clearTick();
    startedAt.current = null;
    setState({ status: 'idle' });
    setElapsed(0);
  };

  /**
   * One attempt, reduced to granted-or-refused.
   *
   * `reason` is read at call time rather than captured, so the step-up retry
   * sends whatever is in the box by then — the same reasoning as RevealButton.
   */
  const attempt = useCallback(async () => {
    const response = await fetch(`/api/assets/${nodeId}/totp/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(reason ? { reason } : {}) }),
    });
    const body = await response.json().catch(() => null);
    return toAttemptResult<CodeOk>(response.ok, response.status, body, (b) => b as CodeOk);
  }, [nodeId, reason]);

  const load = useCallback(async () => {
    setState((prev) => (prev.status === 'shown' ? prev : { status: 'loading' }));
    try {
      const result = await withStepUp(attempt, stepUp.prompt);

      if (!result.ok) {
        clearTick();
        startedAt.current = null;
        setState({
          status: 'denied',
          message: result.message,
          ...(result.auditEventUid ? { auditEventUid: result.auditEventUid } : {}),
          needsReason: result.code === 'reason_required',
          needsStepUp: result.code === STEP_UP_CODE,
        });
        return;
      }

      setElapsed(0);
      setState({
        status: 'shown',
        code: result.value.code,
        secondsRemaining: result.value.secondsRemaining,
        periodSeconds: result.value.periodSeconds,
        ...(result.value.auditEventUid ? { auditEventUid: result.value.auditEventUid } : {}),
      });
    } catch {
      clearTick();
      startedAt.current = null;
      setState({ status: 'error', message: 'The request failed. Check your connection and retry.' });
    }
  }, [attempt, stepUp.prompt]);

  const show = async () => {
    startedAt.current = Date.now();
    await load();
  };

  /*
   * The ticker.
   *
   * One interval for the whole panel, started when a code first appears. When
   * the window runs out it asks for the next code — unless the auto-refresh
   * limit has passed, in which case it stops and the person clicks again.
   */
  useEffect(() => {
    if (state.status !== 'shown') return;
    if (tick.current) return;

    tick.current = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);

    return undefined;
  }, [state.status]);

  const remaining = state.status === 'shown' ? state.secondsRemaining - elapsed : 0;

  useEffect(() => {
    if (state.status !== 'shown') return;
    if (remaining > 0) return;

    const startedMsAgo = startedAt.current ? Date.now() - startedAt.current : Infinity;
    if (startedMsAgo > AUTO_REFRESH_LIMIT_MS) {
      stop();
      return;
    }
    void load();
  }, [remaining, state.status, load]);

  const subject = [issuer, account].filter(Boolean).join(' · ');

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-raised p-3">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="size-4 text-ink-faint" aria-hidden />
        <span className="text-sm font-medium text-ink">One-time code</span>
        {subject && <span className="text-xs text-ink-faint">{subject}</span>}
      </div>

      {!canReveal ? (
        <p className="text-xs text-ink-muted">
          This credential has a second factor. Generating a code needs the
          permission to reveal credentials.
        </p>
      ) : state.status === 'shown' ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="font-mono text-2xl tabular-nums tracking-widest text-ink"
              aria-live="polite"
            >
              {groupDigits(state.code)}
            </span>
            <span
              className={cn(
                'flex items-center gap-1 text-xs tabular-nums',
                remaining <= 5 ? 'text-warning' : 'text-ink-muted',
              )}
            >
              <Timer className="size-3.5" aria-hidden />
              {remaining > 0 ? `${remaining}s` : 'rotating…'}
            </span>
            <Button size="sm" variant="ghost" onClick={stop}>
              Hide
            </Button>
          </div>
          {/*
            The window as a bar rather than only a number: a technician typing a
            code needs to know at a glance whether to use this one or wait for
            the next, and "3" is a number you have to think about.
          */}
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-surface-sunken"
            role="progressbar"
            aria-valuenow={Math.max(remaining, 0)}
            aria-valuemin={0}
            aria-valuemax={state.periodSeconds}
            aria-label="Seconds until this code rotates"
          >
            <div
              className={cn(
                'h-full transition-[width] duration-1000 ease-linear',
                remaining <= 5 ? 'bg-warning' : 'bg-brand',
              )}
              style={{
                width: `${Math.max(0, Math.min(100, (remaining / state.periodSeconds) * 100))}%`,
              }}
            />
          </div>
          {state.auditEventUid && (
            <p className="font-mono text-[10px] text-ink-faint">
              audit {state.auditEventUid}
            </p>
          )}
        </div>
      ) : state.status === 'denied' ? (
        <div className="space-y-2">
          <p className="flex items-start gap-2 text-xs text-warning">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {state.message}
          </p>
          {state.needsReason && (
            <div className="space-y-1">
              <Label htmlFor={`totp-reason-${nodeId}`}>Reason</Label>
              <Input
                id={`totp-reason-${nodeId}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this code is needed"
              />
            </div>
          )}
          {state.auditEventUid && (
            <p className="font-mono text-[10px] text-ink-faint">audit {state.auditEventUid}</p>
          )}
          <Button size="sm" variant="secondary" onClick={() => void show()}>
            Try again
          </Button>
        </div>
      ) : state.status === 'error' ? (
        <div className="space-y-2">
          <p className="text-xs text-critical">{state.message}</p>
          <Button size="sm" variant="secondary" onClick={() => void show()}>
            Retry
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void show()}
          disabled={state.status === 'loading'}
        >
          {state.status === 'loading' ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <KeyRound className="size-4" />
          )}
          Show code
        </Button>
      )}
    </div>
  );
}
