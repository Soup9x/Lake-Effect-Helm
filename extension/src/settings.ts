/**
 * Settings, drawn inside the popup (as Bitwarden's are) and on the options
 * page, from one place: the account and pairing, which Helm, account
 * security (unlock with a PIN or password, the timeout and what it does),
 * autofill and saving, the clipboard, and the theme.
 *
 * PERMISSIONS ARE ASKED FOR HERE, AND ONLY HERE. The Helm address, for that
 * origin only, when it is saved. Every https page, when the icon in sign-in
 * fields or the save prompt is turned on, since both need a script in the
 * page; the browser shows the person what it is granting. Both must be asked
 * for straight from a click, which is why they are requested before anything
 * awaits.
 *
 * PAIRING opens Helm in a tab, which closes the popup; opening the popup
 * again shows the fingerprint to check against the one Helm shows.
 */
import { PAIR_PATH } from '../../src/lib/extension/pairing-protocol';
import type { ExtensionMe } from '../../src/lib/extension/types';
import { call, signOut } from './api';
import { browserName, platformName } from './browser';
import { normaliseServer } from './server';
import { applyTheme, type Theme } from './theme';
import {
  MAX_FAILURES, checkSecret, disableLock, enableLock, getLock, lockNow, lockState, unlock,
  type LockMethod, type UnlockResult,
} from './lock';
import {
  clearPairing, fingerprint, getKey, getPairing, getPending, getServer, getSettings, makePendingKey, randomState,
  setPending, setServer, setSettings, type Settings, type TimeoutAction,
} from './store';

const ALL_HTTPS = { origins: ['https://*/*'] };

const TIMEOUTS: [number, string][] = [
  [5, '5 minutes'],
  [15, '15 minutes'],
  [60, '1 hour'],
  [240, '4 hours'],
  [0, 'When the browser restarts'],
  [-1, 'Never'],
];

function el(tag: string, attrs: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function button(label: string, onClick: () => void, variant: 'primary' | 'secondary' | 'danger' = 'secondary'): HTMLButtonElement {
  const node = el('button', { type: 'button', class: variant }, label) as HTMLButtonElement;
  node.addEventListener('click', onClick);
  return node;
}

function select(id: string, choices: [string, string][], value: string): HTMLSelectElement {
  const node = el('select', { id }, ...choices.map(([v, label]) => el('option', { value: v }, label))) as HTMLSelectElement;
  node.value = value;
  return node;
}

function toggle(id: string, label: string, hint: string, checked: boolean, onChange: (on: boolean, box: HTMLInputElement) => void): HTMLElement {
  const box = el('input', { id, type: 'checkbox', role: 'switch' }) as HTMLInputElement;
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked, box));
  return el('div', { class: 'toggle' },
    el('label', { for: id }, el('span', { class: 'toggle-label' }, label), el('span', { class: 'toggle-hint' }, hint)),
    box);
}

function section(title: string, ...children: Node[]): HTMLElement {
  return el('section', { class: 'settings-card' }, el('h2', {}, title), ...children);
}

const noun = (method: LockMethod) => (method === 'pin' ? 'PIN' : 'password');

function secretInput(method: LockMethod, id: string, label: string): HTMLInputElement {
  return el('input', {
    id, type: 'password', autocomplete: 'off', 'aria-label': label, placeholder: label,
    ...(method === 'pin' ? { inputmode: 'numeric', maxlength: '12' } : {}),
  }) as HTMLInputElement;
}

function unlockMessage(result: UnlockResult, failures: number, method: LockMethod): string {
  if (result === 'forgotten') return 'Too many wrong tries, so this browser is no longer paired. Pair it again above.';
  const left = MAX_FAILURES - failures;
  return `That ${noun(method)} is not right. ${left} ${left === 1 ? 'try' : 'tries'} left before this browser is unpaired.`;
}

