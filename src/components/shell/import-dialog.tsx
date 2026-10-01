'use client';

/**
 * Bringing a CSV in.
 *
 * TWO STEPS, ALWAYS. Pick a file, see what it will do, then commit. The preview
 * is not a courtesy — the import is all-or-nothing, and "500 rows, 3 of them
 * wrong, nothing written" is only a reasonable answer if somebody could see the
 * three first. It also catches the whole class of mistakes that are invisible in
 * a spreadsheet: a semicolon-separated export, a column nobody recognised, the
 * row where somebody typed a note into the password field.
 *
 * THE FILE IS READ IN THIS TAB AND POSTED AS TEXT. It is not uploaded to storage
 * and never touches disk on the server. On the password path those cells are
 * plaintext credentials, so they make exactly one trip — into the request that
 * encrypts them — and the response that comes back reports rows by NAME and
 * never echoes a value.
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, FileUp, Loader2, Upload } from 'lucide-react';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { FieldHint } from '../ui/field';

interface RowDetail {
  line: number;
  label: string;
  errors: string[];
}

interface ImportSummary {
  rows: number;
  valid: number;
  invalid: number;
  ignoredColumns: string[];
  fileErrors: string[];
  rows_detail: RowDetail[];
  committed: number;
}

/** 2 MiB, matching the server. Checked here so a 40MB file fails instantly. */
const MAX_BYTES = 2 * 1024 * 1024;

export function ImportDialog({
  organizationId,
  category,
  categoryLabel,
  templateHeader,
  hint,
  open,
  onOpenChange,
}: {
  organizationId: string;
  category: string;
  categoryLabel: string;
  /** The header line for the "download a template" link. */
  templateHeader: string;
  hint: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const reset = () => {
    setFilename(null);
    setCsv(null);
    setPreview(null);
    setError(null);
    setDone(null);
    if (input.current) input.current.value = '';
  };

  async function send(commit: boolean): Promise<ImportSummary | null> {
    if (!csv) return null;
    const response = await fetch(`/api/organizations/${organizationId}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category, csv, commit }),
    });
    const payload = (await response.json().catch(() => null)) as
      | (ImportSummary & { error?: { message?: string; details?: ImportSummary } })
      | null;

    if (!response.ok) {
      const details = payload?.error?.details;
      if (details) setPreview(details);
      setError(payload?.error?.message ?? 'The import could not be read.');
      return null;
    }
    return payload as ImportSummary;
  }

  async function pick(file: File) {
    reset();
    if (file.size > MAX_BYTES) {
      setError(`That file is ${Math.round(file.size / 1024 / 1024)}MB. The limit is 2MB.`);
      return;
    }
    setFilename(file.name);
    setBusy(true);
    try {
      const text = await file.text();
      setCsv(text);
      // Preview immediately: making somebody press a second button before they
      // learn the file is unreadable is a step with no decision in it.
      const response = await fetch(`/api/organizations/${organizationId}/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category, csv: text, commit: false }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? 'That file could not be read.');
        return;
      }
      setPreview(payload as ImportSummary);
    } catch {
      setError('The file could not be read.');
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const result = await send(true);
      if (!result) return;
      setDone(result.committed);
      // The grid is a server component; this is what refills it.
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(templateHeader)}`;
  const ready = preview !== null && preview.invalid === 0 && preview.fileErrors.length === 0 &&
    preview.rows > 0 && done === null;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title={`Import ${categoryLabel.toLowerCase()}`}
      description="Nothing is written until you confirm, and a file with any bad row writes nothing at all."
      icon={Upload}
      size="lg"
    >
      <div className="space-y-4">
        {done !== null ? (
          <div className="flex items-start gap-2 rounded-md border border-ok/30 bg-ok/5 px-3 py-2.5 text-sm">
            <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
            <span className="text-ink">
              {done} {done === 1 ? 'record' : 'records'} imported into {categoryLabel}.
            </span>
          </div>
        ) : (
          <>
            <div>
              <input
                ref={input}
                type="file"
                accept=".csv,text/csv"
                className="block w-full text-sm text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-surface-sunken file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink hover:file:bg-border"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void pick(file);
                }}
              />
              <FieldHint>
                {hint}{' '}
                <a href={template} download={`helm-${category}-template.csv`} className="text-brand underline-offset-4 hover:underline">
                  Download a template
                </a>
                .
              </FieldHint>
            </div>

            {busy && !preview && (
              <p className="flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Reading {filename}…
              </p>
            )}

            {preview && (
              <div className="space-y-3 rounded-md border border-border bg-surface-sunken/50 p-3">
                <p className="text-sm text-ink">
                  <span className="font-medium">{preview.rows}</span> rows read
                  {preview.invalid > 0 && (
                    <>
                      {' · '}
                      <span className="font-medium text-danger">{preview.invalid} with problems</span>
                    </>
                  )}
                </p>

                {preview.ignoredColumns.length > 0 && (
                  <p className="text-xs text-ink-muted">
                    Columns not recognised and ignored:{' '}
                    <span className="text-ink">{preview.ignoredColumns.join(', ')}</span>
                  </p>
                )}

                {preview.fileErrors.length > 0 && (
                  <ul className="space-y-1 text-xs text-danger">
                    {preview.fileErrors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                )}

                {preview.rows_detail.length > 0 && (
                  <div className="max-h-48 overflow-y-auto rounded border border-border bg-surface-raised">
                    <table className="w-full text-xs">
                      <tbody>
                        {preview.rows_detail.map((row) => (
                          <tr key={row.line} className="border-b border-border last:border-0">
                            <td className="w-12 px-2 py-1.5 text-ink-faint">{row.line}</td>
                            <td className="px-2 py-1.5 font-medium text-ink">{row.label}</td>
                            <td className="px-2 py-1.5 text-danger">{row.errors.join('; ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {preview.invalid > 0 && (
                  <p className="flex items-start gap-2 text-xs text-ink-muted">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-sev-warning" aria-hidden />
                    Fix these rows in the file and choose it again. Importing part of a file
                    would leave this client half migrated.
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
          {done === null && (
            <Button variant="cta" size="sm" disabled={!ready || busy} onClick={() => void commit()}>
              {busy ? <Loader2 className="animate-spin" /> : <FileUp />}
              Import {preview?.valid ?? 0} {preview?.valid === 1 ? 'row' : 'rows'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
