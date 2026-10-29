/**
 * Where a login goes: the person's own vault, or a client and, optionally,
 * one of its sites; and its tags, which stand in for folders (Helm has none,
 * and the password import maps a folder to a tag the same way). Used by the
 * save prompt (notify.ts) and the popup's add form.
 */
import type { ExtensionDestinations } from '../../src/lib/extension/types';

export interface Picked {
  destination: { kind: 'personal' } | { kind: 'client'; organizationId: string; siteId: string | null };
  tags: string[];
}

function el(tag: string, attrs: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

const LAST = 'lastDestination';

export function destinationPicker(destinations: ExtensionDestinations, idPrefix: string): {
  element: HTMLElement;
  value: () => Picked;
} {
  const where = el('select', { id: `${idPrefix}-where` }) as HTMLSelectElement;
  where.append(el('option', { value: 'personal' }, 'My passwords'));
  if (destinations.organizations.length) {
    const group = el('optgroup', { label: 'Clients' });
    for (const org of destinations.organizations) group.append(el('option', { value: org.id }, org.name));
    where.append(group);
  }
  const site = el('select', { id: `${idPrefix}-site` }) as HTMLSelectElement;
  const siteRow = el('div', { class: 'field' }, el('label', { for: site.id }, 'Location'), site);
  const tags = el('input', {
    id: `${idPrefix}-tags`, type: 'text', placeholder: 'e.g. vendor portals, m365', autocomplete: 'off', spellcheck: 'false',
  }) as HTMLInputElement;

  const drawSites = () => {
    const org = destinations.organizations.find((o) => o.id === where.value);
    site.replaceChildren(el('option', { value: '' }, 'No particular location'),
      ...(org?.sites ?? []).map((s) => el('option', { value: s.id }, s.name)));
    siteRow.hidden = !org || org.sites.length === 0;
  };
  // The last place chosen, as Bitwarden remembers the last folder.
  void chrome.storage.local.get(LAST).then(({ [LAST]: last }) => {
    if (typeof last === 'string' && (last === 'personal' || destinations.organizations.some((o) => o.id === last))) {
      where.value = last;
      drawSites();
    }
  });
  where.addEventListener('change', () => {
    drawSites();
    void chrome.storage.local.set({ [LAST]: where.value });
  });
  drawSites();

  const element = el('div', { class: 'picker' },
    el('div', { class: 'field' }, el('label', { for: where.id }, 'Save to'), where),
    siteRow,
    el('div', { class: 'field' }, el('label', { for: tags.id }, 'Tags (comma between them)'), tags),
  );
  return {
    element,
    value: () => ({
      destination: where.value === 'personal'
        ? { kind: 'personal' }
        : { kind: 'client', organizationId: where.value, siteId: site.value || null },
      tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20),
    }),
  };
}
