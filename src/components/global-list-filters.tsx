'use client';

/**
 * The view filters above a Global list: client, location, type, status and
 * whether the client can see it. Each writes the URL, so a filtered view is a
 * link somebody can paste into a ticket, and the server does the narrowing —
 * a list across every client is too long to send whole and filter here.
 *
 * Text and "Include archived" are the grid's own toolbar, as on a client's
 * category pages.
 */
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';
import { Select } from './ui/field';

interface Option { value: string; label: string }

export interface GlobalListFiltersProps {
  clients: readonly { id: string; name: string }[];
  sites: readonly { id: string; name: string }[];
  types: readonly Option[];
  typeLabel: string;
  statuses: readonly string[];
}

const VIEWS: readonly Option[] = [
  { value: '', label: 'Shared and internal' },
  { value: 'shared', label: 'Shared with client' },
  { value: 'internal', label: 'Internal only' },
];

const KEYS = ['client', 'site', 'type', 'status', 'view'] as const;

export function GlobalListFilters({ clients, sites, types, typeLabel, statuses }: GlobalListFiltersProps) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const params = useSearchParams();
  const value = (key: string) => params?.get(key) ?? '';

  const set = (key: (typeof KEYS)[number], next: string) => {
    const query = new URLSearchParams(params?.toString() ?? '');
    if (next) query.set(key, next);
    else query.delete(key);
    // A location belongs to one client; changing the client forgets it.
    if (key === 'client') query.delete('site');
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  };

  const active = KEYS.some((k) => value(k) !== '');
  const clear = () => {
    const query = new URLSearchParams(params?.toString() ?? '');
    for (const k of KEYS) query.delete(k);
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  };

  const field = 'h-8 w-auto min-w-[10rem] py-0 text-sm';

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-canvas-border px-6 py-2.5">
      <Select aria-label="Client" className={field} value={value('client')} onChange={(e) => set('client', e.target.value)}>
        <option value="">All clients</option>
        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
      <Select aria-label="Location" className={field} value={value('site')} onChange={(e) => set('site', e.target.value)}
        disabled={!value('client')} title={value('client') ? undefined : 'Choose a client to filter by location'}>
        <option value="">All locations</option>
        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </Select>
      <Select aria-label={typeLabel} className={field} value={value('type')} onChange={(e) => set('type', e.target.value)}>
        <option value="">Every {typeLabel.toLowerCase()}</option>
        {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </Select>
      <Select aria-label="Status" className={field} value={value('status')} onChange={(e) => set('status', e.target.value)}>
        <option value="">Any status</option>
        {statuses.map((s) => <option key={s} value={s} className="capitalize">{s}</option>)}
      </Select>
      <Select aria-label="Visibility" className={field} value={value('view')} onChange={(e) => set('view', e.target.value)}>
        {VIEWS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
      </Select>
      {active && (
        <button type="button" onClick={clear}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink">
          <X className="size-3.5" aria-hidden /> Clear filters
        </button>
      )}
    </div>
  );
}
