'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ExternalLink, FileUp, KeyRound, Loader2, Plus, SlidersHorizontal, Trash2, Upload } from 'lucide-react';
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
import { ImportFormatError, MAX_IMPORT_ENTRIES, parseVaultImport, type ParsedImport } from '@/lib/personal/import';

/**
 * My passwords: the signed-in person's own vault (1030), laid out the way a
 * client's credentials are — a list at /personal/passwords, and a page per
 * entry with a Notes card and a Credentials card of login rows.
 *
 * Each entry has the same rows a client's credential has — username,
 * password, one-time code, website — with the same copy, show and open
 * controls, reading through the vault's own routes. Nothing here is a
 * client's, so nothing here appears in a client list, search or an export.
 *
 * WHAT THE PAGES PROMISE, and only that: nobody else can open these, an
 * administrator included. The server holds the key, as it does for every
 * secret in Helm, so the list says so rather than calling it zero-knowledge.
 */

/** + Add a password, above the list. */
export function AddVaultEntryButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        <Plus aria-hidden />
        Add a password
      </Button>
      {open && <EntryDialog entry={null} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Import, beside + Add a password: another password manager's export into
 * this vault. Laid out as a client's Import credentials is (shell/import-dialog),
 * so the two read the same: choose a file, see what it will do, then import.
 *
 * READ HERE, IN THE BROWSER, before anything is sent: the preview says what it
 * found — the format, how many logins, what it is leaving out — and only then
 * is the Import button live. The entries go to the vault's own import route,
 * in one transaction.
 *
 * The export is a file of every password in plain text. The result says to
 * delete it afterwards, because that is the step people forget.
 */
const VAULT_TEMPLATE = 'name,url,username,password,totp,notes\n';

export function ImportVaultButton() {
  const router = useRouter();
  const input = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ imported: number; duplicates: number; codesDropped: number } | null>(null);

  function reset() {
    setParsed(null); setFileName(null); setError(null); setDone(null); setBusy(false);
    if (input.current) input.current.value = '';
  }

  async function read(file: File) {
    setError(null); setDone(null); setParsed(null); setFileName(file.name);
    if (file.size > 16 * 1024 * 1024) { setError('That file is larger than 16 MB, which is not a password export.'); return; }
    setBusy(true);
    try {
      const result = parseVaultImport(await file.text());
      if (result.entries.length === 0) { setError('No logins were found in that file.'); return; }
      if (result.entries.length > MAX_IMPORT_ENTRIES) {
        setError(`That file holds ${result.entries.length} logins; one import takes up to ${MAX_IMPORT_ENTRIES}. Split it and import each part.`);
        return;
      }
      setParsed(result);
    } catch (cause) {
      setError(cause instanceof ImportFormatError ? cause.message : 'The file could not be read.');
    } finally {
      setBusy(false);
    }
  }

  async function store() {
    if (!parsed) return;
    setBusy(true); setError(null);
    try {
      const result = await apiFetch<{ imported: number; duplicates: number; codesDropped: number }>(
        '/api/personal/vault/import', { json: { entries: parsed.entries } },
      );
      if (!result.ok) { setError(result.message); return; }
      setDone(result.value);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const count = parsed?.entries.length ?? 0;
  const withPassword = parsed?.entries.filter((e) => e.password).length ?? 0;
  const withCode = parsed?.entries.filter((e) => e.totp).length ?? 0;
  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(VAULT_TEMPLATE)}`;

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => { reset(); setOpen(true); }}>
        <FileUp aria-hidden />
        Import
      </Button>
      <Modal
        open={open}
        onOpenChange={(next) => { setOpen(next); if (!next) reset(); }}
        title="Import passwords"
        icon={Upload}
        description="Nothing is written until you confirm. The file is read on this page and never uploaded."
        size="lg"
      >
        <div className="space-y-4">
          {done ? (
            <div className="flex items-start gap-2 rounded-md border border-ok/30 bg-ok/5 px-3 py-2.5 text-sm">
              <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
              <span role="status" className="text-ink">
                {done.imported} {done.imported === 1 ? 'password' : 'passwords'} imported into My passwords.
                {done.duplicates > 0 && ` ${done.duplicates} already here, skipped.`}
                {done.codesDropped > 0 && ` ${done.codesDropped} one-time code${done.codesDropped === 1 ? '' : 's'} could not be read and ${done.codesDropped === 1 ? 'was' : 'were'} left off.`}
                {' '}Now delete the export file: it holds every password in plain text.
              </span>
            </div>
          ) : (
            <>
              <div>
                <input
                  ref={input}
                  type="file"
                  accept=".csv,.json,text/csv,application/json"
                  aria-label="Export file"
                  className="block w-full text-sm text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-surface-sunken file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink hover:file:bg-border"
                  onChange={(e) => { const file = e.target.files?.[0]; if (file) void read(file); }}
                />
                <FieldHint>
                  An export from Bitwarden (CSV, or JSON that is not encrypted), Chrome or Edge, Firefox, 1Password,
                  LastPass or KeePass, or any CSV with a name and password column. Logins only; cards, identities and
                  secure notes are left out.{' '}
                  <a href={template} download="helm-my-passwords-template.csv" className="text-brand underline-offset-4 hover:underline">
                    Download a template
                  </a>
                  .
                </FieldHint>
              </div>

              {busy && !parsed && (
                <p className="flex items-center gap-2 text-sm text-ink-muted">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Reading {fileName}…
                </p>
              )}

              {parsed && (
                <div className="space-y-3 rounded-md border border-border bg-surface-sunken/50 p-3">
                  <p className="text-sm text-ink">
                    <span className="font-medium">{count}</span> {count === 1 ? 'login' : 'logins'} read from{' '}
                    {fileName ?? 'the file'} ({parsed.format}) · {withPassword} with a password · {withCode} with a one-time code
                    {parsed.skipped > 0 && ` · ${parsed.skipped} other item${parsed.skipped === 1 ? '' : 's'} left out`}
                  </p>
                  <div className="max-h-48 overflow-y-auto rounded border border-border bg-surface-raised">
                    <table className="w-full text-xs">
                      <tbody>
                        {parsed.entries.slice(0, 100).map((e, i) => (
                          <tr key={i} className="border-b border-border last:border-0">
                            <td className="px-2 py-1.5 font-medium text-ink">{e.name}</td>
                            <td className="px-2 py-1.5 text-ink-muted">{e.username ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {count > 100 && <p className="text-xs text-ink-faint">…and {count - 100} more.</p>}
                  <p className="text-xs text-ink-muted">
                    An entry with the same name, username and website as one you already have is skipped, so importing
                    the same file twice adds nothing.
                  </p>
                </div>
              )}

              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            </>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {done ? 'Close' : 'Cancel'}
            </Button>
            {!done && (
              <Button variant="cta" size="sm" disabled={!parsed || busy} onClick={() => void store()}>
                {busy && parsed ? <Loader2 className="animate-spin" /> : <FileUp />}
                Import {count} {count === 1 ? 'password' : 'passwords'}
              </Button>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}

/** Edit details, on the entry's Credentials card, as on a client's credential. */
export function EditVaultEntryButton({ entry }: { entry: VaultEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <SlidersHorizontal className="size-3.5" aria-hidden />
        Edit details
      </Button>
      {open && <EntryDialog key={entry.id} entry={entry} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The login rows: what the entry is opened to copy. Notes have their own card. */
export function VaultLoginRows({ entry }: { entry: VaultEntry }) {
  const base = `/api/personal/vault/${entry.id}`;
  const website = entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : null;
  return (
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
          <FieldLine><span className="text-ink-faint">No password stored — set one in Edit details</span></FieldLine>
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
    </FieldList>
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
        ...(entry ? {} : { notes: notes.trim() || null }),
        ...(removePassword ? { password: null } : password ? { password } : {}),
        ...(removeTotp ? { totp: null } : totp.trim() ? { totp: totp.trim() } : {}),
      };
      if (entry) {
        const result = await apiFetch(`/api/personal/vault/${entry.id}`, { method: 'PATCH', json: body });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        onClose();
        router.refresh();
        return;
      }
      const result = await apiFetch<{ entry: { id: string } }>('/api/personal/vault', { json: body });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onClose();
      // A new entry opens on its own page, as a new client credential does.
      router.push(`/personal/passwords/${result.value.entry.id}`);
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
      // Its page is gone with it: back to the list.
      router.push('/personal/passwords');
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
          {/* Once the entry exists its notes are edited on their own card. */}
          {!entry && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="vault-notes">Notes</Label>
              <Textarea id="vault-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} />
            </div>
          )}
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
