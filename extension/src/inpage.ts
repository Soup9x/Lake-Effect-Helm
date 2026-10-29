/**
 * The background's half of the in-page features (content.ts): the icon's
 * status, the menu of logins and filling from it, and the save and update
 * prompt after a sign-in.
 *
 * WHO MAY ASK WHAT. A message from the content script comes from the page's
 * process and is trusted as far as the page is: it may say that a page has a
 * sign-in form or that the person signed in, and get back a count. Filling,
 * saving and updating are asked for only by the extension's own frames
 * (menu.html, notify.html), told apart by their URL, never by anything a
 * message says about itself. Every one of those carries a token handed out
 * here for one frame of one tab, and is carried out for that frame and tab.
 *
 * THE SITE IS THE BROWSER'S. Which site a frame is on comes from
 * MessageSender.url, which the browser fills in, and is checked again in the
 * frame just before a fill (formInPage reports its own host). A page cannot
 * have a login for another site filled into it.
 *
 * WHAT IS KEPT. The list for an open menu, and a login just typed, in
 * chrome.storage.session: memory, never disk, and never readable by a
 * content script (its default access level). A typed login is dropped once
 * the person answers the prompt, after five minutes, or when the tab closes.
 */
import type {
  ExtensionDestinations, ExtensionEntry, ExtensionLoginCheck, ExtensionLookup, ExtensionSaved,
} from '../../src/lib/extension/types';
import { call } from './api';
import { formInPage, type FillValues, type FormProbe } from './fill';
import { lockState } from './lock';
import { getPairing, getServer, getSettings, setSettings } from './store';

const CAPTURE_TTL = 5 * 60_000;
const MENU_TTL = 10 * 60_000;

/** A page frame, as the browser reported it. */
interface Frame {
  tabId: number;
  frameId: number;
  documentId: string;
  url: string;
  host: string;
}

interface MenuState extends Frame {
  entries: ExtensionEntry[];
  at: number;
}

interface Captured {
  token: string;
  tabId: number;
  url: string;
  host: string;
  username: string;
  password: string;
  at: number;
  check: ExtensionLoginCheck | null;
  shown: boolean;
}

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** The page frame a content script message came from: https only, with a document. */
function pageFrame(sender: chrome.runtime.MessageSender): Frame | null {
  if (sender.id !== chrome.runtime.id || !sender.tab?.id || !sender.url || sender.documentId === undefined) return null;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return { tabId: sender.tab.id, frameId: sender.frameId ?? 0, documentId: sender.documentId, url: sender.url, host: url.host };
}

/** True for one of the extension's own frames: menu.html or notify.html, inside a tab. */
function ownFrame(sender: chrome.runtime.MessageSender, page: 'menu.html' | 'notify.html'): number | null {
  if (sender.id !== chrome.runtime.id || !sender.tab?.id || !sender.url) return null;
  try {
    const url = new URL(sender.url);
    if (url.protocol !== 'chrome-extension:' || url.pathname !== `/${page}`) return null;
  } catch {
    return null;
  }
  return sender.tab.id;
}

async function helmHost(): Promise<string | null> {
  const server = await getServer();
  return server ? new URL(server).host : null;
}

/* ------------------------------------------------------------------------- *
 * Session storage
 * ------------------------------------------------------------------------- */

async function getMenu(token: string): Promise<MenuState | null> {
  const key = `menu:${token}`;
  const { [key]: menu } = (await chrome.storage.session.get(key)) as Record<string, MenuState | undefined>;
  if (!menu || Date.now() - menu.at > MENU_TTL) return null;
  return menu;
}

async function setMenu(token: string, menu: MenuState | null): Promise<void> {
  if (menu) await chrome.storage.session.set({ [`menu:${token}`]: menu });
  else await chrome.storage.session.remove(`menu:${token}`);
}

