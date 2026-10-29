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
 *
 * Any row can be renamed (1180). A removed or lapsed row can be cleared off
 * the list, one at a time or all together; a live one has to be removed
 * first, so clearing never hides a browser that still works.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Pencil, Trash2, X } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/field';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from './ui/table';
import { apiFetch } from '@/lib/ui/api';
import { formatDateTime } from '@/lib/ui/format';
import type { PairedBrowserRow } from '@/lib/extension/pairing';

export function PairedBrowsersCard({ browsers }: { browsers: PairedBrowserRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);

  const inactive = browsers.filter((b) => !b.live);

  async function run(key: string, call: () => ReturnType<typeof apiFetch>, after?: () => void) {
    setBusy(key);
    setError(null);
    try {
      const result = await call();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      after?.();
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const remove = (id: string) => run(id, () => apiFetch(`/api/extension/installs/${id}`, { method: 'DELETE' }));

  const clear = (id: string | null) =>
    run(id ?? 'all', () => apiFetch('/api/extension/installs/clear', { json: id ? { id } : {} }));

  const rename = () => {
    if (!editing) return;
    const { id, label } = editing;
    if (label.trim() === '') return;
    void run(
      id,
      () => apiFetch(`/api/extension/installs/${id}`, { method: 'PATCH', json: { label: label.trim() } }),
      () => setEditing(null),
    );
  };

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-ink-muted">
        The Helm extension for Chrome, Edge and Brave looks up the credentials for the site you are on
        and copies standard passwords and one-time codes, each copy audited. Pair a browser from the
        extension&rsquo;s settings. A pairing lapses after 30 days without use.
      </p>

      {inactive.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
          <span>
            {inactive.length === 1 ? '1 browser is' : `${inactive.length} browsers are`} removed or lapsed. They
            no longer work and drop off by themselves after 30 days.
          </span>
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => clear(null)}>
            {busy === 'all' ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <X className="size-3.5" aria-hidden />}
            Clear {inactive.length === 1 ? 'it' : 'all'} from the list
          </Button>
        </div>
      )}

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
                {editing?.id === b.id ? (
                  <form
                    className="flex items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      rename();
                    }}
                  >
                    <Input
                      aria-label="Browser name"
                      className="h-8 w-48"
                      value={editing.label}
                      maxLength={80}
                      autoFocus
                      disabled={busy !== null}
                      onChange={(e) => setEditing({ id: b.id, label: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null || editing.label.trim() === ''}
                      aria-label="Save name"
                    >
                      {busy === b.id ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Check className="size-3.5" aria-hidden />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => setEditing(null)}
                      aria-label="Cancel renaming"
                    >
                      <X className="size-3.5" aria-hidden />
                    </Button>
                  </form>
                ) : (
                  <div className="flex items-center gap-1">
                    <span className="font-medium text-ink">{b.label}</span>
                    <button
                      type="button"
                      className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink"
                      disabled={busy !== null}
                      onClick={() => setEditing({ id: b.id, label: b.label })}
                      aria-label={`Rename ${b.label}`}
                      title="Rename"
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </button>
                  </div>
                )}
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
                {!b.live && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => clear(b.id)}
                    aria-label={`Clear ${b.label} from the list`}
                  >
                    {busy === b.id ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <X className="size-3.5" aria-hidden />
                    )}
                    Clear
                  </Button>
                )}
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
