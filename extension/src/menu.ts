/**
 * The list of logins under a sign-in field (content.ts draws the frame; the
 * background, inpage.ts, holds the list and fills). This page is the
 * extension's own, so the site it is drawn over cannot read the names in it.
 *
 * Everything it asks carries the token in its address, which names the one
 * frame of one tab it was opened for.
 */
import type { MenuView } from './inpage';
import { clickCounts } from './guard';
import { applyRememberedTheme, applyTheme } from './theme';
import { getSettings } from './store';

applyRememberedTheme();
void getSettings().then((s) => applyTheme(s.theme));

const token = location.hash.slice(1);
const body = document.getElementById('body')!;
const title = document.getElementById('title')!;

function el(tag: string, attrs: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

const ask = <T>(message: Record<string, unknown>) =>
  chrome.runtime.sendMessage({ ...message, token }) as Promise<T | null>;

function note(text: string, tone: 'muted' | 'error' = 'muted'): HTMLElement {
  return el('p', { class: `frame-note ${tone}` }, text);
}

async function render(): Promise<void> {
  const view = await ask<MenuView>({ kind: 'helm-menu-view' });
  if (!view) {
    body.replaceChildren(note('This list has expired. Click the Helm icon again.'));
    return;
  }
  title.textContent = `Helm · ${view.host}`;
  if (view.state === 'locked') {
    const unlock = el('button', { type: 'button', class: 'primary' }, 'Unlock Helm') as HTMLButtonElement;
    unlock.addEventListener('click', () => {
      if (!clickCounts()) return;
      void ask<boolean>({ kind: 'helm-open-popup' }).then((opened) => {
        if (!opened) body.replaceChildren(note('Click the Helm icon in the toolbar to unlock, then try again.'));
      });
    });
    body.replaceChildren(note('Helm is locked.'), el('div', { class: 'frame-actions' }, unlock));
    return;
  }
  if (view.state === 'empty') {
    body.replaceChildren(note(`Helm has nothing for ${view.host}.`));
    return;
  }
  const list = el('ul', { class: 'frame-list' });
  for (const entry of view.entries) {
    const avatar = el('span', { class: entry.personal ? 'avatar personal' : 'avatar' }, entry.personal ? '•' : (entry.name.trim()[0] ?? '?').toUpperCase());
    const meta = el('span', { class: 'meta' },
      el('span', { class: 'name' }, entry.name),
      el('span', { class: 'sub' }, entry.note ?? entry.sub));
    const button = el('button', { type: 'button', class: 'frame-entry', title: `Fill ${entry.name}` }, avatar, meta) as HTMLButtonElement;
    button.disabled = !entry.fillable;
    button.addEventListener('click', () => {
      if (!clickCounts()) return;
      button.disabled = true;
      void ask<{ ok: boolean; message?: string }>({ kind: 'helm-menu-fill', key: entry.key }).then((result) => {
        button.disabled = false;
        if (!result?.ok) body.prepend(note(result?.message ?? 'Helm could not fill this page.', 'error'));
      });
    });
    list.append(el('li', {}, button));
  }
  body.replaceChildren(list);
}

/** Tell the page how tall this frame needs to be. */
function fit(): void {
  void ask({ kind: 'helm-menu-size', height: Math.ceil(document.body.getBoundingClientRect().height) });
}
new ResizeObserver(fit).observe(document.body);

addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void ask({ kind: 'helm-menu-dismiss' });
});
void render().then(fit);
