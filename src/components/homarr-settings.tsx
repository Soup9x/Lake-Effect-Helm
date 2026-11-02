'use client';

/**
 * Homarr (1240): links that put a read-only Helm status page on a Homarr
 * board, through Homarr's iFrame widget.
 *
 * The link is the credential, so it is shown once, when it is made, and only
 * its prefix afterwards. Each link names the Homarr addresses allowed to show
 * it, and whether the page may name clients and what is expiring or only
 * count them.
 */
import { useState, type FormEvent } from 'react';
import { Check, Copy, LayoutDashboard, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { Badge } from './ui/badge';
import { Modal } from './ui/modal';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from './ui/table';
import { formatDateTime } from '@/lib/ui/format';
import { apiFetch, type Feedback } from '@/lib/ui/api';
import { copyFailureMessage, copyUnaudited } from '@/lib/ui/clipboard';
import type { BoardLinkRow } from '@/lib/homarr/board';

interface Draft {
  name: string;
  origins: string;
  showDetails: boolean;
}

const BLANK: Draft = { name: 'Homarr', origins: '', showDetails: false };

export function HomarrSettingsCard({ initial, canManage }: { initial: BoardLinkRow[]; canManage: boolean }) {
  const [links, setLinks] = useState(initial);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ token: string; name: string } | null>(null);
  const [theme, setTheme] = useState<'auto' | 'dark' | 'light'>('dark');
  const [transparent, setTransparent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<Feedback>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const live = links.filter((l) => !l.revokedAt);

  function openNew() {
    setDraft(BLANK);
    setError(null);
    setMade(null);
    setCopied(false);
    setOpen(true);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const origins = draft.origins.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
      const result = await apiFetch<{ token: string; links: BoardLinkRow[] }>('/api/integrations/homarr', {
        method: 'POST',
        json: { name: draft.name.trim(), allowedOrigins: origins, showDetails: draft.showDetails },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setLinks(result.value.links);
      setMade({ token: result.value.token, name: draft.name.trim() });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(link: BoardLinkRow) {
    if (!window.confirm(`Revoke ${link.name}? The Homarr widget using it stops showing Helm straight away.`)) return;
    setRowBusy(link.id);
    try {
      const result = await apiFetch<{ links: BoardLinkRow[] }>(`/api/integrations/homarr/${link.id}`, { method: 'DELETE' });
      if (!result.ok) {
        setNotice({ ok: false, message: result.message });
        return;
      }
      setLinks(result.value.links);
      setNotice({ ok: true, message: `${link.name} revoked.` });
    } finally {
      setRowBusy(null);
    }
  }

  const url = made ? boardUrl(made.token, theme, transparent) : '';

  async function copy() {
    const outcome = await copyUnaudited(url);
    setCopied(outcome === 'copied');
    setError(copyFailureMessage(outcome));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LayoutDashboard className="size-4 text-ink-faint" aria-hidden /> Homarr
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-3xl text-sm text-ink-muted">
            Shows a small Helm status page on a Homarr board: what has expired or is about to, how many clients and
            devices there are, and whether each integration is syncing. Add it to a board with Homarr&rsquo;s iFrame
            widget. The page is read-only, never shows a password or a note, and only the Homarr addresses you list
            can show it.
          </p>
          {canManage && (
            <Button variant="secondary" size="sm" onClick={openNew}>
              <Plus className="size-4" aria-hidden /> Make a board link
            </Button>
          )}
        </div>

        {notice && (
          <p role={notice.ok ? undefined : 'alert'} className={notice.ok ? 'text-sm text-ok' : 'text-sm text-danger'}>
            {notice.message}
          </p>
        )}

        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Link</TableHead>
              <TableHead>Homarr addresses</TableHead>
              <TableHead>Shows</TableHead>
              <TableHead>Last opened</TableHead>
              {canManage && <TableHead className="sr-only">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {links.length === 0 && (
              <TableEmpty colSpan={canManage ? 5 : 4}>No board links yet.</TableEmpty>
            )}
            {links.map((l) => (
              <TableRow key={l.id} className={l.revokedAt ? 'opacity-60' : undefined}>
                <TableCell>
                  <span className="font-medium">{l.name}</span>
                  {l.revokedAt && <Badge tone="neutral" className="ml-2">Revoked</Badge>}
                  <span className="block font-mono text-xs text-ink-faint">{l.prefix}…</span>
                </TableCell>
                <TableCell className="text-ink-muted">
                  {l.allowedOrigins.map((o) => <span key={o} className="block text-xs">{o}</span>)}
                </TableCell>
                <TableCell className="text-ink-muted">{l.showDetails ? 'Names and counts' : 'Counts only'}</TableCell>
                <TableCell className="text-ink-muted">
                  {l.lastUsedAt ? formatDateTime(l.lastUsedAt) : 'Not yet'}
                  {l.useCount > 0 && <span className="block text-xs text-ink-faint">{l.useCount === 1 ? 'once' : `${l.useCount} times`}</span>}
                </TableCell>
                {canManage && (
                  <TableCell>
                    {!l.revokedAt && (
                      <div className="flex justify-end">
                        <Button variant="ghost" size="sm" onClick={() => revoke(l)} disabled={rowBusy === l.id}
                          aria-label={`Revoke ${l.name}`}>
                          {rowBusy === l.id ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                        </Button>
                      </div>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {!canManage && <p className="text-xs text-ink-faint">Making board links requires tenant settings access.</p>}
        {canManage && live.length > 0 && (
          <p className="text-xs text-ink-faint">
            A link is only shown when it is made. If you lose one, revoke it and make another.
          </p>
        )}

        <Modal open={open} onOpenChange={setOpen} icon={LayoutDashboard} size="lg"
          title={made ? `${made.name}: your board link` : 'Make a Homarr board link'}>
          {!made ? (
            <form onSubmit={create} className="space-y-4">
              <div>
                <Label htmlFor="homarr-name">Name</Label>
                <Input id="homarr-name" required maxLength={120} value={draft.name}
                  onChange={(e) => set('name', e.target.value)} />
                <FieldHint>So you can tell links apart, for example the board it is on.</FieldHint>
              </div>
              <div>
                <Label htmlFor="homarr-origins">Homarr addresses</Label>
                <Textarea id="homarr-origins" required rows={3} autoComplete="off"
                  placeholder={'http://192.168.1.20:7575\nhttps://homarr.example.com'}
                  value={draft.origins} onChange={(e) => set('origins', e.target.value)} />
                <FieldHint>
                  Each address you open Homarr on, one per line. Only these can show the page; anywhere else the
                  browser refuses to load it.
                </FieldHint>
              </div>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input type="checkbox" checked={draft.showDetails}
                  onChange={(e) => set('showDetails', e.target.checked)}
                  className="mt-0.5 size-4 rounded border-border-strong" />
                <span>
                  Show client names and what is expiring
                  <span className="block text-xs text-ink-muted">
                    Off, the page shows only counts and integration health. Anyone who can see the Homarr board can
                    see this page, so leave it off if the board is public.
                  </span>
                </span>
              </label>
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" variant="primary" size="sm" disabled={busy}>
                  {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Make link
                </Button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-ink-muted">
                Copy this now. Helm keeps only a fingerprint of it, so it cannot be shown again.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="homarr-theme">Colours</Label>
                  <Select id="homarr-theme" value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
                    <option value="dark">Dark (Homarr&rsquo;s default)</option>
                    <option value="light">Light</option>
                    <option value="auto">Follow the device</option>
                  </Select>
                </div>
                <label className="flex items-center gap-2 pt-6 text-sm text-ink">
                  <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)}
                    className="size-4 rounded border-border-strong" />
                  Transparent background
                </label>
              </div>
              <div className="flex gap-2">
                <Input readOnly value={url} className="min-w-0 flex-1 font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()} aria-label="Board link" />
                <Button type="button" variant="primary" size="sm" onClick={copy}>
                  {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
              <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-muted">
                <li>In Homarr, open the board and choose <b>Edit mode</b>.</li>
                <li>Add an item, pick <b>iFrame</b>, and paste the link as its URL.</li>
                <li>Make it about 4 columns wide and 3 tall, then save the board.</li>
              </ol>
              <div className="flex justify-end">
                <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>Done</Button>
              </div>
            </div>
          )}
        </Modal>
      </CardContent>
    </Card>
  );
}

function boardUrl(token: string, theme: string, transparent: boolean): string {
  const query = new URLSearchParams();
  if (theme !== 'auto') query.set('theme', theme);
  if (transparent) query.set('transparent', '1');
  const q = query.toString();
  return `${window.location.origin}/embed/homarr/${token}${q ? `?${q}` : ''}`;
}
