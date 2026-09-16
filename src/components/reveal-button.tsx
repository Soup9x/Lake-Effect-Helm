'use client';

import { useEffect, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from './ui/button';
import { Input, Label } from './ui/field';
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
 *   A copy is a SEPARATE audited call, not a local clipboard write of a value
 *   already on screen. "Was it copied" is a different question from "was it
 *   looked at" — one of them means it probably left the building.
 *
 *   A refusal renders its cause and its audit event id. When a technician says
 *   "it says I can't see this", support answers with one audit lookup instead
 *   of a log trawl.
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

export function RevealButton({
  secretId,
  label,
  requiresReason,
  requiresStepUp,
}: {
  secretId: string;
  label: string;
  requiresReason: boolean;
  requiresStepUp: boolean;
}) {
  const [state, setState] = useState<RevealState>({ status: 'idle' });
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setState({ status: 'idle' });
    setCopied(false);
  };

  const reveal = async () => {
    setState({ status: 'loading' });
    try {
      const response = await fetch(`/api/secrets/${secretId}/reveal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'view', ...(reason ? { reason } : {}) }),
      });

      const body = (await response.json()) as
        | { value: string; auditEventUid?: string }
        | { error: { code: string; message: string; details?: { auditEventUid?: string } } };

      if (!response.ok) {
        const error = (body as { error: { code: string; message: string; details?: { auditEventUid?: string } } }).error;
        setState({
          status: 'denied',
          message: error.message,
          ...(error.details?.auditEventUid ? { auditEventUid: error.details.auditEventUid } : {}),
          needsReason: error.code === 'reason_required',
          needsStepUp: error.code === 'step_up_required',
        });
        return;
      }

      const ok = body as { value: string; auditEventUid?: string };
      setState({
        status: 'shown',
        value: ok.value,
        ...(ok.auditEventUid ? { auditEventUid: ok.auditEventUid } : {}),
      });
      timer.current = setTimeout(hide, AUTO_HIDE_MS);
    } catch {
      setState({ status: 'error', message: 'The request failed. Check your connection and retry.' });
    }
  };

  const copy = async () => {
    // A separate, separately-audited call. Deliberately NOT a clipboard write of
    // the value already in state.
    try {
      const response = await fetch(`/api/secrets/${secretId}/copy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(reason ? { reason } : {}) }),
      });
      if (!response.ok) return;
      const body = (await response.json()) as { value: string };
      await navigator.clipboard.writeText(body.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access can be refused by the browser; the reveal still worked.
    }
  };

  const needsReason = requiresReason || state.needsReason;

  return (
    <div className="space-y-2" data-secret>
      {needsReason && state.status !== 'shown' && (
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

      {state.status === 'shown' ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface-sunken px-3 py-2 font-mono text-sm">
              {state.value}
            </code>
            <Button size="icon" variant="secondary" onClick={copy} title="Copy (audited separately)">
              <Copy aria-hidden />
              <span className="sr-only">Copy {label}</span>
            </Button>
            <Button size="icon" variant="ghost" onClick={hide} title="Hide">
              <EyeOff aria-hidden />
              <span className="sr-only">Hide {label}</span>
            </Button>
          </div>
          <p className="text-xs text-ink-faint">
            Hides automatically in {AUTO_HIDE_MS / 1000}s.
            {copied && <span className="ml-2 text-ok">Copied — recorded as a copy event.</span>}
          </p>
        </div>
      ) : (
        <Button
          variant={requiresStepUp ? 'danger' : 'secondary'}
          size="sm"
          onClick={reveal}
          disabled={state.status === 'loading' || (Boolean(needsReason) && reason.trim().length < 10)}
        >
          {state.status === 'loading' ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Eye aria-hidden />
          )}
          Reveal
        </Button>
      )}

      {(state.status === 'denied' || state.status === 'error') && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
            'border-danger/30 bg-danger/5 text-ink',
          )}
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
          <div>
            <p>{state.message}</p>
            {state.needsStepUp && (
              <p className="mt-1 text-ink-muted">
                Re-authenticate to view this credential, then try again.
              </p>
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
