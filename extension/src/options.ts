/**
 * Settings: which Helm, pairing this browser with it, the lock (lock.ts), how
 * long a copied password stays on the clipboard, and the theme.
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
import { applyRememberedTheme, applyTheme, type Theme } from './theme';
import {
  MAX_FAILURES, checkSecret, disableLock, enableLock, getLock, lockNow, lockState, setIdleMinutes, unlock,
  type LockMethod, type UnlockResult,
} from './lock';
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

applyRememberedTheme();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const serverInput = $<HTMLInputElement>('server');
const serverForm = $<HTMLFormElement>('server-form');
const serverNote = $('server-note');
const pairSection = $('pair');
const clipboardSelect = $<HTMLSelectElement>('clipboard');
const themeSelect = $<HTMLSelectElement>('theme');
const lockSection = $('lock');

const IDLE_CHOICES: [number, string][] = [
  [0, 'Only when the browser closes'],
  [5, 'After 5 minutes unused'],
  [15, 'After 15 minutes unused'],
  [60, 'After 1 hour unused'],
  [240, 'After 4 hours unused'],
];

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

themeSelect.addEventListener('change', () => {
  const theme = themeSelect.value as Theme;
  applyTheme(theme);
  void setSettings({ theme });
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
  themeSelect.value = settings.theme;
  applyTheme(settings.theme);

  if (!server) {
    pairSection.replaceChildren(el('p', { class: 'muted' }, 'Save your Helm address first.'));
    return;
  }

  if (!pairing) {
    pairSection.replaceChildren(
      el('p', {}, 'This browser is not paired. Pairing lets the extension look credentials up as you, from this browser only.'),
      button('Pair with Helm', () => void startPairing(), 'primary'),
    );
    lockSection.replaceChildren(el('p', { class: 'muted' }, 'Pair this browser first.'));
    return;
  }

  const state = await lockState();
  await renderLock(state);
  if (state === 'locked') {
    pairSection.replaceChildren(el('p', { class: 'muted' }, `Paired with ${pairing.tenantName}. Unlock below to see more.`));
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

const noun = (method: LockMethod) => (method === 'pin' ? 'PIN' : 'password');

function secretInput(method: LockMethod, id: string, label: string): HTMLInputElement {
  return el('input', {
    id, type: 'password', autocomplete: 'off', 'aria-label': label, placeholder: label,
    ...(method === 'pin' ? { inputmode: 'numeric', maxlength: '12' } : {}),
  }) as HTMLInputElement;
}

function idleSelect(value: number): HTMLSelectElement {
  const select = el('select', { id: 'lock-idle' },
    ...IDLE_CHOICES.map(([minutes, label]) => el('option', { value: String(minutes) }, label))) as HTMLSelectElement;
  select.value = String(value);
  return select;
}

function unlockMessage(result: UnlockResult, failures: number, method: LockMethod): string {
  if (result === 'forgotten') return 'Too many wrong tries, so this browser is no longer paired. Pair it again above.';
  const left = MAX_FAILURES - failures;
  return `That ${noun(method)} is not right. ${left} ${left === 1 ? 'try' : 'tries'} left before this browser is unpaired.`;
}

async function renderLock(state: Awaited<ReturnType<typeof lockState>>): Promise<void> {
  const lock = await getLock();
  const note = el('p', { class: 'muted', role: 'status' });

  if (state === 'off' || !lock) {
    const method = el('select', { id: 'lock-method' },
      el('option', { value: 'pin' }, 'A PIN'), el('option', { value: 'password' }, 'A password')) as HTMLSelectElement;
    const fields = el('div', { class: 'lock-fields' });
    let secret = secretInput('pin', 'lock-secret', 'New PIN');
    let confirm = secretInput('pin', 'lock-confirm', 'The same again');
    const idle = idleSelect(0);
    const draw = () => {
      const m = method.value as LockMethod;
      secret = secretInput(m, 'lock-secret', `New ${noun(m)}`);
      confirm = secretInput(m, 'lock-confirm', 'The same again');
      fields.replaceChildren(secret, confirm);
    };
    method.addEventListener('change', draw);
    draw();
    const turnOn = button('Turn on the lock', () => void (async () => {
      const m = method.value as LockMethod;
      const problem = checkSecret(m, secret.value) ?? (secret.value === confirm.value ? null : `The two ${noun(m)}s differ.`);
      if (problem) {
        note.textContent = problem;
        return;
      }
      turnOn.disabled = true;
      note.textContent = 'Turning it on…';
      try {
        await enableLock(m, secret.value, Number(idle.value));
      } catch {
        note.textContent = 'Could not turn the lock on. Is this browser still paired?';
        turnOn.disabled = false;
        return;
      }
      await render();
    })(), 'primary');
    lockSection.replaceChildren(
      el('p', {}, 'Ask for a PIN or a password before the extension shows or fills anything. It always locks when the browser closes or the computer restarts.'),
      el('label', { for: 'lock-method' }, 'Unlock with'), method,
      fields,
      el('label', { for: 'lock-idle' }, 'Also lock'), idle,
      el('div', { class: 'row' }, turnOn),
      note,
    );
    return;
  }

  if (state === 'locked') {
    const secret = secretInput(lock.method, 'unlock-secret', `Your ${noun(lock.method)}`);
    const form = el('form', { class: 'row' }, secret, el('button', { type: 'submit', class: 'primary' }, 'Unlock'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void (async () => {
        const result = await unlock(secret.value);
        if (result === 'unlocked') {
          await render();
          return;
        }
        secret.value = '';
        note.textContent = unlockMessage(result, (await getLock())?.failures ?? MAX_FAILURES, lock.method);
        if (result === 'forgotten') await render();
      })();
    });
    lockSection.replaceChildren(el('p', {}, `Locked. Enter your ${noun(lock.method)} to unlock.`), form, note);
    return;
  }

  const idle = idleSelect(lock.idleMinutes);
  idle.addEventListener('change', () => void setIdleMinutes(Number(idle.value)));
  const current = secretInput(lock.method, 'lock-current', `Your ${noun(lock.method)}`);
  const turnOff = button('Turn off the lock', () => void (async () => {
    turnOff.disabled = true;
    const result = await disableLock(current.value);
    if (result === 'unlocked') {
      await render();
      return;
    }
    turnOff.disabled = false;
    current.value = '';
    note.textContent = unlockMessage(result, (await getLock())?.failures ?? MAX_FAILURES, lock.method);
    if (result === 'forgotten') await render();
  })());
  lockSection.replaceChildren(
    el('p', {}, `Locked with a ${noun(lock.method)}. It locks when the browser closes or the computer restarts.`),
    el('label', { for: 'lock-idle' }, 'Also lock'), idle,
    el('div', { class: 'row' }, button('Lock now', () => void lockNow().then(render))),
    el('label', { for: 'lock-current' }, `To turn the lock off, enter your ${noun(lock.method)}`),
    el('div', { class: 'row' }, current, turnOff),
    note,
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
  if (area === 'session' && changes.unlocked) void render();
});

void render();
