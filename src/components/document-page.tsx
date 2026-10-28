'use client';

/**
 * A written document: read it, edit it, attach files to it (0810), say what
 * it depends on (1130), print it to PDF.
 *
 * LAID OUT AS IT GLUE LAYS ONE OUT: the document on the left, and on the
 * right the actions and the things that hang off it, attachments and
 * dependencies. Below lg the sidebar falls under the document.
 *
 * SAVE IS EXPLICIT. The body is kept in the editor until Save, and Save sends
 * the whole document, which the server versions; a draft lost to a closed tab
 * is a smaller harm than a half-typed paragraph autosaved over a runbook
 * somebody else is reading.
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, Download, File as FileIcon, FileDown, Loader2, Paperclip, Pencil, Trash2, Undo2, Upload, X } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input, Label } from './ui/field';
import { DocumentEditor, type JSONContent } from './document-editor';
import { DocumentDependencies } from './document-dependencies';
import { apiFetch, type ApiRequest } from '@/lib/ui/api';
import { formatBytes, type DocumentRow } from '@/lib/ui/documents';
import { formatDate, formatDateTime } from '@/lib/ui/format';
import type { Dependency, Dependent } from '@/lib/documents/links';

export interface PageProps {
  page: {
    id: string; organizationId: string; title: string; body: JSONContent; isInternalOnly: boolean;
    archived: boolean; version: number; updatedAt: string; updatedBy: string | null;
  };
  attachments: readonly DocumentRow[];
  dependencies: readonly Dependency[];
  dependents: readonly Dependent[];
  canWrite: boolean;
  canDelete: boolean;
  maxBytes: number;
}

export function DocumentPage({ page, attachments, dependencies, dependents, canWrite, canDelete, maxBytes }: PageProps) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const imageResolve = useRef<((url: string | null) => void) | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(page.title);
  const [body, setBody] = useState<JSONContent>(page.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(url: string, request: ApiRequest): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch(url, request);
      if (!result.ok) { setError(result.message); return false; }
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const ok = await send(`/api/document-pages/${page.id}`, { method: 'PATCH', json: { title: title.trim(), body } });
    if (ok) setEditing(false);
  }

  async function uploadFile(file: File): Promise<string | null> {
    if (file.size > maxBytes) {
      setError(`${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(maxBytes)}.`);
      return null;
    }
    const form = new FormData();
    form.set('file', file);
    form.set('organizationId', page.organizationId);
    form.set('pageId', page.id);
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ document: { id: string } }>('/api/documents', { method: 'POST', body: form });
      if (!result.ok) { setError(result.message); return null; }
      router.refresh();
      return `/api/documents/${result.value!.document.id}/download`;
    } finally {
      setBusy(false);
    }
  }

  /** The editor asks for an image; we ask for a file, upload it, hand back its URL. */
  function pickImage(): Promise<string | null> {
    return new Promise((resolve) => {
      imageResolve.current = resolve;
      fileInput.current?.click();
    });
  }

  const fileInputElement = (
    <input
      ref={fileInput}
      type="file"
      className="sr-only"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        const resolve = imageResolve.current;
        imageResolve.current = null;
        if (!file) { resolve?.(null); return; }
        void uploadFile(file).then((url) => resolve?.(url));
      }}
    />
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
      {fileInputElement}
      <Card className="min-w-0">
        <CardHeader className="flex-row items-start justify-between gap-2">
          {editing ? (
            <div className="min-w-0 flex-1">
              <Label htmlFor="page-title" className="sr-only">Title</Label>
              <Input id="page-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
            </div>
          ) : (
            <CardTitle className="flex flex-wrap items-center gap-2">
              {page.title}
              <Badge tone="neutral">v{page.version}</Badge>
              {page.isInternalOnly && <Badge tone="warning">Internal</Badge>}
              {page.archived && <Badge tone="neutral">Archived</Badge>}
            </CardTitle>
          )}
          {canWrite && (
            <div className="flex shrink-0 items-center gap-2">
              {editing ? (
                <>
                  <Button variant="primary" size="sm" disabled={busy || title.trim() === ''} onClick={() => void save()}>
                    {busy && <Loader2 className="animate-spin" aria-hidden />} Save
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy}
                          onClick={() => { setEditing(false); setTitle(page.title); setBody(page.body); setError(null); }}>
                    <X className="size-3.5" aria-hidden /> Cancel
                  </Button>
                </>
              ) : (
                !page.archived && (
                  <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                    <Pencil className="size-3.5" aria-hidden /> Edit
                  </Button>
                )
              )}
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <DocumentEditor
            key={editing ? 'edit' : `read-${page.version}`}
            content={editing ? body : page.body}
            editable={editing}
            onChange={setBody}
            onInsertImage={editing ? pickImage : undefined}
          />
          <p className="text-xs text-ink-faint">
            Last saved {formatDateTime(page.updatedAt)}{page.updatedBy && ` by ${page.updatedBy}`}
          </p>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </CardContent>
      </Card>

      {/* The sidebar, as IT Glue lays a document out: actions, then what hangs off the page. */}
      <aside className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="secondary" size="sm">
            <a href={`/print/documents/${page.id}`} target="_blank" rel="noopener"
               title="Opens a print view. Choose Save as PDF in the print dialog.">
              <FileDown className="size-3.5" aria-hidden /> PDF
            </a>
          </Button>
          {canWrite && !editing && (
            <Button variant="ghost" size="sm" disabled={busy}
                    onClick={() => void send(`/api/document-pages/${page.id}`, { method: 'PATCH', json: { archived: !page.archived } })}>
              {page.archived ? <Undo2 className="size-3.5" aria-hidden /> : <Archive className="size-3.5" aria-hidden />}
              {page.archived ? 'Restore' : 'Archive'}
            </Button>
          )}
          {canWrite && canDelete && page.archived && (
            <Button variant="ghost" size="sm" disabled={busy} className="text-danger"
                    onClick={() => {
                      if (window.confirm(`Delete "${page.title}" and its attachments permanently?`)) {
                        void send(`/api/document-pages/${page.id}`, { method: 'DELETE' }).then((ok) => {
                          if (ok) router.push(`/organizations/${page.organizationId}/documents`);
                        });
                      }
                    }}>
              <Trash2 className="size-3.5" aria-hidden /> Delete
            </Button>
          )}
        </div>

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Paperclip className="size-4 text-ink-faint" aria-hidden /> Attachments
              {attachments.length > 0 && <Badge tone="neutral">{attachments.length}</Badge>}
            </CardTitle>
            {canWrite && (
              <Button variant="secondary" size="sm" disabled={busy}
                      onClick={() => { imageResolve.current = null; fileInput.current?.click(); }}>
                <Upload aria-hidden /> Upload
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {attachments.length === 0 ? (
              <p className="text-sm text-ink-faint">
                Nothing attached. Files uploaded here, and images inserted into the text, are kept with the document.
              </p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {attachments.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 py-1.5">
                    <FileIcon className="size-4 shrink-0 text-ink-faint" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className={a.archived ? 'block truncate text-ink-faint line-through' : 'block truncate text-ink'}>
                        {a.filename}
                      </span>
                      <span className="block text-xs text-ink-faint">{formatBytes(a.byteSize)} · {formatDate(a.uploadedAt)}</span>
                    </span>
                    <a href={`/api/documents/${a.id}/download`} download={a.filename}
                       className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink">
                      <Download className="size-3.5" aria-hidden />
                      <span className="sr-only">Download {a.filename}</span>
                    </a>
                    {canWrite && (
                      <button type="button" disabled={busy}
                              onClick={() => void send(`/api/documents/${a.id}`, { method: 'PATCH', json: { archived: !a.archived } })}
                              className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink disabled:opacity-40">
                        {a.archived ? <Undo2 className="size-3.5" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
                        <span className="sr-only">{a.archived ? `Restore ${a.filename}` : `Archive ${a.filename}`}</span>
                      </button>
                    )}
                    {canDelete && a.archived && (
                      <button type="button" disabled={busy}
                              onClick={() => { if (window.confirm(`Delete ${a.filename} permanently?`)) void send(`/api/documents/${a.id}`, { method: 'DELETE' }); }}
                              className="rounded p-1 text-danger hover:bg-danger/10 disabled:opacity-40">
                        <Trash2 className="size-3.5" aria-hidden />
                        <span className="sr-only">Delete {a.filename} permanently</span>
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <DocumentDependencies
          pageId={page.id}
          organizationId={page.organizationId}
          dependencies={dependencies}
          dependents={dependents}
          canWrite={canWrite}
        />
      </aside>
    </div>
  );
}