export function mountSettings(root: HTMLElement): { refresh: () => Promise<void> } {
  let rendering = Promise.resolve();
  const refresh = () => {
    rendering = rendering.then(render, render);
    return rendering;
  };

  /* ---------------------------------------------------------------------- *
   * Account: the Helm address and the pairing
   * ---------------------------------------------------------------------- */

  async function serverCard(server: string | null): Promise<HTMLElement> {
    const input = el('input', {
      id: 'server', type: 'text', placeholder: 'https://helm.example.com', autocomplete: 'off', spellcheck: 'false',
    }) as HTMLInputElement;
    input.value = server ?? '';
    const note = el('p', { class: 'muted small', id: 'server-note' },
      'The address you sign in to Helm at. The browser asks you to let the extension reach it.');
    const form = el('form', { class: 'row' }, input, el('button', { type: 'submit', class: 'primary' }, 'Save'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const origin = normaliseServer(input.value);
      if (!origin) {
        note.textContent = 'Enter your Helm address, for example https://helm.example.com.';
        return;
      }
      // Straight from the click: the browser only asks for a user gesture.
      chrome.permissions.request({ origins: [`${origin}/*`] }, (granted) => {
        void (async () => {
          if (!granted) {
            note.textContent = 'The extension needs access to your Helm address to look credentials up.';
            return;
          }
          const previous = await getServer();
          if (previous && previous !== origin) {
            await clearPairing();
            await chrome.permissions.remove({ origins: [`${previous}/*`] }).catch(() => false);
          }
          await setServer(origin);
          await refresh();
        })();
      });
    });
    return section('Helm server', form, note);
  }

  async function startPairing(): Promise<void> {
    const server = await getServer();
    if (!server) return;
    const [key, browser] = await Promise.all([makePendingKey(), browserName()]);
    const state = randomState();
    const label = `${browser} on ${platformName()}`;
    const fragment = new URLSearchParams({
      key: key.publicKey, label, browser, version: chrome.runtime.getManifest().version, state,
    });
    const tab = await chrome.tabs.create({ url: `${server}${PAIR_PATH}#${fragment.toString()}` });
    if (tab.id === undefined) return;
    await setPending({ state, tabId: tab.id, origin: server, label });
    await refresh();
  }

  async function accountCard(server: string): Promise<HTMLElement> {
    const pairing = await getPairing();
    if (!pairing) {
      const pending = await getPending();
      const pendingKey = pending ? await getKey('pending') : null;
      if (pending && pendingKey) {
        return section('Account',
          el('p', {}, 'Helm is open in a tab. Sign in if it asks, check that it shows this fingerprint, then enter your Helm password and press Pair:'),
          el('p', { class: 'fingerprint' }, await fingerprint(pendingKey.publicKey)),
          el('p', { class: 'muted small' }, 'If Helm asked you to sign in first and then says the link did not come from the extension, press Pair again.'),
          el('div', { class: 'row' }, button('Pair again', () => void startPairing())),
        );
      }
      return section('Account',
        el('p', {}, 'This browser is not paired. Pairing lets the extension look credentials up, fill and save them as you, from this browser only.'),
        el('div', { class: 'row' }, button('Pair with Helm', () => void startPairing(), 'primary')),
      );
    }

    if ((await lockState()) === 'locked') {
      return section('Account', el('p', { class: 'muted' }, `Paired with ${pairing.tenantName}. Unlock below to see more.`));
    }
    const [key, me] = await Promise.all([getKey('device'), call<ExtensionMe>('/api/extension/me')]);
    if (!me.ok) {
      return section('Account',
        el('p', { class: 'error' }, me.message),
        el('div', { class: 'row' }, button('Pair with Helm', () => void startPairing(), 'primary')));
    }
    const rows = el('dl', {},
      el('dt', {}, 'Signed in as'), el('dd', {}, `${me.value.userName} (${me.value.userEmail})`),
      el('dt', {}, 'Tenant'), el('dd', {}, me.value.tenantName),
      el('dt', {}, 'This browser'), el('dd', {}, me.value.label),
      el('dt', {}, 'Key fingerprint'), el('dd', { class: 'fingerprint small-fp' }, key ? await fingerprint(key.publicKey) : '—'),
      el('dt', {}, 'Renews by'), el('dd', {}, new Date(me.value.expiresAt).toLocaleDateString()),
    );
    const extra: Node[] = [];
    if (!me.value.canSave) {
      extra.push(el('p', { class: 'notice' },
        'This browser was paired before the extension could save logins. Pair it again to save and update logins from here; it takes your Helm password once more.'),
      el('div', { class: 'row' }, button('Pair again', () => void startPairing(), 'primary')));
    }
    const security = button('Two-step sign-in and password', () => {
      void chrome.tabs.create({ url: `${server}/profile` });
    });
    const out = button('Sign out', () => void signOut().then(refresh), 'danger');
    return section('Account', rows, ...extra, el('div', { class: 'row wrap' }, security, out),
      el('p', { class: 'muted small' }, 'Two-step sign-in and your Helm password are changed in Helm itself.'));
  }

  /* ---------------------------------------------------------------------- *
   * Account security: unlock, the timeout and its action
   * ---------------------------------------------------------------------- */

  async function securityCard(settings: Settings): Promise<HTMLElement> {
    const state = await lockState();
    const lock = await getLock();
    const note = el('p', { class: 'muted small', role: 'status' });
    const parts: Node[] = [];

    if (state === 'off' || !lock) {
      const method = select('lock-method', [['pin', 'A PIN'], ['password', 'A password']], 'pin');
      const fields = el('div', { class: 'lock-fields' });
      let secret = secretInput('pin', 'lock-secret', 'New PIN');
      let confirm = secretInput('pin', 'lock-confirm', 'The same again');
      const draw = () => {
        const m = method.value as LockMethod;
        secret = secretInput(m, 'lock-secret', `New ${noun(m)}`);
        confirm = secretInput(m, 'lock-confirm', 'The same again');
        fields.replaceChildren(secret, confirm);
      };
      method.addEventListener('change', draw);
      draw();
      const turnOn = button('Turn on', () => void (async () => {
        const m = method.value as LockMethod;
        const problem = checkSecret(m, secret.value) ?? (secret.value === confirm.value ? null : `The two ${noun(m)}s differ.`);
        if (problem) {
          note.textContent = problem;
          return;
        }
        turnOn.disabled = true;
        note.textContent = 'Turning it on…';
        try {
          await enableLock(m, secret.value);
          // A lock is what a timeout usually means; lock after 15 minutes
          // unless the person already chose something.
          if (settings.timeoutMinutes < 0) await setSettings({ timeoutAction: 'lock', timeoutMinutes: 15 });
          else await setSettings({ timeoutAction: 'lock' });
        } catch {
          note.textContent = 'Could not turn the lock on. Is this browser still paired?';
          turnOn.disabled = false;
          return;
        }
        await refresh();
      })(), 'primary');
      parts.push(
        el('p', { class: 'muted small' }, 'Ask for a PIN or password before the extension shows, fills or saves anything. It always locks when the browser closes.'),
        el('label', { for: 'lock-method' }, 'Unlock with'), method, fields,
        el('div', { class: 'row' }, turnOn),
      );
    } else if (state === 'locked') {
      const secret = secretInput(lock.method, 'unlock-secret', `Your ${noun(lock.method)}`);
      const form = el('form', { class: 'row' }, secret, el('button', { type: 'submit', class: 'primary' }, 'Unlock'));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void (async () => {
          const result = await unlock(secret.value);
          if (result === 'unlocked') {
            await refresh();
            return;
          }
          secret.value = '';
          note.textContent = unlockMessage(result, (await getLock())?.failures ?? MAX_FAILURES, lock.method);
          if (result === 'forgotten') await refresh();
        })();
      });
      parts.push(el('p', {}, `Locked. Enter your ${noun(lock.method)} to unlock.`), form);
      return section('Account security', ...parts, note);
    } else {
      const current = secretInput(lock.method, 'lock-current', `Your ${noun(lock.method)}`);
      const turnOff = button('Turn off', () => void (async () => {
        turnOff.disabled = true;
        const result = await disableLock(current.value);
        if (result === 'unlocked') {
          if (settings.timeoutAction === 'lock') await setSettings({ timeoutAction: 'signout', timeoutMinutes: -1 });
          await refresh();
          return;
        }
        turnOff.disabled = false;
        current.value = '';
        note.textContent = unlockMessage(result, (await getLock())?.failures ?? MAX_FAILURES, lock.method);
        if (result === 'forgotten') await refresh();
      })());
      parts.push(
        el('p', {}, `Unlock with a ${noun(lock.method)}. It locks when the browser closes.`),
        el('div', { class: 'row' }, button('Lock now', () => void lockNow().then(refresh))),
        el('label', { for: 'lock-current' }, `To stop asking, enter your ${noun(lock.method)}`),
        el('div', { class: 'row' }, current, turnOff),
      );
    }

    // The timeout and what it does, as Bitwarden's "Vault timeout" and
    // "Timeout action". Locking needs a PIN or password to unlock with.
    const action = select('timeout-action',
      [['lock', lock ? 'Lock' : 'Lock (set a PIN or password first)'], ['signout', 'Sign out']],
      lock ? settings.timeoutAction : 'signout');
    (action.querySelector('option[value="lock"]') as HTMLOptionElement).disabled = !lock;
    const choices = TIMEOUTS.filter(([m]) => !(m === -1 && action.value === 'lock'));
    const minutes = select('timeout', choices.map(([m, l]) => [String(m), l]), String(settings.timeoutMinutes));
    if (!choices.some(([m]) => String(m) === minutes.value)) minutes.value = '15';
    action.addEventListener('change', () => void (async () => {
      const next = action.value as TimeoutAction;
      await setSettings({
        timeoutAction: next,
        ...(next === 'lock' && settings.timeoutMinutes < 0 ? { timeoutMinutes: 15 } : {}),
      });
      await refresh();
    })());
    minutes.addEventListener('change', () => void setSettings({ timeoutMinutes: Number(minutes.value) }));
    parts.push(
      el('div', { class: 'pair-fields' },
        el('div', { class: 'field' }, el('label', { for: 'timeout' }, 'Timeout'), minutes),
        el('div', { class: 'field' }, el('label', { for: 'timeout-action' }, 'Timeout action'), action)),
      el('p', { class: 'muted small' }, action.value === 'signout'
        ? 'Signing out removes this browser from Helm. You pair it again, with your Helm password, to use it.'
        : 'After the timeout it asks for your PIN or password again.'),
    );
    return section('Account security', ...parts, note);
  }

  /* ---------------------------------------------------------------------- *
   * Autofill and saving
   * ---------------------------------------------------------------------- */

  function autofillCard(settings: Settings, granted: boolean): HTMLElement {
    const note = el('p', { class: 'muted small', role: 'status' });
    // Asked for from the click itself, before anything awaits.
    const turn = (key: 'inlineMenu' | 'offerToSave') => (on: boolean, box: HTMLInputElement) => {
      if (!on) {
        void setSettings({ [key]: false });
        return;
      }
      chrome.permissions.request(ALL_HTTPS, (ok) => {
        if (!ok) {
          box.checked = false;
          note.textContent = 'The browser did not give the extension access to web pages, so this stays off.';
          return;
        }
        void setSettings({ [key]: true });
      });
    };
    const never = settings.neverSave.length
      ? el('div', { class: 'never' },
          el('p', { class: 'small' }, 'Never offered on:'),
          el('ul', {}, ...settings.neverSave.map((host) => el('li', {}, el('span', {}, host), button('Offer again', () => {
            void setSettings({ neverSave: settings.neverSave.filter((h) => h !== host) }).then(refresh);
          })))))
      : el('span', {});
    return section('Autofill and saving',
      toggle('inline-menu', 'Show Helm in sign-in fields',
        'A Helm icon in username and password boxes when Helm has a login for the site. Click it to fill.',
        settings.inlineMenu && granted, turn('inlineMenu')),
      toggle('offer-save', 'Offer to save and update logins',
        'After you sign in, offer to save a login Helm does not have, or to update a password that changed.',
        settings.offerToSave && granted, turn('offerToSave')),
      never,
      el('p', { class: 'muted small' }, 'Both need access to the https pages you visit; the browser asks once. Helm never fills a page without your click, and never presses Sign in.'),
      note,
    );
  }

  function generalCard(settings: Settings): HTMLElement {
    const clipboard = select('clipboard', [['30', '30 seconds'], ['60', '1 minute'], ['120', '2 minutes'], ['0', 'Never']],
      String(settings.clearClipboardSeconds));
    clipboard.addEventListener('change', () => void setSettings({ clearClipboardSeconds: Number(clipboard.value) }));
    const theme = select('theme', [['system', 'Match the system'], ['light', 'Light'], ['dark', 'Dark']], settings.theme);
    theme.addEventListener('change', () => {
      applyTheme(theme.value as Theme);
      void setSettings({ theme: theme.value as Theme });
    });
    return section('General',
      el('div', { class: 'pair-fields' },
        el('div', { class: 'field' }, el('label', { for: 'clipboard' }, 'Clear a copied password after'), clipboard),
        el('div', { class: 'field' }, el('label', { for: 'theme' }, 'Theme'), theme)));
  }

  async function render(): Promise<void> {
    const [server, settings, granted] = await Promise.all([
      getServer(), getSettings(), chrome.permissions.contains(ALL_HTTPS),
    ]);
    applyTheme(settings.theme);
    const cards: HTMLElement[] = [];
    if (!server) {
      cards.push(await serverCard(null));
    } else {
      cards.push(await accountCard(server));
      if (await getPairing()) cards.push(await securityCard(settings));
      if ((await lockState()) !== 'locked') cards.push(autofillCard(settings, granted));
      cards.push(generalCard(settings), await serverCard(server));
    }
    cards.push(el('p', { class: 'muted small settings-foot' },
      `Helm extension ${chrome.runtime.getManifest().version}. It fills, copies and saves standard passwords and one-time codes; elevated and critical credentials stay in Helm itself. Every fill, copy and save is recorded in Helm's audit log.`));
    root.replaceChildren(...cards);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.pairing || changes.server || changes.lock)) void refresh();
    if (area === 'session' && (changes.unlocked || changes.pending)) void refresh();
  });

  void refresh();
  return { refresh };
}