/** Menus never closed (a tab navigated away): dropped once stale. */
async function pruneMenus(): Promise<void> {
  const all = (await chrome.storage.session.get(null)) as Record<string, unknown>;
  const stale = Object.entries(all)
    .filter(([key, value]) => key.startsWith('menu:') && Date.now() - ((value as MenuState).at ?? 0) > MENU_TTL)
    .map(([key]) => key);
  if (stale.length) await chrome.storage.session.remove(stale);
}

async function getCaptured(tabId: number): Promise<Captured | null> {
  const key = `captured:${tabId}`;
  const { [key]: captured } = (await chrome.storage.session.get(key)) as Record<string, Captured | undefined>;
  if (!captured) return null;
  if (Date.now() - captured.at > CAPTURE_TTL) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return captured;
}

async function setCaptured(tabId: number, captured: Captured | null): Promise<void> {
  if (captured) await chrome.storage.session.set({ [`captured:${tabId}`]: captured });
  else await chrome.storage.session.remove(`captured:${tabId}`);
}

/** A username typed on a step before the password's, per tab. */
async function setSeenUsername(tabId: number, host: string, username: string): Promise<void> {
  await chrome.storage.session.set({ [`username:${tabId}`]: { host, username, at: Date.now() } });
}

async function seenUsername(tabId: number, host: string): Promise<string | null> {
  const key = `username:${tabId}`;
  const { [key]: seen } = (await chrome.storage.session.get(key)) as Record<string, { host: string; username: string; at: number } | undefined>;
  if (!seen || Date.now() - seen.at > CAPTURE_TTL) return null;
  // The username step and the password step are often different hosts under
  // one sign-in service (login.live.com, login.microsoftonline.com); the
  // same tab within a few minutes is what ties them.
  return seen.host === host || Date.now() - seen.at < 120_000 ? seen.username : null;
}

/* ------------------------------------------------------------------------- *
 * The icon and the menu
 * ------------------------------------------------------------------------- */

/** Matches per frame host, briefly, so a page with many fields asks Helm once. */
const matchCache = new Map<string, { at: number; lookup: ExtensionLookup }>();

async function lookup(url: string, host: string): Promise<ExtensionLookup | null> {
  const cached = matchCache.get(host);
  if (cached && Date.now() - cached.at < 60_000) return cached.lookup;
  // Passive: a page loading is not the person using Helm, so it does not
  // hold off the timeout.
  const result = await call<ExtensionLookup>('/api/extension/match', { json: { url }, passive: true });
  if (!result.ok) return null;
  matchCache.set(host, { at: Date.now(), lookup: result.value });
  return result.value;
}

async function inlineStatus(sender: chrome.runtime.MessageSender): Promise<{ show: boolean; count: number; locked: boolean }> {
  const none = { show: false, count: 0, locked: false };
  const frame = pageFrame(sender);
  const settings = await getSettings();
  if (!frame || !settings.inlineMenu || !(await getPairing()) || frame.host === (await helmHost())) return none;
  if ((await lockState()) === 'locked') return { show: true, count: 0, locked: true };
  const found = await lookup(frame.url, frame.host);
  const count = found?.entries.length ?? 0;
  return { show: count > 0, count, locked: false };
}

async function openMenu(sender: chrome.runtime.MessageSender): Promise<{ token: string } | null> {
  const frame = pageFrame(sender);
  if (!frame || !(await getSettings()).inlineMenu) return null;
  await pruneMenus();
  const token = randomToken();
  const locked = (await lockState()) === 'locked';
  const found = locked ? null : await lookup(frame.url, frame.host);
  await setMenu(token, { ...frame, entries: found?.entries ?? [], at: Date.now() });
  return { token };
}

export interface MenuView {
  state: 'list' | 'locked' | 'empty';
  host: string;
  entries: { key: string; name: string; sub: string; personal: boolean; fillable: boolean; note: string | null }[];
}

const entryKey = (entry: ExtensionEntry) => `${entry.kind}:${entry.id}`;

