'use client';

/**
 * Your personal API tokens: the ones you hold, one you can issue, and the one
 * chance you get to copy it.
 *
 * SHOWN ONCE, AND THE CARD SAYS SO. The token exists in the POST response and
 * nowhere else — the row holds a hash. So the value is rendered in a box with a
 * copy button and a sentence saying it will not be shown again, and it is
 * cleared from this component's state when the dialog closes. Keeping it around
 * "in case" would leave a bearer credential in a React tree on an unlocked
 * screen, which is the exposure the reveal button's auto-hide exists to prevent.
 *
 * SCOPES ARE OFFERED FROM WHAT YOU HOLD. The list of checkboxes is the
 * permission set the database resolved for this session, so the form cannot
 * offer a scope the route would refuse. "Everything my role allows" is the
 * default because that is what most people mean, and it is spelled out that a
 * token can only narrow.
 *
 * REVOKING IS IMMEDIATE and needs no confirmation dialog: the next request the
 * token makes is refused, and a token revoked by mistake costs one more issue.
 * A dialog that asks "are you sure" before a reversible, low-cost act teaches
 * people to click through dialogs.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { FieldHint, Input, Label, Select } from './ui/field';
import { Modal } from './ui/modal';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from './ui/table';
import { apiFetch } from '@/lib/ui/api';
import { copyFailureMessage, copyUnaudited } from '@/lib/ui/clipboard';
import { formatDateTime } from '@/lib/ui/format';
import type { PersonalTokenRow } from '@/lib/auth/api-tokens';

interface Issued {
  token: string;
  prefix: string;
  expiresAt: string;
}

const EXPIRY_CHOICES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '180 days' },
  { days: 365, label: 'A year (the most allowed)' },
] as const;

export function ApiTokensCard({
  tokens,
  permissions,
}: {
  tokens: PersonalTokenRow[];
  /** What this session holds, as the database resolved it. The scope menu. */
  permissions: readonly string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState<number>(90);
  const [everything, setEverything] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const live = tokens.filter((t) => t.live);
  const past = tokens.filter((t) => !t.live);

  function openWith(next: boolean) {
    if (next) {
      setName('');
      setDays(90);
      setEverything(true);
      setChosen([]);
      setError(null);
    }
    // Closing is where the token leaves memory, whichever way the dialog went.
    if (!next) {
      setIssued(null);
      setCopied(null);
    }
    setOpen(next);
  }

  function toggle(permission: string) {
    setChosen((current) =>
      current.includes(permission) ? current.filter((p) => p !== permission) : [...current, permission],
    );
  }

  async function issue(event: FormEvent) {
    event.preventDefault();
    const scopes = everything ? ['*'] : chosen;
    if (scopes.length === 0) {
      setError('Choose at least one permission, or let the token carry everything your role allows.');
      return;
    }
    setBusy('issue');
    setError(null);
    try {
      const result = await apiFetch<Issued>('/api/account/tokens', {
        json: { name: name.trim(), scopes, expiresInDays: days },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setIssued(result.value);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function copy(token: string) {
    const outcome = await copyUnaudited(token);
    setCopied(outcome === 'copied' ? 'Copied.' : copyFailureMessage(outcome));
  }

  async function revoke(id: string) {
    setBusy(id);
    setError(null);
    try {
      const result = await apiFetch(`/api/account/tokens/${id}`, { method: 'DELETE' });
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
      <p className="text-sm text-ink-muted">
        A token lets a script or a tool act as you, with at most the permissions you hold now. Send it
        as <code className="font-mono text-xs">Authorization: Bearer …</code>. It expires on its own and
        can be revoked here at any time.
      </p>

      {error && !open && <p className="text-sm text-danger">{error}</p>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Prefix</TableHead>
            <TableHead>Scopes</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {live.length === 0 && past.length === 0 && (
            <TableEmpty colSpan={6}>No personal tokens. Issue one to call the API from a script.</TableEmpty>
          )}
          {[...live, ...past].map((token) => (
            <TableRow key={token.id} className={token.live ? undefined : 'opacity-60'}>
              <TableCell className="font-medium text-ink">{token.name}</TableCell>
              <TableCell className="font-mono text-xs">{token.prefix}</TableCell>
              <TableCell className="text-xs">
                {token.scopes.includes('*') ? (
                  <Badge tone="neutral">everything the role allows</Badge>
                ) : (
                  <span className="font-mono">{token.scopes.join(' ')}</span>
                )}
              </TableCell>
              <TableCell className="text-xs">
                {token.revokedAt ? (
                  <Badge tone="expired">revoked {formatDateTime(token.revokedAt)}</Badge>
                ) : token.live ? (
                  formatDateTime(token.expiresAt)
                ) : (
                  <Badge tone="expired">expired {formatDateTime(token.expiresAt)}</Badge>
                )}
              </TableCell>
              <TableCell className="text-xs text-ink-muted">
                {token.lastUsedAt
                  ? `${formatDateTime(token.lastUsedAt)}${token.lastUsedIp ? ` from ${token.lastUsedIp}` : ''}`
                  : 'never'}
              </TableCell>
              <TableCell className="text-right">
                {token.live && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => revoke(token.id)}
                    aria-label={`Revoke ${token.name}`}
                  >
                    {busy === token.id ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Trash2 className="size-3.5" aria-hidden />
                    )}
                    Revoke
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Button variant="secondary" size="sm" onClick={() => openWith(true)}>
        <Plus className="size-3.5" aria-hidden /> Issue a token
      </Button>

      <Modal
        open={open}
        onOpenChange={openWith}
        title={issued ? 'Your new token' : 'Issue a personal token'}
        description={
          issued
            ? 'Copy it now. It is shown once and cannot be recovered; issue another if you lose it.'
            : 'It acts as you, with at most the permissions you hold, until it expires or you revoke it.'
        }
        icon={KeyRound}
      >
        {issued ? (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-surface-sunken p-3">
              <code className="block break-all font-mono text-sm text-ink">{issued.token}</code>
            </div>
            <div className="flex items-center gap-3">
              <Button type="button" size="sm" onClick={() => copy(issued.token)}>
                {copied === 'Copied.' ? (
                  <Check className="size-3.5" aria-hidden />
                ) : (
                  <Copy className="size-3.5" aria-hidden />
                )}
                Copy token
              </Button>
              {copied && (
                <span className={copied === 'Copied.' ? 'text-sm text-ok' : 'text-sm text-danger'}>{copied}</span>
              )}
            </div>
            <FieldHint>
              Prefix <span className="font-mono">{issued.prefix}</span>, expires {formatDateTime(issued.expiresAt)}.
              If this token ever turns up somewhere it should not, revoke it by that prefix.
            </FieldHint>
            <div className="flex justify-end">
              <Button type="button" variant="secondary" onClick={() => openWith(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={issue} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="token-name">Name</Label>
              <Input
                id="token-name"
                value={name}
                maxLength={80}
                required
                placeholder="Backup script on nas01"
                onChange={(event) => setName(event.target.value)}
              />
              <FieldHint>What this token is for and where it lives, so you recognise it later.</FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="token-days">Expires in</Label>
              <Select id="token-days" value={String(days)} onChange={(event) => setDays(Number(event.target.value))}>
                {EXPIRY_CHOICES.map((choice) => (
                  <option key={choice.days} value={choice.days}>
                    {choice.label}
                  </option>
                ))}
              </Select>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink">Permissions</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  className="mt-0.5"
                  name="token-scope"
                  checked={everything}
                  onChange={() => setEverything(true)}
                />
                <span>
                  <span className="text-ink">Everything my role allows</span>
                  <span className="block text-xs text-ink-muted">
                    The token can do what you can do now. If your role is narrowed later, so is the token.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  className="mt-0.5"
                  name="token-scope"
                  checked={!everything}
                  onChange={() => setEverything(false)}
                />
                <span className="text-ink">Only these</span>
              </label>
              {!everything && (
                <div className="ml-6 grid gap-1.5 sm:grid-cols-2">
                  {permissions.map((permission) => (
                    <label key={permission} className="flex items-center gap-2 font-mono text-xs">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={chosen.includes(permission)}
                        onChange={() => toggle(permission)}
                      />
                      {permission}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            {error && <p className="text-sm text-danger">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => openWith(false)} disabled={busy !== null}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy !== null || name.trim() === ''}>
                {busy === 'issue' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                Issue token
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
