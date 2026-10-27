/**
 * Settings: which Helm, pairing this browser with it, and how long a copied
 * password stays on the clipboard.
 *
 * Access to the Helm address is asked for here, when it is saved, and for
 * that origin only: the extension holds no standing permission to talk to any
 * site, and the browser shows the person exactly which one it is being given.
 */
import { PAIR_PATH } from '../../src/lib/extension/pairing-protocol';
import type { ExtensionMe } from '../../src/lib/extension/types';
import { call } from './api';
import { browserName, platformName } from './browser';
import { normaliseServer } from './server';
import {
  clearPairing,
  fingerprint,
  getKey,
  getPairing,
  getServer,
  getSettings,
  makePendingKey,
  randomState,
  setPending,
  setServer,
  setSettings,
} from './store';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const serverInput = $<HTMLInputElement>('server');
const serverForm = $<HTMLFormElement>('server-form');
const serverNote = $('server-note');
const pairSection = $('pair');
const clipboardSelect = $<HTMLSelectElement>('clipboard');

serverForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const origin = normaliseServer(serverInput.value);
  if (!origin) {
    serverNote.textContent = 'Enter your Helm address, for example https://helm.example.com.';
    return;
  }
  // Must be called straight from the click: the browser only shows the prompt
  // for a user gesture.
  chrome.permissions.request({ origins: [`${origin}/*`] }, (granted) => {
    void (async () => {
      if (!granted) {
        serverNote.textContent = 'The extension needs access to your Helm address to look credentials up.';
        return;
      }
      const previous = await getServer();
      if (previous && previous !== origin) {
        await clearPairing();
        await chrome.permissions.remove({ origins: [`${previous}/*`] }).catch(() => false);
      }
      await setServer(origin);
      serverInput.value = origin;
      serverNote.textContent = 'Saved.';
      await render();
    })();
  });
});

clipboardSelect.addEventListener('change', () => {
  void setSettings({ clearClipboardSeconds: Number(clipboardSelect.value) });
});

async function startPairing(): Promise<void> {
  const server = await getServer();
  if (!server) return;
  const [key, browser] = await Promise.all([makePendingKey(), browserName()]);
  const state = randomState();
  const label = `${browser} on ${platformName()}`;
  const fragment = new URLSearchParams({
    key: key.publicKey,
    label,
    browser,
    version: chrome.runtime.getManifest().version,
    state,
  });
  const tab = await chrome.tabs.create({ url: `${server}${PAIR_PATH}#${fragment.toString()}` });
  if (tab.id === undefined) return;
  await setPending({ state, tabId: tab.id, origin: server, label });
  await renderPending(key.publicKey);
}

async function renderPending(publicKey: string): Promise<void> {
  pairSection.replaceChildren(
    el('p', {}, 'Helm has opened in a new tab. Sign in if it asks, check that it shows this fingerprint, then enter your Helm password and press Pair:'),
    el('p', { class: 'fingerprint' }, await fingerprint(publicKey)),
    el('p', { class: 'muted' }, 'If Helm asked you to sign in first and then says the link did not come from the extension, press Pair again below.'),
    button('Pair again', () => void startPairing()),
  );
}

async function render(): Promise<void> {
  const [server, pairing, settings] = await Promise.all([getServer(), getPairing(), getSettings()]);
  serverInput.value = server ?? '';
  clipboardSelect.value = String(settings.clearClipboardSeconds);

  if (!server) {
    pairSection.replaceChildren(el('p', { class: 'muted' }, 'Save your Helm address first.'));
    return;
  }

  if (!pairing) {
    pairSection.replaceChildren(
      el('p', {}, 'This browser is not paired. Pairing lets the extension look credentials up as you, from this browser only.'),
      button('Pair with Helm', () => void startPairing(), 'primary'),
    );
    return;
  }

  const key = await getKey('device');
  const me = await call<ExtensionMe>('/api/extension/me');
  if (!me.ok) {
    pairSection.replaceChildren(el('p', { class: 'error' }, me.message), button('Pair with Helm', () => void startPairing(), 'primary'));
    return;
  }
  pairSection.replaceChildren(
    el('dl', {},
      el('dt', {}, 'Signed in as'), el('dd', {}, `${me.value.userName} (${me.value.userEmail})`),
      el('dt', {}, 'Tenant'), el('dd', {}, me.value.tenantName),
      el('dt', {}, 'This browser'), el('dd', {}, me.value.label),
      el('dt', {}, 'Key fingerprint'), el('dd', { class: 'fingerprint' }, key ? await fingerprint(key.publicKey) : '—'),
      el('dt', {}, 'Renews by'), el('dd', {}, new Date(me.value.expiresAt).toLocaleDateString()),
    ),
    button('Sign out', () => void signOut()),
  );
}

async function signOut(): Promise<void> {
  // Unpair in Helm first, so the token is dead even if the local copy survives.
  await call('/api/extension/me', { method: 'DELETE' });
  await clearPairing();
  await render();
}

function el(tag: string, attrs: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function button(label: string, onClick: () => void, variant: 'primary' | 'secondary' = 'secondary'): HTMLButtonElement {
  const node = el('button', { type: 'button', class: variant }, label) as HTMLButtonElement;
  node.addEventListener('click', onClick);
  return node;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.pairing || changes.server)) void render();
});

void render();
