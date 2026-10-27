'use client';

/**
 * Your browsers paired with the Helm extension, and taking one away.
 *
 * Pairing starts in the extension, not here: it makes the device key, and the
 * page it opens is where you approve it (src/components/extension-pair.tsx).
 * This card is the other end — what is paired, when it was last used and from
 * where, and Remove, which is immediate for the same reason a token's revoke
 * is: the extension's next request is refused, and pairing again is one click.
 *
 * The fingerprint is the one the pairing page showed, so a browser you do not
 * recognise can be told apart from one you do.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from './ui/table';
import { apiFetch } from '@/lib/ui/api';
import { formatDateTime } from '@/lib/ui/format';
import type { PairedBrowserRow } from '@/lib/extension/pairing';

export function PairedBrowsersCard({ browsers }: { browsers: PairedBrowserRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    try {
      const result = await apiFetch(`/api/extension/installs/${id}`, { method: 'DELETE' });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-ink-muted">
        The Helm extension for Chrome, Edge and Brave looks up the credentials for the site you are on
        and copies standard passwords and one-time codes, each copy audited. Pair a browser from the
        extension&rsquo;s settings. A pairing lapses after 30 days without use.
      </p>

      {error && <p className="text-sm text-danger">{error}</p>}

      <Table>
        <TableHeader>
          <TableRow>
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
          {browsers.length === 0 && (
            <TableEmpty colSpan={5}>No paired browsers.</TableEmpty>
          )}
          {browsers.map((b) => (
            <TableRow key={b.id} className={b.live ? undefined : 'opacity-60'}>
              <TableCell>
                <div className="font-medium text-ink">{b.label}</div>
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
              <TableCell className="text-right">
                {b.live && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => remove(b.id)}
                    aria-label={`Remove ${b.label}`}
                  >
                    {busy === b.id ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Trash2 className="size-3.5" aria-hidden />
                    )}
                    Remove
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
