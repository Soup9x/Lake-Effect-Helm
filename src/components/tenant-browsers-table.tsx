'use client';

/**
 * Administration → Browser extensions: every browser paired in the tenant,
 * whose it is, when it was last used, and Revoke.
 *
 * The same columns as a person's own list (paired-browsers-card.tsx) with the
 * person added, so a fingerprint somebody reads out from their extension can
 * be found here. Revoke asks once, because unlike Remove on your own list it
 * acts on somebody else, who will find their extension signed out.
 *
 * Each column filters, in the browser: a tenant has tens of pairings, not
 * thousands, and the page already holds every one of them.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Loader2, X } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input, Select } from './ui/field';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from './ui/table';
import { apiFetch } from '@/lib/ui/api';
import { formatDateTime } from '@/lib/ui/format';
import type { TenantBrowserRow } from '@/lib/extension/pairing';

const DAY = 24 * 60 * 60 * 1000;

const STATES = [
  { value: '', label: 'Any state' },
  { value: 'live', label: 'Paired now' },
  { value: 'removed', label: 'Removed' },
  { value: 'lapsed', label: 'Lapsed' },
] as const;

const USED = [
  { value: '', label: 'Any time' },
  { value: '1', label: 'In the last day' },
  { value: '7', label: 'In the last 7 days' },
  { value: '30', label: 'In the last 30 days' },
  { value: 'stale7', label: 'Not in 7 days' },
  { value: 'never', label: 'Never' },
] as const;

interface Filters {
  person: string;
  browser: string;
  fingerprint: string;
  state: string;
  used: string;
}

const NO_FILTERS: Filters = { person: '', browser: '', fingerprint: '', state: '', used: '' };

const stateOf = (b: TenantBrowserRow) => (b.revokedAt ? 'removed' : b.live ? 'live' : 'lapsed');

/** Fingerprints are read out loud and typed with or without their spaces. */
const bare = (text: string) => text.replace(/\s+/g, '').toUpperCase();

function matches(b: TenantBrowserRow, f: Filters, now: number): boolean {
  if (f.person && b.userId !== f.person) return false;
  if (f.browser && b.label !== f.browser) return false;
  if (f.fingerprint && !bare(b.fingerprint).includes(bare(f.fingerprint))) return false;
  if (f.state && stateOf(b) !== f.state) return false;
  if (f.used) {
    const used = b.lastUsedAt ? now - new Date(b.lastUsedAt).getTime() : null;
    if (f.used === 'never') return used === null;
    if (f.used === 'stale7') return used === null || used > 7 * DAY;
    if (used === null || used > Number(f.used) * DAY) return false;
  }
  return true;
}

