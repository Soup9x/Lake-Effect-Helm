/**
 * Confirm it is you with the identity provider, from the browser (1270).
 *
 * The provider's sign-in opens in a small window straight from the click (a
 * popup blocker only lets through windows opened inside the click itself), and
 * this waits for it three ways at once, because any one of them can be missing:
 *
 *   postMessage       the done page messages the tab that opened it
 *   BroadcastChannel  the same, for a phone that opened it as a tab without
 *                     an opener
 *   polling           GET /api/auth/reauth/sso/status, which reads the
 *                     database and does not care how the window was opened
 *
 * The ticket is minted here, before the window opens, so that the click can
 * open it synchronously. It is only an identifier: the server ties it to this
 * session's user and tenant when the provider sign-in lands, and a one-shot
 * action spends it once.
 */
import { apiFetch } from './api';

export const REAUTH_MESSAGE = 'helm-sso-reauth';
export const REAUTH_CHANNEL = 'helm-sso-reauth';

export interface ReauthOptions {
  password: boolean;
  sso: { name: string } | null;
  totp: boolean;
}

export type SsoOutcome =
  | { kind: 'ok'; ticket: string }
  | { kind: 'error'; message: string }
  | { kind: 'blocked' }
  | { kind: 'cancelled' };

export interface ReauthMessage {
  type: typeof REAUTH_MESSAGE;
  ticket: string;
  ok: boolean;
  error: string | null;
}

const POLL_MS = 2000;
const GIVE_UP_MS = 10 * 60 * 1000;

function newTicket(): string {
  // getRandomValues rather than randomUUID: the latter is missing over plain
  // http on a LAN address, which is how some people reach a test install.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Call from the click handler itself, not after an await. */
export function confirmWithSso(): Promise<SsoOutcome> {
  const ticket = newTicket();
  const url = `/api/auth/reauth/sso/start?t=${encodeURIComponent(ticket)}`;
  const win = window.open(url, 'helm-sso-reauth', 'popup=yes,width=520,height=720');
  if (!win) return Promise.resolve({ kind: 'blocked' });

  return new Promise<SsoOutcome>((resolve) => {
    let settled = false;
    let closedSince: number | null = null;
    const started = Date.now();
    let channel: BroadcastChannel | null = null;

    const settle = (outcome: SsoOutcome) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      channel?.close();
      clearInterval(timer);
      resolve(outcome);
    };

    const fromMessage = (data: unknown) => {
      const m = data as Partial<ReauthMessage> | null;
      if (!m || m.type !== REAUTH_MESSAGE || m.ticket !== ticket) return;
      settle(m.ok ? { kind: 'ok', ticket } : { kind: 'error', message: m.error ?? 'The sign-in was not confirmed.' });
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      fromMessage(event.data);
    };
    window.addEventListener('message', onMessage);

    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(REAUTH_CHANNEL);
      channel.onmessage = (event) => fromMessage(event.data);
    }

    const timer = setInterval(async () => {
      if (settled) return;
      if (Date.now() - started > GIVE_UP_MS) return settle({ kind: 'cancelled' });

      const status = await apiFetch<{ done: boolean }>(`/api/auth/reauth/sso/status?t=${encodeURIComponent(ticket)}`);
      if (status.ok && status.value.done) return settle({ kind: 'ok', ticket });

      // Closed without landing: give a message in flight one more poll, then
      // call it a dismissal.
      if (win.closed) {
        if (closedSince === null) closedSince = Date.now();
        else if (Date.now() - closedSince >= POLL_MS) settle({ kind: 'cancelled' });
      }
    }, POLL_MS);
  });
}

/** What to show for an outcome that is not success; null for a quiet dismissal. */
export function describeSsoOutcome(outcome: SsoOutcome, name: string): string | null {
  switch (outcome.kind) {
    case 'blocked':
      return `Your browser blocked the ${name} sign-in window. Allow pop-ups for Helm and try again.`;
    case 'error':
      return outcome.message;
    default:
      return null;
  }
}

export async function loadReauthOptions(): Promise<ReauthOptions | null> {
  const result = await apiFetch<ReauthOptions>('/api/auth/reauth');
  return result.ok ? result.value : null;
}
