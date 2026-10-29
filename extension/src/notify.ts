/**
 * The prompt after a sign-in: "Save this login to Helm?" for one Helm does
 * not have, "Update the password in Helm?" for one it has with another
 * password. content.ts draws this frame at the top of the page; inpage.ts
 * holds what was typed. This page never sees the password: it asks the
 * background to save or update, by the token in its address.
 */
import type { BarView } from './inpage';
import { clickCounts } from './guard';
import { destinationPicker } from './picker';
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

/** Tell the page how tall this frame needs to be. */
function fit(): void {
  void ask({ kind: 'helm-bar-size', height: Math.ceil(document.body.getBoundingClientRect().height) });
}
new ResizeObserver(fit).observe(document.body);

function dismiss(never = false): void {
  void ask({ kind: 'helm-bar-dismiss', never });
}
document.getElementById('close')!.addEventListener('click', () => dismiss());
addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dismiss();
});

function button(label: string, onClick: () => void, variant = ''): HTMLButtonElement {
  const node = el('button', { type: 'button', ...(variant ? { class: variant } : {}) }, label) as HTMLButtonElement;
  node.addEventListener('click', () => {
    if (clickCounts()) onClick();
  });
  return node;
}

function done(message: string): void {
  body.replaceChildren(el('p', { class: 'frame-note ok' }, message));
  setTimeout(() => dismiss(), 1800);
}

function failed(message: string, retry: HTMLButtonElement): void {
  retry.disabled = false;
  body.querySelector('.frame-note.error')?.remove();
  body.prepend(el('p', { class: 'frame-note error' }, message));
}

async function render(): Promise<void> {
  const view = await ask<BarView>({ kind: 'helm-bar-view' });
  if (!view) {
    dismiss();
    return;
  }
  const who = el('p', { class: 'frame-who' },
    el('strong', {}, view.username || 'No username'), el('span', { class: 'muted' }, ` on ${view.host}`));

  if (view.mode === 'changed' && view.entry) {
    title.textContent = 'Update the password in Helm?';
    const update = button('Update', () => {
      update.disabled = true;
      void ask<{ ok: boolean; message?: string }>({ kind: 'helm-bar-update' }).then((r) => {
        if (r?.ok) done(`Updated ${view.entry!.name} in Helm.`);
        else failed(r?.message ?? 'Helm did not take the update.', update);
      });
    }, 'primary');
    body.replaceChildren(
      who,
      el('p', { class: 'frame-note' }, `You signed in with a different password than Helm has for ${view.entry.name} (${view.entry.where}).`),
      el('div', { class: 'frame-actions' }, update, button('Not now', () => dismiss())),
    );
    return;
  }

  title.textContent = 'Save this login to Helm?';
  if (!view.destinations.canSave) {
    body.replaceChildren(
      who,
      el('p', { class: 'frame-note' }, 'This browser was paired before Helm could save logins from it. Pair it again in the extension’s settings to save from here.'),
      el('div', { class: 'frame-actions' }, button('Not now', () => dismiss()), button('Never for this site', () => dismiss(true))),
    );
    return;
  }
  const name = el('input', { id: 'bar-name', type: 'text', maxlength: '200', autocomplete: 'off' }) as HTMLInputElement;
  name.value = view.suggestedName;
  const picker = destinationPicker(view.destinations, 'bar');
  const save = button('Save', () => {
    if (!name.value.trim()) {
      name.focus();
      return;
    }
    save.disabled = true;
    const picked = picker.value();
    void ask<{ ok: boolean; message?: string }>({
      kind: 'helm-bar-save', request: { destination: picked.destination, name: name.value.trim(), tags: picked.tags },
    }).then((r) => {
      if (r?.ok) done('Saved to Helm.');
      else failed(r?.message ?? 'Helm did not save it.', save);
    });
  }, 'primary');
  body.replaceChildren(
    who,
    el('div', { class: 'field' }, el('label', { for: name.id }, 'Name'), name),
    picker.element,
    el('div', { class: 'frame-actions' }, save, button('Not now', () => dismiss()), button('Never for this site', () => dismiss(true), 'link')),
  );
}

void render().then(fit);