async function menuView(token: string): Promise<MenuView | null> {
  const menu = await getMenu(token);
  if (!menu) return null;
  if ((await lockState()) === 'locked') return { state: 'locked', host: menu.host, entries: [] };
  if (menu.entries.length === 0) {
    // Opened while locked, and unlocked since: look again.
    const found = await lookup(menu.url, menu.host);
    menu.entries = found?.entries ?? [];
    await setMenu(token, menu);
  }
  return {
    state: menu.entries.length ? 'list' : 'empty',
    host: menu.host,
    entries: menu.entries.map((e) => {
      const fillable = (e.username !== null || e.passwordCopyable) && !(e.kind === 'client' && e.requiresReason);
      return {
        key: entryKey(e),
        name: e.name,
        sub: [e.username, e.organizationName ?? 'My passwords'].filter(Boolean).join(' · '),
        personal: e.kind === 'personal',
        fillable,
        note: e.hasPassword && !e.passwordCopyable
          ? 'Password stays in Helm'
          : e.kind === 'client' && e.requiresReason ? 'Needs a reason: use the Helm popup' : null,
      };
    }),
  };
}

type Outcome = { ok: true } | { ok: false; message: string };

/** Fill one login from the menu into the frame it was opened over. */
async function fillFromMenu(token: string, key: string): Promise<Outcome> {
  const menu = await getMenu(token);
  if (!menu) return { ok: false, message: 'This list has expired. Click the Helm icon again.' };
  const entry = menu.entries.find((e) => entryKey(e) === key);
  if (!entry) return { ok: false, message: 'That login is not in this list.' };

  const target = { tabId: menu.tabId, documentIds: [menu.documentId] };
  let probe: FormProbe | undefined;
  try {
    [{ result: probe } = { result: undefined }] = await chrome.scripting.executeScript({ target, func: formInPage, args: [null] });
  } catch {
    return { ok: false, message: 'The page changed. Click the Helm icon again.' };
  }
  // The frame is still the document the list was for, on the same host.
  if (!probe || probe.host !== menu.host) return { ok: false, message: 'The page changed. Click the Helm icon again.' };

  const values: FillValues = {};
  if (probe.username && entry.username) values.username = entry.username;
  if (probe.password) {
    if (!entry.passwordCopyable) return { ok: false, message: `${entry.name}'s password stays in Helm.` };
    const revealed = entry.kind === 'client'
      ? await call<{ value: string }>(`/api/secrets/${entry.secretId}/reveal`, { json: { purpose: 'autofill' } })
      : await call<{ value: string }>(`/api/personal/vault/${entry.id}/reveal`, { json: { purpose: 'autofill' } });
    if (!revealed.ok) return { ok: false, message: revealed.message };
    values.password = revealed.value.value;
  }
  if (probe.code && entry.hasTotp) {
    const code = entry.kind === 'client'
      ? await call<{ code: string }>(`/api/assets/${entry.id}/totp/code`, { json: {} })
      : await call<{ code: string }>(`/api/personal/vault/${entry.id}/code`, { json: {} });
    if (!code.ok) return { ok: false, message: code.message };
    values.code = code.value.code;
  }
  if (Object.keys(values).length === 0) return { ok: false, message: `${entry.name} has nothing for this form.` };

  try {
    const [done] = await chrome.scripting.executeScript({ target, func: formInPage, args: [values] });
    if (!done?.result?.filled) return { ok: false, message: 'The page changed before Helm could fill it.' };
  } catch {
    return { ok: false, message: 'The page changed before Helm could fill it.' };
  }
  await setMenu(token, null);
  await chrome.tabs.sendMessage(menu.tabId, { kind: 'helm-menu-close' }, { frameId: menu.frameId }).catch(() => {});
  return { ok: true };
}

/* ------------------------------------------------------------------------- *
 * Save and update
 * ------------------------------------------------------------------------- */

