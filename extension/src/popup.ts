/**
 * The popup: the credentials for the tab it opened on, a search, and copy.
 *
 * WHAT IT SENDS. The tab's URL, once, to Helm, which does the matching
 * (src/lib/extension/lookup.ts). The extension keeps no copy of the vault and
 * no list of credentials between openings.
 *
 * WHAT A COPY IS. A reveal with purpose 'copy', through the same audited
 * route the web interface uses, straight to the clipboard; the plaintext is
 * never put in the page. The background then clears the clipboard after the
 * time chosen in settings. A username is copied without asking Helm: it was
 * already in the list, as it is on a credential's page.
 *
 * WHAT IT WILL NOT COPY. Anything Helm marks elevated or critical, or that
 * needs a step-up: those rows offer "Open in Helm" instead, and Helm refuses
 * the copy anyway if asked (1120).
 *
 * WHAT IT SHOWS. Laid out like Bitwarden's popup: a search in the header, and
 * cards below it. The site's matches first; when there are none, what the
 * person used lately and what MSP staff use most (1121). Typing searches as
 * it goes, near misses included, and Escape goes back to the site.
 */
import type { ExtensionEntry, ExtensionLookup } from '../../src/lib/extension/types';
import { call, renewIfDue, type Result } from './api';
import { getPairing, getServer, getSettings } from './store';
import { applyRememberedTheme, applyTheme } from './theme';

applyRememberedTheme();
void getSettings().then((settings) => applyTheme(settings.theme));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $('list');
const status = $('status');
const searchInput = $<HTMLInputElement>('search');
const tenant = $('tenant');

let server = '';
let siteView: () => void = () => {};

/** Constant markup only: Lucide's outlines, so the popup draws like Helm. */
const ICONS = {
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
} as const;

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  svg.innerHTML = ICONS[name];
  return svg;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function setStatus(message: string, tone: 'muted' | 'error' | 'ok' = 'muted'): void {
  clearTimeout(toastTimer);
  status.textContent = message;
  status.className = `toast ${tone}`;
  status.hidden = message === '';
  // Errors stay until the next action; a confirmation goes on its own.
  if (tone !== 'error' && message) toastTimer = setTimeout(() => { status.hidden = true; }, 2500);
}

function el(tag: string, attrs: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function action(
  glyph: keyof typeof ICONS,
  title: string,
  onClick: (button: HTMLButtonElement) => Promise<void>,
): HTMLButtonElement {
  const node = el('button', { type: 'button', class: 'icon-button', title, 'aria-label': title }, icon(glyph)) as HTMLButtonElement;
  node.addEventListener('click', () => {
    node.disabled = true;
    void onClick(node).finally(() => {
      node.disabled = false;
    });
  });
  return node;
}

async function writeClipboard(value: string, secret: boolean): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    setStatus('The browser would not let the extension write to the clipboard.', 'error');
    return false;
  }
  if (secret) void chrome.runtime.sendMessage({ kind: 'helm-copied' });
  return true;
}

/** Ask for a justification inline, for a credential that needs one. */
function askReason(row: HTMLElement): Promise<string | null> {
  return new Promise((resolve) => {
    const input = el('input', {
      type: 'text', placeholder: 'Why do you need it? (10 characters or more)', maxlength: '500',
    }) as HTMLInputElement;
    const form = el('form', { class: 'reason' }, input, el('button', { type: 'submit', class: 'primary' }, 'Copy'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const reason = input.value.trim();
      if (reason.length < 10) {
        input.setCustomValidity('At least 10 characters.');
        input.reportValidity();
        return;
      }
      form.remove();
      resolve(reason);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        form.remove();
        resolve(null);
      }
    });
    row.append(form);
    input.focus();
  });
}

/**
 * One reveal, asking for a justification first when Helm is known to want
 * one, and once more if Helm says so anyway (a TOTP seed carries its own
 * rules, which the list does not show).
 */
async function withReason<T>(
  row: HTMLElement,
  askFirst: boolean,
  attempt: (reason: string | null) => Promise<Result<T>>,
): Promise<Result<T> | null> {
  let reason: string | null = null;
  if (askFirst) {
    reason = await askReason(row);
    if (!reason) return null;
  }
  const first = await attempt(reason);
  if (first.ok || first.code !== 'reason_required' || reason) return first;
  reason = await askReason(row);
  return reason ? attempt(reason) : null;
}

async function copyPassword(entry: ExtensionEntry, row: HTMLElement): Promise<void> {
  const result = await withReason(row, entry.kind === 'client' && entry.requiresReason, (reason) =>
    entry.kind === 'client'
      ? call<{ value: string }>(`/api/secrets/${entry.secretId}/reveal`, {
          json: { purpose: 'copy', ...(reason ? { reason } : {}) },
        })
      : call<{ value: string }>(`/api/personal/vault/${entry.id}/reveal`, { json: { purpose: 'copy' } }),
  );
  if (!result) return;
  if (!result.ok) {
    setStatus(result.message, 'error');
    return;
  }
  if (await writeClipboard(result.value.value, true)) setStatus(`Copied the password for ${entry.name}.`, 'ok');
}

async function copyCode(entry: ExtensionEntry, row: HTMLElement): Promise<void> {
  type Code = { code: string; secondsRemaining: number };
  const result = await withReason(row, false, (reason) =>
    entry.kind === 'client'
      ? call<Code>(`/api/assets/${entry.id}/totp/code`, { json: reason ? { reason } : {} })
      : call<Code>(`/api/personal/vault/${entry.id}/code`, { json: {} }),
  );
  if (!result) return;
  if (!result.ok) {
    setStatus(result.message, 'error');
    return;
  }
  if (await writeClipboard(result.value.code, true)) {
    setStatus(`Copied the code for ${entry.name}; it changes in ${result.value.secondsRemaining}s.`, 'ok');
  }
}

