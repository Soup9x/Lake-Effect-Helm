'use client';

/**
 * The files attached to one asset: the signed contract, the circuit's LOA, a
 * photo of the rack, the licence certificate.
 *
 * NOT THE DOCUMENT TREE. A document lives in the client's folders and never
 * names an asset; an attachment names an asset and has no folder (0560's
 * constraint keeps the shapes apart, 0780 opened the doors to this one). The
 * same upload endpoint, encryption, download, archive rail and audit apply,
 * which is the point of reusing the table rather than adding a fourth store.
 *
 * Archive before delete, as everywhere else: helm.delete_document() refuses a
 * live row, so the permanent control only appears on an archived one.
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, File as FileIcon, Loader2, Paperclip, Trash2, Undo2, Upload } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { formatBytes, type DocumentRow } from '@/lib/ui/documents';
import { formatDate } from '@/lib/ui/format';
import { apiFetch, type ApiRequest } from '@/lib/ui/api';

export function NodeAttachmentsCard({
  nodeId,
  organizationId,
  attachments,
  canWrite,
  canDelete,
  maxBytes,
}: {
  nodeId: string;
  organizationId: string;
  attachments: readonly DocumentRow[];
  canWrite: boolean;
  canDelete: boolean;
  maxBytes: number;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const live = attachments.filter((a) => !a.archived);
  const shown = showArchived ? attachments : live;
  const archivedCount = attachments.length - live.length;

  async function send(url: string, request: ApiRequest): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch(url, request);
      if (!result.ok) {
        setError(result.message);
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    if (file.size > maxBytes) {
      setError(`${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(maxBytes)}.`);
      return;
    }
    const form = new FormData();
    form.set('file', file);
    form.set('organizationId', organizationId);
    form.set('nodeId', nodeId);
    await send('/api/documents', { method: 'POST', body: form });
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Paperclip className="size-4 text-ink-faint" aria-hidden /> Attachments
          {live.length > 0 && <Badge tone="neutral">{live.length}</Badge>}
        </CardTitle>
        {canWrite && (
          <>
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Reset so the same file can be chosen again after a refusal.
                event.target.value = '';
                if (file) void upload(file);
              }}
            />
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
              Upload
            </Button>
          </>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {shown.length === 0 ? (
          <p className="text-sm text-ink-faint">
            {canWrite ? 'Nothing attached. Upload a PDF, an image or any file that belongs with this record.' : 'Nothing attached.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                <FileIcon className="size-4 shrink-0 text-ink-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-ink">{a.filename}</span>
                {a.archived && <Badge tone="neutral">Archived</Badge>}
                <span className="text-xs text-ink-faint">
                  {formatBytes(a.byteSize)} · {formatDate(a.uploadedAt)}
                  {a.uploadedBy && ` · ${a.uploadedBy}`}
                </span>
                <a
                  href={`/api/documents/${a.id}/download`}
                  download={a.filename}
                  className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink"
                >
                  <Download className="size-3.5" aria-hidden />
                  <span className="sr-only">Download {a.filename}</span>
                </a>
                {canWrite && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void send(`/api/documents/${a.id}`, { method: 'PATCH', json: { archived: !a.archived } })}
                    className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink disabled:opacity-40"
                  >
                    {a.archived ? <Undo2 className="size-3.5" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
                    <span className="sr-only">{a.archived ? `Restore ${a.filename}` : `Archive ${a.filename}`}</span>
                  </button>
                )}
                {canDelete && a.archived && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Delete ${a.filename} permanently?`)) {
                        void send(`/api/documents/${a.id}`, { method: 'DELETE' });
                      }
                    }}
                    className="rounded p-1 text-danger hover:bg-danger/10 disabled:opacity-40"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                    <span className="sr-only">Delete {a.filename} permanently</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {archivedCount > 0 && (
          <label className="flex items-center gap-2 text-xs text-ink-faint">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show {archivedCount} archived
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}
