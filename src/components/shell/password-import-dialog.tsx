'use client';

/**
 * Bringing a password manager's export into a client's Credentials.
 *
 * THREE STEPS. Pick the export; check which column is which; see what the
 * server makes of it, then import. The generic CSV dialog (import-dialog.tsx)
 * goes straight from file to preview because its files are Helm's own template.
 * These are not: every password manager names its columns differently, nests
 * its JSON differently, and some (Keeper) write no header at all, so the guess
 * is shown and can be corrected before anything is sent.
 *
 * THE FILE STAYS IN THIS TAB. It is parsed here (lib/import/password-export.ts)
 * and only the mapped rows go to the server — the same request that encrypts
 * them. The mapping step's samples show a password as dots and the server's
 * preview reports rows by name, never by value.
 */
import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, FileUp, KeyRound, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { FieldHint, Label, Select } from '../ui/field';
import { apiFetch } from '@/lib/ui/api';
import {
  distinctValues,
  mapPasswordRows,
  MAX_EXPORT_ROWS,
  PASSWORD_TARGETS,
  PasswordExportError,
  readPasswordFile,
  type ColumnMapping,
  type PasswordTable,
  type PasswordTarget,
} from '@/lib/import/password-export';

interface RowDetail {
  line: number;
  label: string;
  errors?: string[];
}

interface ImportSummary {
  rows: number;
  valid: number;
  invalid: number;
  duplicates: number;
  rows_detail: RowDetail[];
  duplicates_detail: RowDetail[];
  committed: number;
  left_out: number;
}

/** 1Password's .1pux for a large account runs to a few MB, mostly attachments it does not include. */
const MAX_BYTES = 20 * 1024 * 1024;
const SAMPLE_ROWS = 5;

