'use client';

/**
 * The Documents directory's + New: a written document, an uploaded file or a
 * folder, each created in the folder being looked at (0810).
 *
 * Until now the Documents category page had Import and nothing else: "no
 * create path at all", as the page said of itself. Files were uploaded from a
 * modal on the client page, and nothing could be written. This is the
 * directory's own toolbar.
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FilePlus2, FolderPlus, Loader2, Upload } from 'lucide-react';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { FieldHint, Input, Label } from '../ui/field';
import { apiFetch } from '@/lib/ui/api';
import { formatBytes } from '@/lib/ui/documents';

export function DocumentsActions({
  organizationId,
  folderId,
  maxBytes,
}: {
  organizationId: string;
  /** The folder being looked at; null at the top. */
  folderId: string | null;
  maxBytes: number;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<'document' | 'folder' | null>(null);
  const [name, setName] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setDialog(null); setName(''); setInternal(false); setError(null);
  }

  async function createDocument() {
    setBusy(true); setError(null);
    try {
      const result = await apiFetch<{ page: { id: string } }>('/api/document-pages', {
        json: { organizationId, folderId, title: name.trim(), isInternalOnly: internal },
      });
      if (!result.ok) { setError(result.message); return; }
      close();
      router.push(`/documents/${result.value!.page.id}`);
    } finally {
      setBusy(false);
    }
  }

  async function createFolder() {
    setBusy(true); setError(null);
    try {
      const result = await apiFetch('/api/document-folders', {
        json: { organizationId, parentId: folderId, name: name.trim(), isInternalOnly: internal },
      });
      if (!result.ok) { setError(result.message); return; }
      close();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    if (file.size > maxBytes) {
      setError(`${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(maxBytes)}.`);
      setDialog('folder'); // somewhere the error can be read
      return;
    }
    const form = new FormData();
    form.set('file', file);
    form.set('organizationId', organizationId);
    if (folderId) form.set('folderId', folderId);
    setBusy(true);
    try {
      const result = await apiFetch('/api/documents', { method: 'POST', body: form });
      if (!result.ok) { setError(result.message); setDialog('folder'); return; }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => setDialog('folder')}>
        <FolderPlus className="size-3.5" aria-hidden /> New folder
      </Button>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Upload className="size-3.5" aria-hidden />} Upload
      </Button>
      <Button variant="cta" size="sm" disabled={busy} onClick={() => setDialog('document')}>
        <FilePlus2 className="size-3.5" aria-hidden /> New document
      </Button>
      <input
        ref={fileInput}
        type="file"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }}
      />

      <Modal
        open={dialog !== null}
        onOpenChange={(next) => { if (!next) close(); }}
        title={dialog === 'document' ? 'New document' : 'New folder'}
        description={
          dialog === 'document'
            ? 'A document you write here: a runbook, how something is set up, the notes from a visit.'
            : 'A folder in this one.'
        }
        icon={dialog === 'document' ? FilePlus2 : FolderPlus}
      >
        <form
          onSubmit={(e) => { e.preventDefault(); void (dialog === 'document' ? createDocument() : createFolder()); }}
          className="space-y-4"
        >
          <div>
            <Label htmlFor="docs-new-name">{dialog === 'document' ? 'Title' : 'Name'}</Label>
            <Input id="docs-new-name" value={name} maxLength={200} required autoFocus onChange={(e) => setName(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={internal} className="size-3.5 rounded border-border-strong"
                   onChange={(e) => setInternal(e.target.checked)} />
            Internal only
          </label>
          <FieldHint>Inside an internal-only folder everything is internal-only, whatever this says.</FieldHint>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="ghost" size="sm" onClick={close} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="cta" size="sm" disabled={busy || name.trim() === ''}>
              {busy && <Loader2 className="animate-spin" />}
              {dialog === 'document' ? 'Create and open' : 'Create folder'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
