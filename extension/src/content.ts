/**
 * In the page: the Helm icon in sign-in fields, and noticing a sign-in so the
 * background can offer to save or update it. Registered on https pages only,
 * and only once the person turns either on in settings (background.ts).
 *
 * WHAT THIS SCRIPT CAN DO, AND WHAT IT CANNOT. It runs beside the page, in
 * the extension's isolated world, so the page's own script cannot reach its
 * variables; but it is in the page's process, so it is trusted no further
 * than the page. It therefore never holds a credential from Helm, and cannot
 * ask for one. It can tell the background "this page has a sign-in form" and
 * "the person just signed in with this", and it can draw two frames whose
 * contents are the extension's own pages (menu.html, notify.html): the page
 * cannot read what is in them, which is where the list of logins and the save
 * prompt live. Filling is asked for by the menu frame, and done by the
 * background into this frame, after checking the frame is still on the site
 * the list was for.
 *
 * THE ICON sits over the right end of a username or password field when Helm
 * has a login for this site (or is locked), in a closed shadow root so the
 * page's styles neither hide nor restyle it. Clicking it opens the menu frame
 * under the field.
 *
 * NOTICING A SIGN-IN. A form submitted, a button that looks like Sign in
 * clicked, or Enter in a password field, with a password typed: the username
 * and password are sent to the background, which keeps them in memory only
 * until the person answers the prompt. A username-only step (Microsoft's,
 * Google's) is remembered for the password step that follows.
 */

export {};

type Status = { show: boolean; count: number; locked: boolean };

const ICON_SIZE = 20;
const shown = (input: HTMLInputElement) =>
  !input.disabled && !input.readOnly && input.getClientRects().length > 0
  && getComputedStyle(input).visibility !== 'hidden' && input.offsetWidth >= 80;
const textual = (input: HTMLInputElement) => ['text', 'email', 'tel', ''].includes(input.type);
const hints = (input: HTMLInputElement) =>
  `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute('aria-label') ?? ''} ${input.autocomplete}`;
const looksLikeUsername = (input: HTMLInputElement) =>
  /\b(username|email)\b/.test(input.autocomplete) || input.type === 'email'
  || /user|e-?mail|login|account|identifier/i.test(hints(input));
const looksLikeSearch = (input: HTMLInputElement) => input.type === 'search' || /search|query|\bq\b/i.test(hints(input));

/** The sign-in fields on the page now: password fields, and the username before each, or alone. */
function loginFields(): { username: HTMLInputElement | null; password: HTMLInputElement | null }[] {
  const inputs = Array.from(document.querySelectorAll('input')).filter(shown);
  const passwords = inputs.filter((i) => i.type === 'password');
  if (passwords.length > 0) {
    return passwords.map((password) => {
      const before = inputs.slice(0, inputs.indexOf(password)).filter((i) => textual(i) && !looksLikeSearch(i));
      return { password, username: before.find(looksLikeUsername) ?? before.at(-1) ?? null };
    });
  }
  // A username-only step: only a field that says it is one.
  const username = inputs.find((i) => textual(i) && looksLikeUsername(i) && !looksLikeSearch(i)) ?? null;
  return username ? [{ username, password: null }] : [];
}

function send<T>(message: Record<string, unknown>): Promise<T | null> {
  return chrome.runtime.sendMessage(message).catch(() => null) as Promise<T | null>;
}

/* ------------------------------------------------------------------------- *
 * The icon and the menu
 * ------------------------------------------------------------------------- */

const ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>`;
const LOCK_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

const hostEl = document.createElement('helm-extension-ui');
const root = hostEl.attachShadow({ mode: 'closed' });
root.innerHTML = `<style>
  :host { all: initial; }
  .icon { position: absolute; z-index: 2147483646; width: ${ICON_SIZE}px; height: ${ICON_SIZE}px; padding: 0; margin: 0;
    border: 0; border-radius: 5px; background: #0b6db0; color: #fff; display: grid; place-items: center; cursor: pointer;
    box-shadow: 0 1px 2px #0004; opacity: .92; }
  .icon:hover { opacity: 1; }
  .icon.locked { background: #4b5563; }
  iframe { position: absolute; z-index: 2147483647; border: 0; border-radius: 10px; box-shadow: 0 8px 28px #0005;
    color-scheme: normal; background: transparent; }
  iframe.bar { position: fixed; top: 12px; right: 12px; width: 380px; }
</style>`;

let status: Status = { show: false, count: 0, locked: false };
let statusAt = 0;
const icons = new Map<HTMLInputElement, HTMLButtonElement>();
let menu: { frame: HTMLIFrameElement; field: HTMLInputElement; token: string } | null = null;

function attach(): void {
  if (!hostEl.isConnected) document.documentElement.append(hostEl);
}

function place(field: HTMLInputElement, node: HTMLElement, below: boolean): void {
  const rect = field.getBoundingClientRect();
  if (below) {
    node.style.left = `${Math.max(4, rect.left + scrollX)}px`;
    node.style.top = `${rect.bottom + scrollY + 4}px`;
  } else {
    node.style.left = `${rect.right + scrollX - ICON_SIZE - 6}px`;
    node.style.top = `${rect.top + scrollY + (rect.height - ICON_SIZE) / 2}px`;
  }
}

function closeMenu(): void {
  if (menu) void send({ kind: 'helm-menu-closed', token: menu.token });
  menu?.frame.remove();
  menu = null;
}

async function openMenu(field: HTMLInputElement): Promise<void> {
  closeMenu();
  const opened = await send<{ token: string }>({ kind: 'helm-menu-open' });
  if (!opened?.token) return;
  attach();
  const frame = document.createElement('iframe');
  frame.src = `${chrome.runtime.getURL('menu.html')}#${opened.token}`;
  frame.title = 'Helm';
  frame.setAttribute('allowtransparency', 'true');
  frame.style.width = `${Math.max(280, Math.min(360, field.offsetWidth))}px`;
  frame.style.height = `${Math.min(64 + Math.max(1, status.count) * 52, 300)}px`;
  place(field, frame, true);
  root.append(frame);
  menu = { frame, field, token: opened.token };
}

function drawIcons(): void {
  if (!status.show) {
    for (const icon of icons.values()) icon.remove();
    icons.clear();
    return;
  }
  const fields = new Set<HTMLInputElement>();
  for (const pair of loginFields()) {
    if (pair.username) fields.add(pair.username);
    if (pair.password) fields.add(pair.password);
  }
  for (const [field, icon] of icons) {
    if (!fields.has(field)) {
      icon.remove();
      icons.delete(field);
    }
  }
  attach();
  for (const field of fields) {
    let icon = icons.get(field);
    if (!icon) {
      icon = document.createElement('button');
      icon.type = 'button';
      icon.className = 'icon';
      icon.title = 'Fill from Helm';
      icon.setAttribute('aria-label', 'Fill from Helm');
      // Keep the field focused: a mousedown on the icon would blur it.
      icon.addEventListener('mousedown', (event) => event.preventDefault());
      icon.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (menu?.field === field) closeMenu();
        else void openMenu(field);
      });
      root.append(icon);
      icons.set(field, icon);
    }
    icon.classList.toggle('locked', status.locked);
    icon.innerHTML = status.locked ? LOCK_SVG : ICON_SVG;
    icon.title = status.locked ? 'Helm is locked' : `Fill from Helm (${status.count})`;
    place(field, icon, false);
  }
  if (menu) place(menu.field, menu.frame, true);
}

async function refreshStatus(force = false): Promise<void> {
  if (!force && Date.now() - statusAt < 60_000) return;
  statusAt = Date.now();
  status = (await send<Status>({ kind: 'helm-inline-status' })) ?? { show: false, count: 0, locked: false };
  drawIcons();
}

