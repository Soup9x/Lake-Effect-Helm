/**
 * The service worker: finishing a pairing, renewing the token, clearing the
 * clipboard after a copy, and locking after the idle timeout (lock.ts).
 *
 * PAIRING. Settings opens Helm's pairing page in a tab and records which tab
 * and which random state (store.ts, PendingPairing). Each time that tab
 * finishes loading a page on the Helm origin, a small listener is injected
 * into it; when the person presses Pair, the page posts the result to its own
 * window, the listener checks it is from that window with the expected state
 * and forwards it here, and this checks again that it came from that tab on
 * that origin before storing the pairing and closing the tab.
 */
import { PAIR_MESSAGE_TYPE, type PairMessage } from '../../src/lib/extension/pairing-protocol';
import { renewIfDue } from './api';
import { clearLock, lockIfIdle } from './lock';
import { getPending, getSettings, promotePendingKey, setPairing, setPending } from './store';

const CLEAR_ALARM = 'helm-clear-clipboard';
const RENEW_ALARM = 'helm-renew';
const IDLE_ALARM = 'helm-idle-lock';

/** Injected into the pairing tab. Self-contained: it is serialised, not imported. */
function pairingListener(expectedState: string, messageType: string): void {
  const flag = '__helmPairingListener';
  const w = window as unknown as Record<string, unknown>;
  if (w[flag]) return;
  w[flag] = true;
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data as { type?: unknown; state?: unknown } | null;
    if (!data || data.type !== messageType || data.state !== expectedState) return;
    void chrome.runtime.sendMessage({ kind: 'helm-paired', message: data });
  });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  void (async () => {
    const pending = await getPending();
    if (!pending || pending.tabId !== tabId || !tab.url) return;
    if (new URL(tab.url).origin !== pending.origin) return;
    await chrome.scripting.executeScript({
      target: { tabId },
      func: pairingListener,
      args: [pending.state, PAIR_MESSAGE_TYPE],
    });
  })().catch((error: unknown) => console.warn('helm: could not watch the pairing tab', error));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void getPending().then(async (pending) => {
    if (pending?.tabId === tabId) await setPending(null);
  });
});

chrome.runtime.onMessage.addListener((request: { kind?: string; message?: PairMessage; seconds?: number }, sender) => {
  if (request.kind === 'helm-paired' && request.message) {
    void finishPairing(request.message, sender);
  } else if (request.kind === 'helm-copied') {
    void scheduleClear();
  }
  return false;
});

async function finishPairing(message: PairMessage, sender: chrome.runtime.MessageSender): Promise<void> {
  const pending = await getPending();
  if (!pending || !sender.tab || sender.tab.id !== pending.tabId) return;
  if (!sender.url || new URL(sender.url).origin !== pending.origin) return;
  if (message.state !== pending.state || typeof message.token !== 'string') return;

  if (!(await promotePendingKey())) return;
  // A lock sealed the old pairing's token; the new one starts unlocked, and
  // settings says the lock is off.
  await clearLock();
  await setPairing({
    installId: message.installId,
    token: message.token,
    expiresAt: message.expiresAt,
    tenantName: message.tenantName,
    label: pending.label,
  });
  await setPending(null);
  await chrome.tabs.remove(pending.tabId).catch(() => {});
}

/* ------------------------------------------------------------------------- *
 * Clipboard
 *
 * The popup writes the clipboard, then closes, taking its timers with it; so
 * the clearing is scheduled here with an alarm and done from an offscreen
 * document, which is the only page an extension can keep without a window.
 * ------------------------------------------------------------------------- */

async function scheduleClear(): Promise<void> {
  const { clearClipboardSeconds } = await getSettings();
  if (clearClipboardSeconds <= 0) return;
  // Alarms fire no sooner than 30 seconds; the setting's choices start there.
  await chrome.alarms.create(CLEAR_ALARM, { delayInMinutes: Math.max(30, clearClipboardSeconds) / 60 });
}

async function clearClipboard(): Promise<void> {
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url,
      reasons: ['CLIPBOARD'],
      justification: 'Clear a copied password from the clipboard after a short time.',
    });
  }
  await chrome.runtime.sendMessage({ kind: 'helm-clear-clipboard' });
  await chrome.offscreen.closeDocument().catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLEAR_ALARM) {
    void clearClipboard().catch((error: unknown) => console.warn('helm: could not clear the clipboard', error));
  } else if (alarm.name === RENEW_ALARM) {
    void renewIfDue();
  } else if (alarm.name === IDLE_ALARM) {
    void lockIfIdle();
  }
});

/* ------------------------------------------------------------------------- *
 * Renewal: once a day, and whenever the browser starts.
 * ------------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(RENEW_ALARM, { periodInMinutes: 24 * 60 });
  void chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(RENEW_ALARM, { periodInMinutes: 24 * 60 });
  void chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 1 });
  void renewIfDue();
});
