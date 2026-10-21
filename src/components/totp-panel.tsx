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
import { Check, Copy, Eye, EyeOff, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from './ui/button';
import { Input, Label } from './ui/field';
import { useStepUp } from './step-up-dialog';
import { FieldLine, iconActionClass } from './field-row';
import { STEP_UP_CODE, withStepUp } from '@/lib/ui/step-up';
import { apiFetch } from '@/lib/ui/api';
import { copyUnaudited } from '@/lib/ui/clipboard';
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
  canReveal,
  codePath,
}: {
  nodeId: string;
  /** Where codes come from, for a seed that is not a credential's: the personal vault's route. */
  codePath?: string | undefined;
  /** False for somebody without secret:reveal: the panel explains, not offers. */
  canReveal: boolean;
}) {
  const stepUp = useStepUp();
  const [state, setState] = useState<PanelState>({ status: 'idle' });
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState(false);
  /** Ticks the countdown between fetches, without asking the server. */
  const [elapsed, setElapsed] = useState(0);

  const startedAt = useRef<number | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * One code request at a time. The ticker keeps counting while a request is
   * out, so `remaining` goes 0, -1, -2… and the refresh effect re-ran on every
   * tick: a response slower than a second meant a second audited request, then
   * a third — and a step-up refusal re-opened the prompt every second, wiping
   * what was being typed into it.
   */
  const inFlight = useRef(false);

  // Both touch only refs and setters, so they are stable across renders and
  // safe to list as dependencies without re-running anything.
  const clearTick = useCallback(() => {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
  }, []);

  useEffect(() => clearTick, [clearTick]);

  const stop = useCallback(() => {
    clearTick();
    startedAt.current = null;
    setState({ status: 'idle' });
    setElapsed(0);
  }, [clearTick]);

  /**
   * One attempt, reduced to granted-or-refused.
   *
   * `reason` is read at call time rather than captured, so the step-up retry
   * sends whatever is in the box by then — the same reasoning as RevealButton.
   */
  const attempt = useCallback(
    () => apiFetch<CodeOk>(codePath ?? `/api/assets/${nodeId}/totp/code`, { json: { ...(reason ? { reason } : {}) } }),
    [nodeId, reason, codePath],
  );

  const load = useCallback(async (): Promise<string | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
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
        return null;
      }

      setElapsed(0);
      setState({
        status: 'shown',
        code: result.value.code,
        secondsRemaining: result.value.secondsRemaining,
        periodSeconds: result.value.periodSeconds,
        ...(result.value.auditEventUid ? { auditEventUid: result.value.auditEventUid } : {}),
      });
      return result.value.code;
    } catch {
      clearTick();
      startedAt.current = null;
      setState({ status: 'error', message: 'The request failed. Check your connection and retry.' });
      return null;
    } finally {
      inFlight.current = false;
    }
  }, [attempt, stepUp.prompt, clearTick]);

  const show = async () => {
    startedAt.current = Date.now();
    return load();
  };

  /**
   * Copy the code on screen, or fetch one and copy it.
   *
   * Unaudited on purpose: fetching the code is the audited access — one row per
   * window, as above — and the six digits are worthless thirty seconds later.
   * A second row for moving them to the clipboard would record nothing new.
   */
  const copyCode = async () => {
    const code = state.status === 'shown' ? state.code : await show();
    if (!code) return;
    const outcome = await copyUnaudited(code);
    if (outcome !== 'copied') return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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
  }, [remaining, state.status, load, stop]);

  if (!canReveal) {
    return (
      <p className="text-sm text-ink-muted">
        Generating a code needs the permission to reveal credentials.
      </p>
    );
  }

  const shown = state.status === 'shown';
  const loading = state.status === 'loading';

  return (
    <div className="space-y-1.5">
      {stepUp.dialog}
      <FieldLine
        mono
        actions={
          <>
            {shown && <Countdown remaining={remaining} period={state.periodSeconds} />}
            <button
              type="button"
              className={iconActionClass}
              onClick={shown ? stop : () => void show()}
              disabled={loading}
              title={shown ? 'Hide code' : 'Show code'}
              aria-label={shown ? 'Hide one-time code' : 'Show one-time code'}
            >
              {loading ? <Loader2 className="animate-spin" aria-hidden /> : shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            </button>
            <button
              type="button"
              className={iconActionClass}
              onClick={() => void copyCode()}
              disabled={loading}
              title="Copy code"
              aria-label="Copy one-time code"
            >
              {copied ? <Check className="text-ok" aria-hidden /> : <Copy aria-hidden />}
            </button>
          </>
        }
      >
        {shown ? (
          <span className="text-base tabular-nums tracking-widest" aria-live="polite">
            {groupDigits(state.code)}
          </span>
        ) : (
          <>
            <span className="tracking-[0.2em] text-ink-muted" aria-hidden>••• •••</span>
            <span className="sr-only">Hidden</span>
          </>
        )}
      </FieldLine>

      {state.status === 'denied' && (
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
      )}
      {state.status === 'error' && <p className="text-xs text-critical">{state.message}</p>}
    </div>
  );
}

/**
 * The window as a ring with the seconds inside: a technician typing a code
 * needs to know at a glance whether to use this one or wait for the next.
 */
function Countdown({ remaining, period }: { remaining: number; period: number }) {
  const radius = 12;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.max(0, Math.min(1, remaining / period));
  const low = remaining <= 5;
  return (
    <span
      className="relative inline-flex size-8 shrink-0 items-center justify-center"
      role="progressbar"
      aria-valuenow={Math.max(remaining, 0)}
      aria-valuemin={0}
      aria-valuemax={period}
      aria-label="Seconds until this code rotates"
    >
      <svg viewBox="0 0 32 32" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="16" cy="16" r={radius} fill="none" strokeWidth="2.5" className="stroke-border" />
        <circle
          cx="16"
          cy="16"
          r={radius}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          className={cn('transition-[stroke-dashoffset] duration-1000 ease-linear', low ? 'stroke-warning' : 'stroke-brand')}
        />
      </svg>
      <span className={cn('text-[11px] tabular-nums', low ? 'text-warning' : 'text-ink-muted')}>
        {remaining > 0 ? remaining : '…'}
      </span>
    </span>
  );
}
