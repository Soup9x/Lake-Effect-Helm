'use client';

/**
 * Service accounts: machine identities, their tokens, and the one chance to
 * copy each token.
 *
 * WHY A SEPARATE IDENTITY. A backup script that runs as whoever configured it
 * stops working the day that person leaves, and until then every credential it
 * reads is audited against a human who did not read it. An account with its
 * own name, role and scope answers "what is this token" the way an audit row
 * should.
 *
 * SCOPES COME FROM THE ROLE, NOT FROM THE ADMINISTRATOR. The checkboxes list
 * the account's role permissions, because that is the ceiling the database
 * enforces: an administrator issuing a token for a tier1 account cannot give
 * it tier3's reach, and the form does not offer to.
 *
 * SHOWN ONCE, as the personal token card says: the value exists in the POST
 * response and nowhere else, and it leaves this component's state when the
 * dialog closes.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, Check, ChevronDown, ChevronRight, Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { Modal } from './ui/modal';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from './ui/table';
import { apiFetch } from '@/lib/ui/api';
import { copyFailureMessage, copyUnaudited } from '@/lib/ui/clipboard';
import { formatDateTime } from '@/lib/ui/format';
import type { GrantableRole, ServiceAccountRow, ServiceTokenRow } from '@/lib/auth/service-accounts';

interface Issued {
  token: string;
  prefix: string;
  expiresAt: string;
}

const EXPIRY_CHOICES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '180 days' },
  { days: 365, label: 'A year (the most allowed)' },
] as const;

export function ServiceAccountsCard({
  accounts,
  roles,
  organizations,
  canManage,
}: {
  accounts: ServiceAccountRow[];
  /** The roles this administrator may grant, with each one's permissions. */
  roles: GrantableRole[];
  organizations: readonly { id: string; name: string }[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tokens, setTokens] = useState<Record<string, ServiceTokenRow[]>>({});
  const [issuingFor, setIssuingFor] = useState<ServiceAccountRow | null>(null);

  async function loadTokens(accountId: string) {
    const result = await apiFetch<{ tokens: ServiceTokenRow[] }>(`/api/tenant/service-accounts/${accountId}/tokens`);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setTokens((current) => ({ ...current, [accountId]: result.value.tokens }));
  }

  async function toggle(accountId: string) {
    const next = expanded === accountId ? null : accountId;
    setExpanded(next);
    if (next && !tokens[next]) await loadTokens(next);
  }

  async function setDisabled(account: ServiceAccountRow, disabled: boolean) {
    setBusy(account.id);
    setError(null);
    try {
      const result = await apiFetch(`/api/tenant/service-accounts/${account.id}`, {
        method: 'PATCH',
        json: { disabled },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function revoke(accountId: string, tokenId: string) {
    setBusy(tokenId);
    setError(null);
    try {
      const result = await apiFetch(`/api/tenant/service-accounts/${accountId}/tokens/${tokenId}`, {
        method: 'DELETE',
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await loadTokens(accountId);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-ink-muted">
        An identity for automation — a backup job, a monitoring probe, an RMM — with its own
        role and scope, so what it does is audited against it and not against whoever set it
        up. Each one holds tokens it presents as{' '}
        <code className="font-mono text-xs">Authorization: Bearer …</code>; a token carries at
        most the role&apos;s permissions and expires within a year.
      </p>

      {error && <p className="text-sm text-danger">{error}</p>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Tokens</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.length === 0 && (
            <TableEmpty colSpan={7}>No service accounts. Create one for automation that needs the API.</TableEmpty>
          )}
          {accounts.map((account) => {
            const open = expanded === account.id;
            const list = tokens[account.id];
            return (
              <AccountRows
                key={account.id}
                account={account}
                open={open}
                tokens={list}
                busy={busy}
                canManage={canManage}
                onToggle={() => toggle(account.id)}
                onIssue={() => setIssuingFor(account)}
                onDisable={(disabled) => setDisabled(account, disabled)}
                onRevoke={(tokenId) => revoke(account.id, tokenId)}
              />
            );
          })}
        </TableBody>
      </Table>

      {canManage && (
        <Button variant="secondary" size="sm" onClick={() => setCreating(true)} disabled={roles.length === 0}>
          <Plus className="size-3.5" aria-hidden /> New service account
        </Button>
      )}

      <NewAccountModal
        open={creating}
        onClose={() => setCreating(false)}
        roles={roles}
        organizations={organizations}
        onCreated={() => {
          setCreating(false);
          router.refresh();
        }}
      />

      <IssueTokenModal
        account={issuingFor}
        role={issuingFor ? roles.find((r) => r.key === issuingFor.roleKey) : undefined}
        onClose={() => setIssuingFor(null)}
        onIssued={async (accountId) => {
          await loadTokens(accountId);
          setExpanded(accountId);
          router.refresh();
        }}
      />
    </div>
  );
}

function AccountRows({
  account,
  open,
  tokens,
  busy,
  canManage,
  onToggle,
  onIssue,
  onDisable,
  onRevoke,
}: {
  account: ServiceAccountRow;
  open: boolean;
  tokens: ServiceTokenRow[] | undefined;
  busy: string | null;
  canManage: boolean;
  onToggle: () => void;
  onIssue: () => void;
  onDisable: (disabled: boolean) => void;
  onRevoke: (tokenId: string) => void;
}) {
  const disabled = account.disabledAt !== null;
  return (
    <>
      <TableRow className={disabled ? 'opacity-60' : undefined}>
        <TableCell>
          <button
            type="button"
            onClick={onToggle}
            className="flex size-6 items-center justify-center rounded text-ink-faint hover:text-ink"
            aria-expanded={open}
            aria-label={open ? `Hide tokens for ${account.name}` : `Show tokens for ${account.name}`}
          >
            {open ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
          </button>
        </TableCell>
        <TableCell>
          <div className="font-medium text-ink">{account.name}</div>
          {account.description && <div className="text-xs text-ink-muted">{account.description}</div>}
          {disabled && <Badge tone="neutral">Disabled</Badge>}
        </TableCell>
        <TableCell className="text-xs">
          {account.roleName}
          <div className="font-mono text-ink-faint">{account.roleKey}</div>
        </TableCell>
        <TableCell className="text-xs">
          {account.orgScopeAll ? 'Every client' : account.orgNames.join(', ') || `${account.orgScope.length} clients`}
        </TableCell>
        <TableCell className="text-xs tabular-nums">{account.liveTokens} live</TableCell>
        <TableCell className="text-xs text-ink-muted">
          {account.lastUsedAt ? formatDateTime(account.lastUsedAt) : 'never'}
        </TableCell>
        <TableCell className="text-right">
          {canManage && (
            <div className="flex justify-end gap-1">
              <Button variant="ghost" size="sm" disabled={busy !== null || disabled} onClick={onIssue}>
                <KeyRound className="size-3.5" aria-hidden /> Issue token
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => onDisable(!disabled)}
                aria-label={`${disabled ? 'Enable' : 'Disable'} ${account.name}`}
              >
                {busy === account.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                {disabled ? 'Enable' : 'Disable'}
              </Button>
            </div>
          )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={7} className="bg-surface-sunken">
            {tokens === undefined ? (
              <span className="text-xs text-ink-muted">Loading…</span>
            ) : tokens.length === 0 ? (
              <span className="text-xs text-ink-muted">No tokens. Issue one to let this account call the API.</span>
            ) : (
              <ul className="space-y-1.5">
                {tokens.map((token) => (
                  <li key={token.id} className={`flex flex-wrap items-center gap-3 text-xs ${token.live ? '' : 'opacity-60'}`}>
                    <span className="font-medium text-ink">{token.name}</span>
                    <code className="font-mono">{token.prefix}</code>
                    <span>{token.scopes.includes('*') ? 'everything the role allows' : token.scopes.join(' ')}</span>
                    {token.ipAllowlist.length > 0 && <span>from {token.ipAllowlist.join(', ')}</span>}
                    {token.revokedAt ? (
                      <Badge tone="expired">revoked {formatDateTime(token.revokedAt)}</Badge>
                    ) : token.live ? (
                      <span className="text-ink-muted">expires {formatDateTime(token.expiresAt)}</span>
                    ) : (
                      <Badge tone="expired">expired {formatDateTime(token.expiresAt)}</Badge>
                    )}
                    <span className="text-ink-muted">
                      {token.lastUsedAt ? `used ${formatDateTime(token.lastUsedAt)}` : 'never used'}
                    </span>
                    {canManage && token.live && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => onRevoke(token.id)}
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
                  </li>
                ))}
              </ul>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function NewAccountModal({
  open,
  onClose,
  roles,
  organizations,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  roles: GrantableRole[];
  organizations: readonly { id: string; name: string }[];
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? '');
  const [everyClient, setEveryClient] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const role = roles.find((r) => r.key === roleKey) ?? roles[0];
  const tenantWide = role?.isTenantWide ?? false;

  function reset() {
    setName('');
    setDescription('');
    setRoleKey(roles[0]?.key ?? '');
    setEveryClient(true);
    setChosen([]);
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const scopeAll = tenantWide && everyClient;
    if (!scopeAll && chosen.length === 0) {
      setError('Choose at least one client, or give the account every client.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch('/api/tenant/service-accounts', {
        json: {
          name: name.trim(),
          description: description.trim() || null,
          roleKey: role?.key,
          orgScopeAll: scopeAll,
          orgScope: scopeAll ? [] : chosen,
        },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      reset();
      onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
      title="New service account"
      description="A machine identity with its own role and scope. Tokens are issued to it afterwards."
      icon={Bot}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="sa-name">Name</Label>
          <Input id="sa-name" value={name} maxLength={80} required placeholder="nightly-backup" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sa-description">What it is for</Label>
          <Textarea id="sa-description" value={description} maxLength={500} rows={2} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sa-role">Role</Label>
          <Select id="sa-role" value={role?.key ?? ''} onChange={(e) => setRoleKey(e.target.value)}>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </Select>
          <FieldHint>
            The ceiling for every token this account holds. Only roles at or below your own are offered.
          </FieldHint>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">Clients</legend>
          {tenantWide && (
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="sa-scope" checked={everyClient} onChange={() => setEveryClient(true)} />
              Every client
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="sa-scope"
              checked={!tenantWide || !everyClient}
              onChange={() => setEveryClient(false)}
            />
            Only these
          </label>
          {(!tenantWide || !everyClient) && (
            <div className="ml-6 grid max-h-48 gap-1.5 overflow-y-auto sm:grid-cols-2">
              {organizations.map((org) => (
                <label key={org.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={chosen.includes(org.id)}
                    onChange={() =>
                      setChosen((current) =>
                        current.includes(org.id) ? current.filter((id) => id !== org.id) : [...current, org.id],
                      )
                    }
                  />
                  {org.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => { reset(); onClose(); }} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || name.trim() === '' || !role}>
            {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function IssueTokenModal({
  account,
  role,
  onClose,
  onIssued,
}: {
  account: ServiceAccountRow | null;
  role: GrantableRole | undefined;
  onClose: () => void;
  onIssued: (accountId: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [days, setDays] = useState<number>(90);
  const [everything, setEverything] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const [addresses, setAddresses] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  function reset() {
    setName('');
    setDays(90);
    setEverything(true);
    setChosen([]);
    setAddresses('');
    setError(null);
    setIssued(null);
    setCopied(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!account) return;
    const scopes = everything ? ['*'] : chosen;
    if (scopes.length === 0) {
      setError('Choose at least one permission, or let the token carry everything the role allows.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<Issued>(`/api/tenant/service-accounts/${account.id}/tokens`, {
        json: {
          name: name.trim(),
          scopes,
          expiresInDays: days,
          ipAllowlist: addresses.split(/[,\s]+/).map((a) => a.trim()).filter(Boolean),
        },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setIssued(result.value);
      await onIssued(account.id);
    } finally {
      setBusy(false);
    }
  }

  async function copy(token: string) {
    const outcome = await copyUnaudited(token);
    setCopied(outcome === 'copied' ? 'Copied.' : copyFailureMessage(outcome));
  }

  return (
    <Modal
      open={account !== null}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
      title={issued ? 'The new token' : `Issue a token for ${account?.name ?? ''}`}
      description={
        issued
          ? 'Copy it now. It is shown once and cannot be recovered; issue another if it is lost.'
          : 'It acts as this account, narrowed to the scopes you choose, until it expires or is revoked.'
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
              {copied === 'Copied.' ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              Copy token
            </Button>
            {copied && <span className={copied === 'Copied.' ? 'text-sm text-ok' : 'text-sm text-danger'}>{copied}</span>}
          </div>
          <FieldHint>
            Prefix <span className="font-mono">{issued.prefix}</span>, expires {formatDateTime(issued.expiresAt)}.
          </FieldHint>
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={() => { reset(); onClose(); }}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sa-token-name">Name</Label>
            <Input id="sa-token-name" value={name} maxLength={80} required placeholder="Where this token lives" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sa-token-days">Expires in</Label>
            <Select id="sa-token-days" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {EXPIRY_CHOICES.map((choice) => (
                <option key={choice.days} value={choice.days}>
                  {choice.label}
                </option>
              ))}
            </Select>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">Permissions</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="sa-token-scope" checked={everything} onChange={() => setEverything(true)} />
              Everything the {role?.name ?? 'role'} role allows
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="sa-token-scope" checked={!everything} onChange={() => setEverything(false)} />
              Only these
            </label>
            {!everything && (
              <div className="ml-6 grid gap-1.5 sm:grid-cols-2">
                {(role?.permissions ?? []).map((permission) => (
                  <label key={permission} className="flex items-center gap-2 font-mono text-xs">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={chosen.includes(permission)}
                      onChange={() =>
                        setChosen((current) =>
                          current.includes(permission) ? current.filter((p) => p !== permission) : [...current, permission],
                        )
                      }
                    />
                    {permission}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="space-y-1.5">
            <Label htmlFor="sa-token-ips">Only from these addresses (optional)</Label>
            <Input id="sa-token-ips" value={addresses} placeholder="203.0.113.9, 203.0.113.10" onChange={(e) => setAddresses(e.target.value)} />
            <FieldHint>
              Exact IP addresses, comma separated. A request from anywhere else is refused as if the token
              did not exist. Leave blank to accept any address.
            </FieldHint>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => { reset(); onClose(); }} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim() === ''}>
              {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              Issue token
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
