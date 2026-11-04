'use client';

/**
 * The page a single sign-on confirmation window lands on (1270): tell the Helm
 * tab that opened it, then close.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { REAUTH_CHANNEL, REAUTH_MESSAGE, type ReauthMessage } from '@/lib/ui/sso-reauth';

export function ReauthDone({ ticket, ok, error }: { ticket: string; ok: boolean; error: string | null }) {
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const message: ReauthMessage = { type: REAUTH_MESSAGE, ticket, ok, error };
    try {
      window.opener?.postMessage(message, window.location.origin);
    } catch {
      // A cross-origin or vanished opener: the tab still polls.
    }
    try {
      const channel = new BroadcastChannel(REAUTH_CHANNEL);
      channel.postMessage(message);
      channel.close();
    } catch {
      // No BroadcastChannel: polling covers it.
    }
    if (ok) {
      setClosing(true);
      const timer = setTimeout(() => window.close(), 600);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [ticket, ok, error]);

  return (
    <div className="grid min-h-screen place-items-center bg-surface px-6">
      <div className="max-w-sm space-y-3 text-center">
        {ok ? (
          <>
            <CheckCircle2 className="mx-auto size-8 text-ok" aria-hidden />
            <h1 className="text-lg font-semibold text-ink">Confirmed</h1>
            <p className="text-sm text-ink-muted">
              {closing ? 'You can go back to Helm. This window closes by itself.' : 'You can go back to Helm.'}
            </p>
          </>
        ) : (
          <>
            <ShieldAlert className="mx-auto size-8 text-danger" aria-hidden />
            <h1 className="text-lg font-semibold text-ink">Not confirmed</h1>
            <p className="text-sm text-ink-muted">{error ?? 'The sign-in was not confirmed.'}</p>
            <p className="text-xs text-ink-faint">Close this window and try again from Helm.</p>
          </>
        )}
      </div>
    </div>
  );
}