async function onCaptured(sender: chrome.runtime.MessageSender, typedUsername: string, password: string): Promise<void> {
  const frame = pageFrame(sender);
  const settings = await getSettings();
  if (!frame || !settings.offerToSave || !password || password.length > 4096) return;
  if (frame.host === (await helmHost()) || settings.neverSave.includes(frame.host)) return;
  if (!(await getPairing()) || (await lockState()) === 'locked') return;

  const username = (typedUsername || (await seenUsername(frame.tabId, frame.host)) || '').slice(0, 320);
  const check = await call<ExtensionLoginCheck>('/api/extension/check', {
    json: { url: frame.url, username, password },
  });
  if (!check.ok || (check.value.state !== 'new' && check.value.state !== 'changed')) return;

  const captured: Captured = {
    token: randomToken(), tabId: frame.tabId, url: frame.url, host: frame.host,
    username, password, at: Date.now(), check: check.value, shown: false,
  };
  await setCaptured(frame.tabId, captured);
  // A sign-in usually loads another page, whose content script asks for this
  // prompt as it starts. One that does not (a single-page app) is told here,
  // after a moment for the page to settle.
  setTimeout(() => void offerBar(frame.tabId), 1500);
}

async function offerBar(tabId: number): Promise<string | null> {
  const captured = await getCaptured(tabId);
  if (!captured) return null;
  if (!captured.shown) {
    captured.shown = true;
    await setCaptured(tabId, captured);
  }
  await chrome.tabs.sendMessage(tabId, { kind: 'helm-show-bar', token: captured.token }, { frameId: 0 }).catch(() => {});
  return captured.token;
}

export interface BarView {
  mode: 'new' | 'changed';
  host: string;
  username: string;
  suggestedName: string;
  entry: { name: string; where: string } | null;
  destinations: ExtensionDestinations;
}

async function barFor(tabId: number, token: string): Promise<Captured | null> {
  const captured = await getCaptured(tabId);
  return captured && captured.token === token ? captured : null;
}

async function barView(tabId: number, token: string): Promise<BarView | null> {
  const captured = await barFor(tabId, token);
  if (!captured?.check) return null;
  const mode = captured.check.state === 'changed' ? 'changed' : 'new';
  const destinations = mode === 'new'
    ? await call<ExtensionDestinations>('/api/extension/destinations')
    : null;
  const entry = captured.check.entry;
  return {
    mode,
    host: captured.host,
    username: captured.username,
    suggestedName: captured.host.replace(/^www\./, ''),
    entry: entry ? { name: entry.name, where: entry.organizationName ?? 'My passwords' } : null,
    destinations: destinations?.ok ? destinations.value : { canSave: captured.check.canSave, organizations: [] },
  };
}

export interface SaveRequest {
  destination: { kind: 'personal' } | { kind: 'client'; organizationId: string; siteId: string | null };
  name: string;
  tags: string[];
}

async function closeBar(tabId: number): Promise<void> {
  await setCaptured(tabId, null);
  await chrome.tabs.sendMessage(tabId, { kind: 'helm-bar-close' }, { frameId: 0 }).catch(() => {});
}

async function saveFromBar(tabId: number, token: string, request: SaveRequest): Promise<Outcome & { saved?: ExtensionSaved }> {
  const captured = await barFor(tabId, token);
  if (!captured) return { ok: false, message: 'This prompt has expired.' };
  const origin = new URL(captured.url).origin;
  const result = await call<ExtensionSaved>('/api/extension/logins', {
    json: {
      destination: request.destination, name: request.name, username: captured.username,
      password: captured.password, url: origin, tags: request.tags,
    },
  });
  if (!result.ok) return { ok: false, message: result.message };
  await setCaptured(tabId, null);
  matchCache.delete(captured.host);
  return { ok: true, saved: result.value };
}

async function updateFromBar(tabId: number, token: string): Promise<Outcome & { saved?: ExtensionSaved }> {
  const captured = await barFor(tabId, token);
  const entry = captured?.check?.entry;
  if (!captured || !entry) return { ok: false, message: 'This prompt has expired.' };
  const result = await call<ExtensionSaved>('/api/extension/logins/update', {
    json: { url: captured.url, kind: entry.kind, id: entry.id, password: captured.password },
  });
  if (!result.ok) return { ok: false, message: result.message };
  await setCaptured(tabId, null);
  return { ok: true, saved: result.value };
}

