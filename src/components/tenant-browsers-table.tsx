'use client';

/**
 * Administration → Browser extensions: every browser paired in the tenant,
 * whose it is, when it was last used, and Revoke.
 *
 * The same columns as a person's own list (paired-browsers-card.tsx) with the
 * person added, so a fingerprint somebody reads out from their extension can
 * be found here. Revoke asks once, because unlike Remove on your own list it
 * acts on somebody else, who will find their extension signed out.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from './ui/table';
import { apiFetch } from '@/lib/ui/api';
import { formatDateTime } from '@/lib/ui/format';
import type { TenantBrowserRow } from '@/lib/extension/pairing';

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

  const live = browsers.filter((b) => b.live).length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">
        {live === 1 ? '1 browser is' : `${live} browsers are`} paired now. Removed and lapsed pairings
        stay listed for 30 days.
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
        </TableHeader>
        <TableBody>
          {browsers.length === 0 && <TableEmpty colSpan={6}>Nobody has paired a browser yet.</TableEmpty>}
          {browsers.map((b) => (
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
