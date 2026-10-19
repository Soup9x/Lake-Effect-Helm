'use client';

/**
 * The browser half of the idle timeout (0890).
 *
 * The server ends a session nobody has used for the policy's idle time. A
 * person reading a long runbook makes no requests, though, so on its own the
 * server would sign them out mid-read. So while somebody is moving, typing or
 * scrolling this pings /api/auth/session at most once a minute, which is a
 * request and moves the session's last_seen_at; and a minute before the
 * timeout with no activity it says so, with a button to stay.
 *
 * When the time is up it signs out and goes to the sign-in page, which says
 * why. If a ping finds the session already gone — ended elsewhere, or by
 * "Sign everybody else out" — it goes there at once.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { Button } from './ui/button';
import { Modal } from './ui/modal';

const PING_EVERY_MS = 60_000;
const WARN_BEFORE_MS = 60_000;
const ACTIVITY = ['pointerdown', 'keydown', 'scroll', 'wheel', 'touchstart'] as const;

async function endSession(): Promise<void> {
  try {
    await fetch('/api/auth/local/logout', { method: 'POST', headers: { 'content-type': 'application/json' } });
  } finally {
    window.location.assign('/sign-in?error=SessionIdle');
  }
}

export function IdleWatcher({ idleMinutes }: { idleMinutes: number }) {
  const idleMs = idleMinutes * 60_000;
  const lastActivity = useRef(Date.now());
  const lastPing = useRef(Date.now());
  const [warning, setWarning] = useState(false);
  const [remaining, setRemaining] = useState(0);

  const ping = useCallback(async () => {
    lastPing.current = Date.now();
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store' });
      const session = (await response.json()) as { user?: unknown } | null;
      if (!session?.user) window.location.assign('/sign-in?error=SessionIdle');
    } catch {
      // Offline or a blip: the next activity tries again.
    }
  }, []);

  useEffect(() => {
    const onActivity = () => {
      lastActivity.current = Date.now();
      if (Date.now() - lastPing.current > PING_EVERY_MS) void ping();
    };
    for (const event of ACTIVITY) window.addEventListener(event, onActivity, { passive: true });
    return () => {
      for (const event of ACTIVITY) window.removeEventListener(event, onActivity);
    };
  }, [ping]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const left = idleMs - (Date.now() - lastActivity.current);
      if (left <= 0) {
        window.clearInterval(timer);
        void endSession();
        return;
      }
      // Only the last minute renders anything; before that a tick is two
      // comparisons and no state change.
      const warn = left <= WARN_BEFORE_MS;
      setWarning(warn);
      if (warn) setRemaining(Math.ceil(left / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [idleMs]);

  const stay = () => {
    lastActivity.current = Date.now();
    setWarning(false);
    void ping();
  };

  return (
    <Modal open={warning} onOpenChange={(open) => { if (!open) stay(); }} title="Still there?" icon={Clock}>
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          For security, Helm signs you out after {idleMinutes} minutes without activity.
          You will be signed out in <span className="tabular-nums font-medium text-ink">{remaining}</span> seconds.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => void endSession()}>Sign out now</Button>
          <Button variant="primary" size="sm" onClick={stay}>Stay signed in</Button>
        </div>
      </div>
    </Modal>
  );
}