export function PasswordImportDialog({
  organizationId,
  templateHeader,
  open,
  onOpenChange,
}: {
  organizationId: string;
  templateHeader: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement | null>(null);
  const bytes = useRef<Uint8Array | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [table, setTable] = useState<PasswordTable | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [filterColumn, setFilterColumn] = useState<number | null>(null);
  const [filterValue, setFilterValue] = useState('');
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ committed: number; leftOut: number } | null>(null);

  const reset = () => {
    bytes.current = null;
    setFilename(null);
    setTable(null);
    setMapping(null);
    setFilterColumn(null);
    setFilterValue('');
    setPreview(null);
    setSkipInvalid(false);
    setSkipDuplicates(true);
    setError(null);
    setDone(null);
    if (input.current) input.current.value = '';
  };

  const rows = useMemo(() => {
    if (!table || !mapping) return [];
    const filter = filterColumn !== null && filterValue !== '' ? { column: filterColumn, value: filterValue } : null;
    return mapPasswordRows(table, mapping, filter);
  }, [table, mapping, filterColumn, filterValue]);
  const filterOptions = useMemo(
    () => (table && filterColumn !== null ? distinctValues(table, filterColumn) : []),
    [table, filterColumn],
  );

  async function load(data: Uint8Array, headerless?: boolean) {
    setError(null);
    setPreview(null);
    try {
      const read = await readPasswordFile(data, headerless === undefined ? {} : { headerless });
      setTable(read);
      setMapping({ ...read.suggested });
      setFilterColumn(null);
      setFilterValue('');
    } catch (e) {
      setTable(null);
      setMapping(null);
      setError(e instanceof PasswordExportError ? e.message : 'The file could not be read.');
    }
  }

  async function pick(file: File) {
    reset();
    if (file.size > MAX_BYTES) {
      setError(`That file is ${Math.round(file.size / 1024 / 1024)}MB. The limit is 20MB.`);
      return;
    }
    setFilename(file.name);
    setBusy(true);
    try {
      bytes.current = new Uint8Array(await file.arrayBuffer());
      await load(bytes.current);
    } finally {
      setBusy(false);
    }
  }

  function remap(target: PasswordTarget, value: string) {
    if (!mapping) return;
    const index = value === '' ? null : Number(value);
    const next = { ...mapping, [target]: index };
    // One column feeds one field: taking it here releases it elsewhere.
    for (const t of PASSWORD_TARGETS) {
      if (t.key !== target && index !== null && next[t.key] === index) next[t.key] = null;
    }
    setMapping(next);
    setPreview(null);
  }

  async function send(commit: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<ImportSummary>(`/api/organizations/${organizationId}/import`, {
        json: { category: 'passwords', rows, commit, skipInvalid, skipDuplicates },
      });
      if (!result.ok) {
        const details = result.details as ImportSummary | undefined;
        if (details?.rows !== undefined) setPreview(details);
        setError(result.message);
        return;
      }
      if (commit) {
        setDone({ committed: result.value.committed, leftOut: result.value.left_out });
        router.refresh();
      } else {
        setPreview(result.value);
      }
    } finally {
      setBusy(false);
    }
  }

  const sample = (index: number | null, target: PasswordTarget) => {
    if (!table || index === null) return '';
    const value = table.rows.find((r) => (r[index] ?? '').trim() !== '')?.[index] ?? '';
    if (value === '') return '(empty)';
    if (target === 'password' || target === 'totpSeed') return '••••••••';
    return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  };

  const tooMany = rows.length > MAX_EXPORT_ROWS;
  const noPasswordColumn = mapping !== null && mapping.password === null;
  const writable = preview
    ? preview.rows
      - (skipInvalid ? preview.invalid : 0)
      - (skipDuplicates ? preview.duplicates : 0)
    : 0;
  const ready = preview !== null && done === null && writable > 0 && (preview.invalid === 0 || skipInvalid);
  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(templateHeader)}`;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title="Import credentials"
      description="From a password manager's export. Passwords are encrypted as they arrive, and nothing is written until you confirm."
      icon={KeyRound}
      size="lg"
    >
      <div className="space-y-4">
        {done !== null ? (
          <div className="flex items-start gap-2 rounded-md border border-ok/30 bg-ok/5 px-3 py-2.5 text-sm">
            <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
            <span className="text-ink">
              {done.committed} {done.committed === 1 ? 'credential' : 'credentials'} imported
              {done.leftOut > 0 && <>, {done.leftOut} left out</>}.
              {' '}Delete the export file now: it holds every password in plain text.
            </span>
          </div>
        ) : (
          <>
            <div>
              <input
                ref={input}
                type="file"
                accept=".csv,.json,.1pux,.zip,.txt,text/csv,application/json"
                aria-label="Export file"
                className="block w-full text-sm text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-surface-sunken file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink hover:file:bg-border"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void pick(file);
                }}
              />
              <FieldHint>
                CSV or JSON from Bitwarden, 1Password (CSV or .1pux), LastPass, Keeper, Dashlane,
                Proton Pass, KeePass, IT Glue or a browser, or any CSV with a header row.{' '}
                <a href={template} download="helm-passwords-template.csv" className="text-brand underline-offset-4 hover:underline">
                  Download a template
                </a>
                .
              </FieldHint>
            </div>

            {busy && !table && (
              <p className="flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Reading {filename}…
              </p>
            )}

            {table && mapping && (
              <div className="space-y-3 rounded-md border border-border bg-surface-sunken/50 p-3">
                <p className="text-sm text-ink">
                  <span className="font-medium">{table.format}</span>
                  {' · '}
                  {table.rows.length} {table.rows.length === 1 ? 'entry' : 'entries'}
                  {table.skipped > 0 && (
                    <span className="text-ink-muted">
                      {' · '}
                      {table.skipped} left out (secure notes, cards and other items that are not logins)
                    </span>
                  )}
                </p>
                {table.notices.map((n) => (
                  <p key={n} className="text-xs text-ink-muted">{n}</p>
                ))}

                {table.format.includes('CSV') && (
                  <label className="flex items-center gap-2 text-xs text-ink">
                    <input
                      type="checkbox"
                      checked={table.headerless}
                      onChange={(e) => bytes.current && void load(bytes.current, e.target.checked)}
                    />
                    The first row is an entry, not column names
                  </label>
                )}

                <div className="grid gap-x-3 gap-y-1.5 sm:grid-cols-3">
                  {PASSWORD_TARGETS.map((target) => (
                    <div key={target.key}>
                      <Label htmlFor={`map-${target.key}`} className="text-xs">{target.label}</Label>
                      <Select
                        id={`map-${target.key}`}
                        className="h-8 text-xs"
                        value={mapping[target.key] ?? ''}
                        onChange={(e) => remap(target.key, e.target.value)}
                      >
                        <option value="">Not in this file</option>
                        {table.columns.map((column, index) => (
                          <option key={`${column}-${index}`} value={index}>{column}</option>
                        ))}
                      </Select>
                      <p className="mt-0.5 h-4 truncate text-[11px] text-ink-faint">
                        {sample(mapping[target.key], target.key)}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
                  <div className="min-w-40 flex-1">
                    <Label htmlFor="filter-column" className="text-xs">Only import entries where</Label>
                    <Select
                      id="filter-column"
                      className="h-8 text-xs"
                      value={filterColumn ?? ''}
                      onChange={(e) => {
                        setFilterColumn(e.target.value === '' ? null : Number(e.target.value));
                        setFilterValue('');
                        setPreview(null);
                      }}
                    >
                      <option value="">Import every entry</option>
                      {table.columns.map((column, index) => (
                        <option key={`${column}-${index}`} value={index}>{column}</option>
                      ))}
                    </Select>
                  </div>
                  {filterColumn !== null && (
                    <div className="min-w-40 flex-1">
                      <Label htmlFor="filter-value" className="text-xs">is</Label>
                      <Select
                        id="filter-value"
                        className="h-8 text-xs"
                        value={filterValue}
                        onChange={(e) => { setFilterValue(e.target.value); setPreview(null); }}
                      >
                        <option value="">Choose…</option>
                        {filterOptions.map((v) => <option key={v} value={v}>{v}</option>)}
                      </Select>
                    </div>
                  )}
                </div>
                <FieldHint>
                  For an export that covers several clients, such as a Bitwarden organization or an
                  IT Glue export, pick the folder, collection or organization that belongs to this client.
                </FieldHint>

                {rows.length > 0 && (
                  <div className="max-h-44 overflow-auto rounded border border-border bg-surface-raised">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-left text-ink-faint">
                          <th className="px-2 py-1.5 font-medium">Name</th>
                          <th className="px-2 py-1.5 font-medium">Username</th>
                          <th className="px-2 py-1.5 font-medium">Password</th>
                          <th className="px-2 py-1.5 font-medium">URL</th>
                          <th className="px-2 py-1.5 font-medium">Folder</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, SAMPLE_ROWS).map((row, i) => (
                          <tr key={i} className="border-b border-border last:border-0">
                            <td className="max-w-40 truncate px-2 py-1.5 font-medium text-ink">{row.name || '(unnamed)'}</td>
                            <td className="max-w-32 truncate px-2 py-1.5 text-ink-muted">{row.username}</td>
                            <td className="px-2 py-1.5 text-ink-muted">
                              {row.password ? '••••••••' : <span className="text-danger">missing</span>}
                            </td>
                            <td className="max-w-40 truncate px-2 py-1.5 text-ink-muted">{row.url}</td>
                            <td className="max-w-24 truncate px-2 py-1.5 text-ink-muted">{row.folder}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {rows.length > SAMPLE_ROWS && (
                      <p className="px-2 py-1.5 text-[11px] text-ink-faint">and {rows.length - SAMPLE_ROWS} more</p>
                    )}
                  </div>
                )}

                {noPasswordColumn && (
                  <p className="text-xs text-danger">Choose which column holds the password.</p>
                )}
                {tooMany && (
                  <p className="text-xs text-danger">
                    {rows.length} entries is more than the {MAX_EXPORT_ROWS} one import can take. Use the filter
                    to bring them in a folder at a time.
                  </p>
                )}
              </div>
            )}

            {preview && (
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="text-sm text-ink">
                  <span className="font-medium">{preview.valid}</span> ready to import
                  {preview.invalid > 0 && (
                    <>{' · '}<span className="font-medium text-danger">{preview.invalid} with problems</span></>
                  )}
                  {preview.duplicates > 0 && (
                    <>{' · '}<span className="font-medium text-sev-warning">{preview.duplicates} already in Helm</span></>
                  )}
                </p>

                {preview.rows_detail.length > 0 && (
                  <div className="max-h-36 overflow-y-auto rounded border border-border bg-surface-raised">
                    <table className="w-full text-xs">
                      <tbody>
                        {preview.rows_detail.map((row) => (
                          <tr key={row.line} className="border-b border-border last:border-0">
                            <td className="w-10 px-2 py-1.5 text-ink-faint">{row.line}</td>
                            <td className="px-2 py-1.5 font-medium text-ink">{row.label}</td>
                            <td className="px-2 py-1.5 text-danger">{row.errors?.join('; ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {preview.invalid > 0 && (
                  <label className="flex items-start gap-2 text-xs text-ink">
                    <input type="checkbox" className="mt-0.5" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} />
                    Leave out the {preview.invalid} with problems and import the rest
                  </label>
                )}

                {preview.duplicates > 0 && (
                  <>
                    <p className="text-xs text-ink-muted">
                      Already in Helm with the same name and username:{' '}
                      <span className="text-ink">
                        {preview.duplicates_detail.map((d) => d.label).join(', ')}
                        {preview.duplicates > preview.duplicates_detail.length && ', …'}
                      </span>
                    </p>
                    <label className="flex items-start gap-2 text-xs text-ink">
                      <input type="checkbox" className="mt-0.5" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
                      {preview.duplicates === 1 ? 'Skip it' : `Skip these ${preview.duplicates}`} (untick to import extra copies)
                    </label>
                  </>
                )}

                {preview.invalid > 0 && !skipInvalid && (
                  <p className="flex items-start gap-2 text-xs text-ink-muted">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-sev-warning" aria-hidden />
                    Fix the mapping above, or tick the box to leave those rows out. Nothing is written while
                    any row has a problem.
                  </p>
                )}
              </div>
            )}

            {error && <p className="text-sm text-danger">{error}</p>}
          </>
        )}

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {done !== null ? 'Close' : 'Cancel'}
          </Button>
          {done === null && !preview && (
            <Button
              variant="cta"
              size="sm"
              disabled={busy || rows.length === 0 || tooMany || noPasswordColumn}
              onClick={() => void send(false)}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Check />}
              Check {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
            </Button>
          )}
          {done === null && preview && (
            <Button variant="cta" size="sm" disabled={!ready || busy} onClick={() => void send(true)}>
              {busy ? <Loader2 className="animate-spin" /> : <FileUp />}
              Import {Math.max(writable, 0)} {writable === 1 ? 'credential' : 'credentials'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
