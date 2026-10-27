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
 */
import type { ExtensionEntry, ExtensionLookup } from '../../src/lib/extension/types';
import { call, renewIfDue, type Result } from './api';
import { getPairing, getServer } from './store';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $('list');
const status = $('status');
const searchInput = $<HTMLInputElement>('search');
const heading = $('heading');

let server = '';
let siteEntries: ExtensionEntry[] = [];
let siteLabel = '';

function setStatus(message: string, tone: 'muted' | 'error' | 'ok' = 'muted'): void {
  status.textContent = message;
  status.className = `status ${tone}`;
}

function el(tag: string, attrs: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function action(label: string, title: string, onClick: (button: HTMLButtonElement) => Promise<void>): HTMLButtonElement {
  const node = el('button', { type: 'button', class: 'action', title, 'aria-label': title }, label) as HTMLButtonElement;
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

function renderEntry(entry: ExtensionEntry): HTMLElement {
  const actions = el('div', { class: 'actions' });
  const row = el('li', { class: 'entry' },
    el('div', { class: 'meta' },
      el('div', { class: 'name' }, entry.name),
      // The client is the group's heading, so the line under the name is the username.
      el('div', { class: 'sub' }, entry.username ?? ''),
    ),
    actions,
  );

  if (entry.username) {
    const username = entry.username;
    actions.append(action('User', `Copy the username for ${entry.name}`, async () => {
      if (await writeClipboard(username, false)) setStatus('Copied the username.', 'ok');
    }));
  }
  if (entry.passwordCopyable) {
    actions.append(action('Password', `Copy the password for ${entry.name}`, () => copyPassword(entry, row)));
  }
  if (entry.hasTotp) {
    actions.append(action('Code', `Copy the one-time code for ${entry.name}`, () => copyCode(entry, row)));
  }
  if (entry.hasPassword && !entry.passwordCopyable) {
    actions.append(action('Open', `${entry.name} is copied from Helm itself; open it there`, async () => openInHelm(entry)));
  } else {
    actions.append(action('↗', `Open ${entry.name} in Helm`, async () => openInHelm(entry)));
  }
  return row;
}

function renderGroups(entries: ExtensionEntry[], empty: string): void {
  if (entries.length === 0) {
    list.replaceChildren(el('p', { class: 'empty' }, empty));
    return;
  }
  // Grouped by client, so a shared sign-in page — Microsoft 365's, a vendor
  // portal's — reads as a choice of client rather than a wall of look-alikes.
  const groups = new Map<string, ExtensionEntry[]>();
  for (const entry of entries) {
    const name = entry.organizationName ?? 'Personal';
    groups.set(name, [...(groups.get(name) ?? []), entry]);
  }
  list.replaceChildren(
    ...[...groups].map(([name, items]) =>
      el('section', {}, el('h2', {}, name), el('ul', {}, ...items.map(renderEntry))),
    ),
  );
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    heading.textContent = siteLabel;
    renderGroups(siteEntries, 'Nothing in Helm names this site. Search instead.');
    return;
  }
  searchTimer = setTimeout(() => {
    const seq = ++searchSeq;
    void call<{ entries: ExtensionEntry[] }>('/api/extension/search', { json: { q } }).then((result) => {
      if (seq !== searchSeq) return;
      if (!result.ok) {
        setStatus(result.message, 'error');
        return;
      }
      heading.textContent = `Search: ${q}`;
      renderGroups(result.value.entries, 'Nothing matches.');
    });
  }, 250);
});

$('settings').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
  window.close();
});

async function start(): Promise<void> {
  const [configured, pairing] = await Promise.all([getServer(), getPairing()]);
  if (!configured || !pairing) {
    heading.textContent = 'Not set up';
    list.replaceChildren(
      el('p', { class: 'empty' }, 'Pair this browser with your Helm server to look credentials up here.'),
    );
    searchInput.disabled = true;
    return;
  }
  server = configured;
  void renewIfDue();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  setStatus('Looking this site up…');
  const result = await call<ExtensionLookup>('/api/extension/match', { json: { url: tab?.url ?? '' } });
  if (!result.ok) {
    setStatus(result.message, 'error');
    return;
  }
  setStatus(pairing.tenantName);
  siteEntries = result.value.entries;
  siteLabel = result.value.host ?? 'This page';
  heading.textContent = siteLabel;
  renderGroups(siteEntries, result.value.host ? 'Nothing in Helm names this site. Search instead.' : 'Search Helm.');
  searchInput.focus();
}

void start();
