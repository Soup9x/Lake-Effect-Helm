/**
 * The service worker: finishing a pairing, renewing the token, clearing the
 * clipboard after a copy, the timeout (lock or sign out, lock.ts), and the
 * in-page features: the icon in sign-in fields and the save prompt
 * (content.ts, inpage.ts).
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
import { renewIfDue, signOut } from './api';
import { clearMatches, forgetTab, handleInPage } from './inpage';
import { clearLock, lockIfIdle, noteActivity } from './lock';
import { getPending, getServer, getSettings, promotePendingKey, setPairing, setPending } from './store';

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
  forgetTab(tabId);
  void getPending().then(async (pending) => {
    if (pending?.tabId === tabId) await setPending(null);
  });
});

chrome.runtime.onMessage.addListener((request: { kind?: string; message?: PairMessage; seconds?: number }, sender, reply) => {
  if (request.kind === 'helm-paired' && request.message) {
    void finishPairing(request.message, sender);
  } else if (request.kind === 'helm-copied') {
    void scheduleClear();
  } else {
    return handleInPage(request, sender, reply);
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
  await noteActivity();
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
    void lockIfIdle().then((due) => (due === 'signout' ? signOut() : undefined));
  }
});

/* ------------------------------------------------------------------------- *
 * The in-page script: registered while the icon or the save prompt is on and
 * the person has given the extension https pages, on every https page except
 * Helm's own.
 * ------------------------------------------------------------------------- */

const CONTENT_ID = 'helm-content';
const ALL_HTTPS = { origins: ['https://*/*'] };

async function syncContentScript(): Promise<void> {
  const [settings, server, granted] = await Promise.all([
    getSettings(), getServer(), chrome.permissions.contains(ALL_HTTPS),
  ]);
  const want = granted && (settings.inlineMenu || settings.offerToSave);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_ID] });
  if (!want) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_ID] });
    return;
  }
  const script: chrome.scripting.RegisteredContentScript = {
    id: CONTENT_ID,
    js: ['content.js'],
    matches: ['https://*/*'],
    ...(server ? { excludeMatches: [`${server}/*`] } : {}),
    allFrames: true,
    runAt: 'document_idle',
    persistAcrossSessions: true,
  };
  if (existing.length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.settings || changes.server)) {
    void syncContentScript().catch((error: unknown) => console.warn('helm: could not register the page script', error));
  }
  // Locked, unlocked, paired or signed out: what the icons show changes.
  if ((area === 'session' && changes.unlocked) || (area === 'local' && changes.pairing)) clearMatches();
});
chrome.permissions.onAdded.addListener(() => void syncContentScript());
chrome.permissions.onRemoved.addListener(() => void syncContentScript());

/* ------------------------------------------------------------------------- *
 * Renewal: once a day, and whenever the browser starts.
 * ------------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(RENEW_ALARM, { periodInMinutes: 24 * 60 });
  void chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 1 });
  void syncContentScript();
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(RENEW_ALARM, { periodInMinutes: 24 * 60 });
  void chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 1 });
  void (async () => {
    // "Sign out when the browser restarts", or unused past the timeout since.
    const settings = await getSettings();
    const due = await lockIfIdle();
    if (settings.timeoutAction === 'signout' && (settings.timeoutMinutes === 0 || due === 'signout')) {
      await signOut();
      return;
    }
    await renewIfDue();
  })();
});