/* ------------------------------------------------------------------------- *
 * Wiring
 * ------------------------------------------------------------------------- */

type Message = { kind?: string; token?: string; key?: string; username?: string; password?: string; height?: number; never?: boolean; request?: SaveRequest };

/** Handles the in-page messages; false for any other, so background.ts can. */
export function handleInPage(message: Message, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void): boolean {
  const answer = (work: Promise<unknown>) => {
    work.then(reply, () => reply(null));
    return true;
  };
  switch (message.kind) {
    // From content scripts.
    case 'helm-inline-status':
      return answer(inlineStatus(sender));
    case 'helm-menu-open':
      return answer(openMenu(sender));
    case 'helm-menu-closed': {
      // Only the tab it was opened in can close it.
      const token = message.token;
      if (token) {
        void getMenu(token).then((menu) => (menu && menu.tabId === sender.tab?.id ? setMenu(token, null) : undefined));
      }
      return false;
    }
    case 'helm-captured':
      if (typeof message.password === 'string') void onCaptured(sender, String(message.username ?? ''), message.password);
      return false;
    case 'helm-username-seen': {
      const frame = pageFrame(sender);
      if (frame && typeof message.username === 'string' && message.username.length <= 320) {
        void setSeenUsername(frame.tabId, frame.host, message.username);
      }
      return false;
    }
    case 'helm-bar-pending': {
      const frame = pageFrame(sender);
      if (frame?.frameId !== 0) return false;
      return answer(getCaptured(frame.tabId).then((c) => (c ? offerBar(frame.tabId) : null)).then((token) => ({ token })));
    }
  }

  // From the extension's own frames.
  const menuTab = ownFrame(sender, 'menu.html');
  if (menuTab !== null && message.token) {
    if (message.kind === 'helm-menu-view') return answer(menuView(message.token));
    if (message.kind === 'helm-menu-fill' && message.key) return answer(fillFromMenu(message.token, message.key));
    if (message.kind === 'helm-menu-dismiss') {
      void getMenu(message.token).then(async (menu) => {
        if (!menu) return;
        await setMenu(message.token!, null);
        await chrome.tabs.sendMessage(menu.tabId, { kind: 'helm-menu-close' }, { frameId: menu.frameId }).catch(() => {});
      });
      return false;
    }
    if (message.kind === 'helm-menu-size' && typeof message.height === 'number') {
      void getMenu(message.token).then((menu) => {
        if (menu) void chrome.tabs.sendMessage(menu.tabId, { kind: 'helm-menu-size', height: message.height }, { frameId: menu.frameId }).catch(() => {});
      });
      return false;
    }
    if (message.kind === 'helm-open-popup') {
      return answer(chrome.action.openPopup().then(() => true, () => false));
    }
  }

  const barTab = ownFrame(sender, 'notify.html');
  if (barTab !== null && message.token) {
    const token = message.token;
    switch (message.kind) {
      case 'helm-bar-view':
        return answer(barView(barTab, token));
      case 'helm-bar-save':
        return message.request ? answer(saveFromBar(barTab, token, message.request)) : false;
      case 'helm-bar-update':
        return answer(updateFromBar(barTab, token));
      case 'helm-bar-size':
        void chrome.tabs.sendMessage(barTab, { kind: 'helm-bar-size', height: message.height }, { frameId: 0 }).catch(() => {});
        return false;
      case 'helm-bar-dismiss':
        return answer((async () => {
          const captured = await barFor(barTab, token);
          if (captured && message.never) {
            const { neverSave } = await getSettings();
            if (!neverSave.includes(captured.host)) await setSettings({ neverSave: [...neverSave, captured.host].sort() });
          }
          await closeBar(barTab);
          return true;
        })());
    }
  }
  return false;
}

/** Forget what a closed tab typed. */
export function forgetTab(tabId: number): void {
  void chrome.storage.session.remove([`captured:${tabId}`, `username:${tabId}`]);
}

/** After a lock, an unlock or a save, the icons and lists change. */
export function clearMatches(): void {
  matchCache.clear();
}