export function TenantBrowsersTable({ browsers }: { browsers: TenantBrowserRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revoke(id: string) {
    setBusy(id);
    setError(null);
    try {
      const result = await apiFetch(`/api/extension/admin/installs/${id}`, { method: 'DELETE' });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setConfirming(null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const set = (key: keyof Filters) => (value: string) => setFilters((f) => ({ ...f, [key]: value }));
  const filtering = Object.values(filters).some((v) => v !== '');

  const people = useMemo(() => {
    const byId = new Map(browsers.map((b) => [b.userId, b.userName || b.userEmail]));
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [browsers]);
  const labels = useMemo(() => [...new Set(browsers.map((b) => b.label))].sort(), [browsers]);
  const shown = useMemo(() => {
    const now = Date.now();
    return browsers.filter((b) => matches(b, filters, now));
  }, [browsers, filters]);

  const live = browsers.filter((b) => b.live).length;
  const field = 'h-7 w-full min-w-[8rem] py-0 text-xs font-normal normal-case tracking-normal';

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">
        {live === 1 ? '1 browser is' : `${live} browsers are`} paired now. Removed and lapsed pairings
        stay listed for 30 days.
        {filtering && (
          <>
            {' '}Showing {shown.length} of {browsers.length}.{' '}
            <button type="button" className="inline-flex items-center gap-1 text-brand hover:underline"
              onClick={() => setFilters(NO_FILTERS)}>
              <X className="size-3" aria-hidden /> Clear filters
            </button>
          </>
        )}
      </p>

      {error && <p className="text-sm text-danger">{error}</p>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead>Browser</TableHead>
            <TableHead>Fingerprint</TableHead>
            <TableHead>Paired</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
          {browsers.length > 0 && (
            <TableRow className="hover:bg-transparent">
              <TableHead className="py-1.5">
                <Select aria-label="Filter by person" className={field} value={filters.person}
                  onChange={(e) => set('person')(e.target.value)}>
                  <option value="">Everybody</option>
                  {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </Select>
              </TableHead>
              <TableHead className="py-1.5">
                <Select aria-label="Filter by browser" className={field} value={filters.browser}
                  onChange={(e) => set('browser')(e.target.value)}>
                  <option value="">Every browser</option>
                  {labels.map((l) => <option key={l} value={l}>{l}</option>)}
                </Select>
              </TableHead>
              <TableHead className="py-1.5">
                <Input aria-label="Filter by fingerprint" className={field} placeholder="Fingerprint contains"
                  value={filters.fingerprint} onChange={(e) => set('fingerprint')(e.target.value)} />
              </TableHead>
              <TableHead className="py-1.5">
                <Select aria-label="Filter by state" className={field} value={filters.state}
                  onChange={(e) => set('state')(e.target.value)}>
                  {STATES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </TableHead>
              <TableHead className="py-1.5">
                <Select aria-label="Filter by last use" className={field} value={filters.used}
                  onChange={(e) => set('used')(e.target.value)}>
                  {USED.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </TableHead>
              <TableHead />
            </TableRow>
          )}
        </TableHeader>
        <TableBody>
          {browsers.length === 0 && <TableEmpty colSpan={6}>Nobody has paired a browser yet.</TableEmpty>}
          {browsers.length > 0 && shown.length === 0 && (
            <TableEmpty colSpan={6}>No paired browser matches these filters.</TableEmpty>
          )}
          {shown.map((b) => (
            <TableRow key={b.id} className={b.live ? undefined : 'opacity-60'}>
              <TableCell>
                <div className="font-medium text-ink">{b.userName || b.userEmail}</div>
                <div className="text-xs text-ink-faint">{b.userEmail}</div>
              </TableCell>
              <TableCell>
                <div className="text-ink">{b.label}</div>
                {b.browser && (
                  <div className="text-xs text-ink-faint">
                    {b.browser}
                    {b.extensionVersion ? `, extension ${b.extensionVersion}` : ''}
                  </div>
                )}
              </TableCell>
              <TableCell className="font-mono text-xs">{b.fingerprint}</TableCell>
              <TableCell className="text-xs">
                {formatDateTime(b.pairedAt)}
                {b.revokedAt ? (
                  <div><Badge tone="expired">removed {formatDateTime(b.revokedAt)}</Badge></div>
                ) : !b.live ? (
                  <div><Badge tone="expired">lapsed</Badge></div>
                ) : null}
              </TableCell>
              <TableCell className="text-xs text-ink-muted">
                {b.lastUsedAt
                  ? `${formatDateTime(b.lastUsedAt)}${b.lastUsedIp ? ` from ${b.lastUsedIp}` : ''}`
                  : 'never'}
              </TableCell>
              <TableCell className="whitespace-nowrap text-right">
                {b.live && confirming !== b.id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => setConfirming(b.id)}
                    aria-label={`Revoke ${b.userName || b.userEmail}'s ${b.label}`}
                  >
                    <Ban className="size-3.5" aria-hidden /> Revoke
                  </Button>
                )}
                {b.live && confirming === b.id && (
                  <span className="inline-flex gap-1">
                    <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => revoke(b.id)}>
                      {busy === b.id && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                      Revoke now
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