let scheduled = false;
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (loginFields().length > 0) void refreshStatus();
    drawIcons();
  });
}

/* ------------------------------------------------------------------------- *
 * Noticing a sign-in
 * ------------------------------------------------------------------------- */

let lastSent = '';
let lastSentAt = 0;

function capture(): void {
  const all = Array.from(document.querySelectorAll('input'));
  const typed = all.filter((i) => i.type === 'password' && i.value);
  if (typed.length === 0) {
    const username = loginFields().find((p) => p.username?.value)?.username?.value.trim();
    if (username) void send({ kind: 'helm-username-seen', username });
    return;
  }
  // A change-password form: the new password is the one to keep.
  const fresh = typed.filter((i) => i.autocomplete.includes('new-password'));
  const password = (typed.length > 1 && fresh.length > 0 ? fresh.at(-1) : typed[0])!;
  const before = all.slice(0, all.indexOf(typed[0]!)).filter((i) => textual(i) && !looksLikeSearch(i) && i.value);
  const username = (before.find(looksLikeUsername) ?? before.at(-1))?.value.trim() ?? '';
  const key = `${username}\u0000${password.value}`;
  if (key === lastSent && Date.now() - lastSentAt < 5_000) return;
  lastSent = key;
  lastSentAt = Date.now();
  void send({ kind: 'helm-captured', username, password: password.value });
}

const SUBMIT_WORDS = /\b(log ?in|sign ?in|sign ?on|continue|next|submit|verify|save|update|change)\b/i;

document.addEventListener('submit', () => capture(), true);
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element
    ? event.target.closest('button, input[type="submit"], input[type="button"], [role="button"]')
    : null;
  if (!target) {
    if (menu && !event.composedPath().includes(hostEl)) closeMenu();
    return;
  }
  const label = target instanceof HTMLInputElement ? target.value : target.textContent ?? '';
  if ((target as HTMLButtonElement).type === 'submit' || SUBMIT_WORDS.test(label)) capture();
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menu) closeMenu();
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) capture();
}, true);

/* ------------------------------------------------------------------------- *
 * The save prompt, and messages from the background
 * ------------------------------------------------------------------------- */

let bar: { frame: HTMLIFrameElement; token: string } | null = null;

function showBar(token: string): void {
  if (window !== window.top || bar?.token === token) return;
  bar?.frame.remove();
  attach();
  const frame = document.createElement('iframe');
  frame.src = `${chrome.runtime.getURL('notify.html')}#${token}`;
  frame.title = 'Save to Helm';
  frame.className = 'bar';
  frame.style.height = '150px';
  root.append(frame);
  bar = { frame, token };
}

chrome.runtime.onMessage.addListener((message: { kind?: string; token?: string; height?: number }) => {
  if (message.kind === 'helm-show-bar' && message.token) showBar(message.token);
  else if (message.kind === 'helm-bar-close') {
    bar?.frame.remove();
    bar = null;
  } else if (message.kind === 'helm-bar-size' && bar && typeof message.height === 'number') {
    bar.frame.style.height = `${Math.min(Math.max(message.height, 60), 520)}px`;
  } else if (message.kind === 'helm-menu-size' && menu && typeof message.height === 'number') {
    menu.frame.style.height = `${Math.min(Math.max(message.height, 40), 320)}px`;
  } else if (message.kind === 'helm-menu-close') closeMenu();
  else if (message.kind === 'helm-status-changed') void refreshStatus(true);
  return false;
});

new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'style', 'class', 'hidden'] });
addEventListener('scroll', schedule, true);
addEventListener('resize', schedule);
addEventListener('focusin', (event) => {
  if (event.target instanceof HTMLInputElement) void refreshStatus();
});
schedule();
// A prompt from a sign-in on the page before this one.
if (window === window.top) {
  void send<{ token: string | null }>({ kind: 'helm-bar-pending' }).then((pending) => {
    if (pending?.token) showBar(pending.token);
  });
}
