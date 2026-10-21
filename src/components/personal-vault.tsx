'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, ExternalLink, KeyRound, Loader2, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label, Textarea } from './ui/field';
import { Modal } from './ui/modal';
import { CopyValueButton } from './copy-value-button';
import { FieldLine, FieldList, FieldRow, iconActionClass } from './field-row';
import { PasswordGenerator } from './password-generator';
import { RevealButton } from './reveal-button';
import { TotpPanel } from './totp-panel';
import { apiFetch } from '@/lib/ui/api';
import type { VaultEntry } from '@/lib/personal/vault';

/**
 * My passwords: the signed-in person's own vault (1030).
 *
 * Each entry opens into the same rows a client's credential has — username,
 * password, one-time code, website — with the same copy, show and open
 * controls, reading through the vault's own routes. Nothing here is a
 * client's, so nothing here appears in a client list, search or an export.
 *
 * WHAT THE PAGE PROMISES, and only that: nobody else can open these, an
 * administrator included. The server holds the key, as it does for every
 * secret in Helm, so the card says so rather than calling it zero-knowledge.
 */
export function PersonalVault({ entries }: { entries: VaultEntry[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<VaultEntry | 'new' | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-muted">
          <Lock className="mr-1 inline size-3.5 text-ink-faint" aria-hidden />
          Only you can see or open these, an administrator included. They belong to no client, never
          appear in search or exports, and are deleted if you leave. Encrypted like every Helm secret; each
          time one is opened it is logged, without its name.
        </p>
        <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>
          <Plus aria-hidden />
          Add a password
        </Button>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-ink-faint">Nothing stored yet.</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {entries.map((entry) => {
            const expanded = open === entry.id;
            return (
              <li key={entry.id}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setOpen(expanded ? null : entry.id)}
                    aria-expanded={expanded}
                  >
                    {expanded
                      ? <ChevronDown className="size-4 shrink-0 text-ink-faint" aria-hidden />
                      : <ChevronRight className="size-4 shrink-0 text-ink-faint" aria-hidden />}
                    <span className="truncate text-sm font-medium text-ink">{entry.name}</span>
                    {entry.username && <span className="truncate text-xs text-ink-faint">{entry.username}</span>}
                  </button>
                  <button type="button" className={iconActionClass} title="Edit" aria-label={`Edit ${entry.name}`}
                          onClick={() => setEditing(entry)}>
                    <Pencil aria-hidden />
                  </button>
                </div>
                {expanded && <EntryRows entry={entry} />}
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <EntryDialog
          key={editing === 'new' ? 'new' : editing.id}
          entry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function EntryRows({ entry }: { entry: VaultEntry }) {
  const base = `/api/personal/vault/${entry.id}`;
  const website = entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : null;
  return (
    <div className="px-3 pb-3">
      <FieldList>
        {entry.username && (
          <FieldRow label="Username">
            <FieldLine actions={<CopyValueButton value={entry.username} label="Copy username" size="md" />}>
              {entry.username}
            </FieldLine>
          </FieldRow>
        )}
        <FieldRow label="Password">
          {entry.hasPassword ? (
            <RevealButton
              secretId={entry.id}
              label={entry.name}
              requiresReason={false}
              requiresStepUp={false}
              endpoints={{ reveal: `${base}/reveal` }}
            />
          ) : (
            <FieldLine><span className="text-ink-faint">No password stored</span></FieldLine>
          )}
        </FieldRow>
        {entry.hasTotp && (
          <FieldRow label="Verification code (TOTP)">
            <TotpPanel nodeId={entry.id} canReveal codePath={`${base}/code`} />
          </FieldRow>
        )}
        {entry.url && (
          <FieldRow label="Website">
            <FieldLine
              actions={
                <>
                  {website && (
                    <a href={website} target="_blank" rel="noopener noreferrer" className={iconActionClass}
                       title="Open in a new tab" aria-label="Open website">
                      <ExternalLink aria-hidden />
                    </a>
                  )}
                  <CopyValueButton value={entry.url} label="Copy website" size="md" />
                </>
              }
            >
              {entry.url}
            </FieldLine>
          </FieldRow>
        )}
        {entry.notes && (
          <FieldRow label="Notes">
            <p className="whitespace-pre-wrap text-sm text-ink">{entry.notes}</p>
          </FieldRow>
        )}
      </FieldList>
    </div>
  );
}

/**
 * Adding or changing an entry. The password and the one-time code are
 * write-only here, as everywhere: an empty box keeps what is stored, and
 * removing either is a tick, so nothing is cleared by leaving a field alone.
 */
function EntryDialog({ entry, onClose }: { entry: VaultEntry | null; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(entry?.name ?? '');
  const [username, setUsername] = useState(entry?.username ?? '');
  const [url, setUrl] = useState(entry?.url ?? '');
  const [notes, setNotes] = useState(entry?.notes ?? '');
  const [password, setPassword] = useState('');
  const [removePassword, setRemovePassword] = useState(false);
  const [totp, setTotp] = useState('');
  const [removeTotp, setRemoveTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        username: username.trim() || null,
        url: url.trim() || null,
        notes: notes.trim() || null,
        ...(removePassword ? { password: null } : password ? { password } : {}),
        ...(removeTotp ? { totp: null } : totp.trim() ? { totp: totp.trim() } : {}),
      };
      const result = entry
        ? await apiFetch(`/api/personal/vault/${entry.id}`, { method: 'PATCH', json: body })
        : await apiFetch('/api/personal/vault', { json: body });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onClose();
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!entry) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch(`/api/personal/vault/${entry.id}`, { method: 'DELETE' });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onClose();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={entry ? `Edit ${entry.name}` : 'Add a password'}
      icon={KeyRound}
      description="Private to you. Nobody else in Helm can open it."
      size="lg"
    >
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="vault-name">Name</Label>
            <Input id="vault-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required
                   placeholder="e.g. My bank" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vault-username">Username</Label>
            <Input id="vault-username" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={320}
                   autoComplete="off" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="vault-password">Password</Label>
            <div className="flex gap-2">
              <Input id="vault-password" type="password" value={password} autoComplete="new-password"
                     onChange={(e) => { setPassword(e.target.value); if (e.target.value) setRemovePassword(false); }}
                     placeholder={entry?.hasPassword ? 'Stored — leave empty to keep it' : undefined}
                     disabled={removePassword} />
              <PasswordGenerator onUse={(v) => { setPassword(v); setRemovePassword(false); }} />
            </div>
            {entry?.hasPassword && (
              <label className="flex items-center gap-2 text-xs text-ink-muted">
                <input type="checkbox" checked={removePassword}
                       onChange={(e) => { setRemovePassword(e.target.checked); if (e.target.checked) setPassword(''); }} />
                Remove the stored password
              </label>
            )}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="vault-url">Website</Label>
            <Input id="vault-url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2048}
                   placeholder="https://" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="vault-totp">One-time code</Label>
            <Input id="vault-totp" value={totp} onChange={(e) => { setTotp(e.target.value); if (e.target.value) setRemoveTotp(false); }}
                   placeholder={entry?.hasTotp ? 'Stored — paste a new seed to replace it' : 'otpauth://… or a base32 seed'}
                   autoComplete="off" spellCheck={false} maxLength={4096} disabled={removeTotp} />
            <FieldHint>Optional. Codes are generated here; the seed is never shown again.</FieldHint>
            {entry?.hasTotp && (
              <label className="flex items-center gap-2 text-xs text-ink-muted">
                <input type="checkbox" checked={removeTotp}
                       onChange={(e) => { setRemoveTotp(e.target.checked); if (e.target.checked) setTotp(''); }} />
                Remove the one-time code
              </label>
            )}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="vault-notes">Notes</Label>
            <Textarea id="vault-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} />
          </div>
        </div>

        {error && <p role="alert" className="text-sm text-danger">{error}</p>}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button type="submit" variant="primary" disabled={busy || name.trim() === ''}>
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            {entry ? 'Save' : 'Add'}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          {entry && (
            confirmDelete ? (
              <span className="ml-auto flex items-center gap-2 text-sm">
                <span className="text-ink-muted">Delete it for good?</span>
                <Button type="button" variant="danger" size="sm" disabled={busy} onClick={() => void remove()}>
                  Delete
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Keep</Button>
              </span>
            ) : (
              <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden />
                Delete
              </Button>
            )
          )}
        </div>
      </form>
    </Modal>
  );
}