function openInHelm(entry: ExtensionEntry): void {
  const path = entry.kind === 'client' ? `/assets/${entry.id}` : `/personal/passwords/${entry.id}`;
  void chrome.tabs.create({ url: `${server}${path}` });
  window.close();
}

/** A steady colour per client, so the same client reads the same in every list. */
function hue(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function avatar(entry: ExtensionEntry): HTMLElement {
  if (entry.kind === 'personal') {
    return el('span', { class: 'avatar personal', title: 'Your own vault' }, icon('lock'));
  }
  const label = entry.organizationName ?? entry.name;
  const node = el('span', { class: 'avatar', title: label }, (entry.name.trim()[0] ?? '?').toUpperCase());
  node.style.setProperty('--hue', String(hue(label)));
  return node;
}

function renderEntry(entry: ExtensionEntry): HTMLElement {
  const actions = el('div', { class: 'actions' });
  const sub = [entry.username, entry.organizationName ?? 'Personal'].filter(Boolean).join(' · ');
  const meta = el('div', { class: 'meta' },
    el('div', { class: 'name' }, entry.name),
    el('div', { class: 'sub' }, sub),
  );
  const row = el('li', { class: 'entry' }, avatar(entry), meta, actions);

  if (entry.username) {
    const username = entry.username;
    actions.append(action('user', `Copy the username for ${entry.name}`, async () => {
      if (await writeClipboard(username, false)) setStatus('Username copied', 'ok');
    }));
  }
  if (entry.passwordCopyable) {
    actions.append(action('key', `Copy the password for ${entry.name}`, () => copyPassword(entry, row)));
  }
  if (entry.hasTotp) {
    actions.append(action('clock', `Copy the one-time code for ${entry.name}`, () => copyCode(entry, row)));
  }
  const locked = entry.hasPassword && !entry.passwordCopyable;
  actions.append(action('open',
    locked ? `${entry.name}'s password is copied from Helm itself; open it there` : `Open ${entry.name} in Helm`,
    async () => openInHelm(entry)));
  if (locked) meta.append(el('div', { class: 'note' }, 'Password stays in Helm'));
  return row;
}

function section(title: string, entries: ExtensionEntry[], note?: string): HTMLElement {
  return el('section', { class: 'card' },
    el('h2', {}, el('span', {}, title), el('span', { class: 'count' }, String(entries.length))),
    ...(note ? [el('p', { class: 'card-note' }, note)] : []),
    el('ul', {}, ...entries.map(renderEntry)),
  );
}

function emptyCard(message: string): HTMLElement {
  return el('section', { class: 'card empty' }, el('p', {}, message));
}

function render(...nodes: HTMLElement[]): void {
  list.replaceChildren(...nodes);
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;

function runSearch(): void {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q === '') {
    searchSeq += 1;
    siteView();
    return;
  }
  // Short enough to feel live, long enough not to ask Helm on every key of a
  // word typed quickly.
  searchTimer = setTimeout(() => {
    const seq = ++searchSeq;
    void call<{ entries: ExtensionEntry[] }>('/api/extension/search', { json: { q } }).then((result) => {
      if (seq !== searchSeq) return;
      if (!result.ok) {
        setStatus(result.message, 'error');
        return;
      }
      render(result.value.entries.length
        ? section('Search results', result.value.entries)
        : emptyCard(`Nothing in Helm matches “${q}”.`));
    });
  }, 150);
}

searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && searchInput.value) {
    event.preventDefault();
    searchInput.value = '';
    runSearch();
  }
});

$('settings').append(icon('settings'));
$('settings').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
  window.close();
});
document.querySelector('.search-icon')?.append(icon('search'));

async function start(): Promise<void> {
  const [configured, pairing] = await Promise.all([getServer(), getPairing()]);
  if (!configured || !pairing) {
    tenant.textContent = 'Not set up';
    const button = el('button', { type: 'button', class: 'primary' }, 'Open settings');
    button.addEventListener('click', () => {
      void chrome.runtime.openOptionsPage();
      window.close();
    });
    render(el('section', { class: 'card empty' },
      el('p', {}, 'Pair this browser with your Helm server to look credentials up here.'),
      button,
    ));
    searchInput.disabled = true;
    return;
  }
  server = configured;
  tenant.textContent = pairing.tenantName;
  void renewIfDue();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  render(el('p', { class: 'loading' }, 'Looking this site up…'));
  searchInput.focus();
  const result = await call<ExtensionLookup>('/api/extension/match', { json: { url: tab?.url ?? '' } });
  if (!result.ok) {
    render(emptyCard(result.message));
    return;
  }

  const { host, entries, suggestions } = result.value;
  siteView = () => {
    if (entries.length) {
      render(section(host ? `For ${host}` : 'For this page', entries));
      return;
    }
    const cards: HTMLElement[] = [];
    if (host) cards.push(emptyCard(`Nothing in Helm names ${host}. Search above, or pick one below.`));
    if (suggestions?.recent.length) cards.push(section('Recently used', suggestions.recent));
    if (suggestions?.popular.length) cards.push(section('Popular with your team', suggestions.popular));
    render(...(cards.length ? cards : [emptyCard('Search Helm above.')]));
  };
  // Typed into while the lookup was running: that search wins.
  if (searchInput.value.trim() === '') siteView();
}

void start();
