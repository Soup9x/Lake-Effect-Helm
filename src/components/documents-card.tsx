'use client';

/**
 * A client's documents: a card on the client page, a file browser in a modal.
 *
 * THE SAME SHAPE AS EVERY OTHER SECTION. Sites, contacts, assets, credentials
 * and expiries are all a small card carrying a count and a preview, opening
 * into a modal. Documents follow that rather than adding a sixth inline list to
 * a page that was deliberately shrunk.
 *
 * WHY THIS IS NOT SectionBrowser. That component filters a flat list, and every
 * one of its five callers has one. A folder tree is navigation, not filtering:
 * the questions are "what is in here", "how did I get here" and "where can this
 * move to", none of which a search box answers. Reusing it would have meant
 * bending it into something with a current-location state that its other five
 * callers would carry around unused.
 *
 * EVERY DECISION IS THE SERVER'S. This component shows what it was given and
 * posts what was clicked:
 *
 *   which folders and documents exist at all — RLS, so an internal-only
 *   subtree is not "hidden by the UI", it never arrives;
 *   whether a name is free — a unique index, surfaced as a 409;
 *   whether a folder may be deleted — both foreign keys are ON DELETE
 *   RESTRICT, and the trigger's message names what is in the way;
 *   what is_internal_only ends up as — a trigger, which forces it true
 *   under an internal-only parent whatever the checkbox said.
 *
 * The tree arithmetic — nesting, breadcrumbs, which moves are legal — is in
 * src/lib/ui/documents.ts, tested there without a DOM.
 */
import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label, Select } from './ui/field';
import { Modal } from './ui/modal';
import { Badge } from './ui/badge';
import { EmptyState } from './app-shell';
import { cn } from '@/lib/ui/cn';
import {
  breadcrumbs,
  buildTree,
  canMoveInto,
  childFolders,
  documentsIn,
  formatBytes,
  isDeletable,
  type DocumentRow,
  type FolderRow,
  type FolderTreeNode,
} from '@/lib/ui/documents';

type Pending =
  | { kind: 'folder-rename'; id: string; value: string }
  | { kind: 'folder-move'; id: string; value: string }
  | { kind: 'document-rename'; id: string; value: string }
  | { kind: 'document-move'; id: string; value: string }
  | null;

export function DocumentsCard({
  organizationId,
  folders,
  documents,
  canWrite,
  canDelete,
  maxBytes,
}: {
  organizationId: string;
  folders: FolderRow[];
  documents: DocumentRow[];
  canWrite: boolean;
  canDelete: boolean;
  maxBytes: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [internalNext, setInternalNext] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const tree = useMemo(() => buildTree(folders), [folders]);
  const trail = useMemo(() => breadcrumbs(folders, current), [folders, current]);
  const subfolders = useMemo(() => childFolders(folders, current), [folders, current]);
  const files = useMemo(
    () => documentsIn(documents, current, { includeArchived: showArchived }),
    [documents, current, showArchived],
  );
  const live = useMemo(() => documents.filter((d) => !d.archived), [documents]);

  /** One place that talks to the API, so one place that reports a refusal. */
  async function send(url: string, init: RequestInit): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? `That did not work (${response.status}).`);
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError('The request failed. Check your connection and retry.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const patchFolder = (id: string, body: Record<string, unknown>) =>
    send(`/api/document-folders/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const patchDocument = (id: string, body: Record<string, unknown>) =>
    send(`/api/documents/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function createFolder(name: string) {
    const ok = await send('/api/document-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        parentId: current,
        name,
        isInternalOnly: internalNext,
      }),
    });
    if (ok) setNewFolder(null);
  }

  async function upload(file: File) {
    if (file.size > maxBytes) {
      setError(`${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(maxBytes)}.`);
      return;
    }
    const form = new FormData();
    form.set('file', file);
    form.set('organizationId', organizationId);
    if (current) form.set('folderId', current);
    form.set('isInternalOnly', String(internalNext));
    await send('/api/documents', { method: 'POST', body: form });
  }

  async function deleteFolder(id: string) {
    const ok = await send(`/api/document-folders/${id}`, { method: 'DELETE' });
    if (ok && current === id) setCurrent(trail[trail.length - 2]?.id ?? null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderOpen className="size-4 text-ink-faint" aria-hidden /> Documents
          <Badge tone="neutral">{live.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {live.length === 0 ? (
          <p className="text-sm text-ink-muted">No documents yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {live.slice(0, 4).map((doc) => (
              <li key={doc.id} className="flex items-center gap-2 truncate text-ink-muted">
                <FileIcon className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                <span className="truncate">{doc.filename}</span>
                {doc.isInternalOnly && <EyeOff className="size-3 shrink-0 text-warning" aria-hidden />}
              </li>
            ))}
          </ul>
        )}
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Browse {folders.length > 0 && `${folders.length} folder${folders.length === 1 ? '' : 's'}`}
          <ChevronRight aria-hidden />
        </Button>
      </CardContent>

      <Modal
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setError(null);
            setPending(null);
            setNewFolder(null);
          }
        }}
        title="Documents"
        icon={FolderOpen}
        size="lg"
        description="Files kept against this client, in folders. Internal-only items are never visible to the client's own users."
      >
        <div className="space-y-3">
          {/* Breadcrumbs: where you are, and every step back. */}
          <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
            <button
              type="button"
              onClick={() => setCurrent(null)}
              className={cn(
                'rounded px-1.5 py-0.5 hover:bg-surface-sunken',
                current === null ? 'font-medium text-ink' : 'text-ink-muted',
              )}
            >
              Documents
            </button>
            {trail.map((folder) => (
              <span key={folder.id} className="flex items-center gap-1">
                <ChevronRight className="size-3 text-ink-faint" aria-hidden />
                <button
                  type="button"
                  onClick={() => setCurrent(folder.id)}
                  className={cn(
                    'rounded px-1.5 py-0.5 hover:bg-surface-sunken',
                    current === folder.id ? 'font-medium text-ink' : 'text-ink-muted',
                  )}
                >
                  {folder.name}
                </button>
              </span>
            ))}
          </nav>

          {canWrite && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-sunken p-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setNewFolder('')}
                disabled={busy}
              >
                <FolderPlus aria-hidden /> New folder
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
              >
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
                Upload
              </Button>
              <input
                ref={fileInput}
                type="file"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // Cleared so the same file can be chosen twice in a row —
                  // otherwise a failed upload cannot be retried without
                  // picking something else first.
                  event.target.value = '';
                  if (file) void upload(file);
                }}
              />
              {/*
                The same checkbox as the asset form, in the same words, applied
                to whatever is created next. A folder marked internal makes
                everything put into it internal too, so this is the one control
                that has to be set BEFORE rather than after.
              */}
              <label className="ml-auto flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={internalNext}
                  onChange={(event) => setInternalNext(event.target.checked)}
                  className="size-4 rounded border-border-strong"
                />
                Internal only
              </label>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-[minmax(0,13rem)_1fr]">
            {/* The tree. Indented, clickable, and the whole client at once. */}
            <div className="max-h-80 overflow-y-auto rounded-md border border-border p-1">
              <TreeButton
                label="Documents"
                depth={0}
                active={current === null}
                onClick={() => setCurrent(null)}
              />
              {tree.map((node) => (
                <TreeBranch key={node.id} node={node} current={current} onSelect={setCurrent} />
              ))}
            </div>

            <div className="max-h-80 space-y-1 overflow-y-auto">
              {subfolders.length === 0 && files.length === 0 ? (
                <EmptyState
                  title="This folder is empty."
                  description={canWrite ? 'Upload a file or create a folder inside it.' : undefined}
                />
              ) : null}

              {subfolders.map((folder) => {
                const deletable = isDeletable(folders, documents, folder.id);
                return (
                  <div
                    key={folder.id}
                    className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm"
                  >
                    <button
                      type="button"
                      onClick={() => setCurrent(folder.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <Folder className="size-4 shrink-0 text-ink-faint" aria-hidden />
                      <span className="truncate font-medium text-ink">{folder.name}</span>
                      {folder.isInternalOnly && <Badge tone="warning">Internal</Badge>}
                    </button>
                    {canWrite && (
                      <RowActions>
                        <IconAction
                          label={`Rename ${folder.name}`}
                          icon={Pencil}
                          disabled={busy}
                          onClick={() =>
                            setPending({ kind: 'folder-rename', id: folder.id, value: folder.name })
                          }
                        />
                        <IconAction
                          label={`Move ${folder.name}`}
                          icon={FolderOpen}
                          disabled={busy}
                          onClick={() =>
                            setPending({
                              kind: 'folder-move',
                              id: folder.id,
                              value: folder.parentId ?? '',
                            })
                          }
                        />
                        <IconAction
                          label={
                            folder.isInternalOnly
                              ? `Make ${folder.name} client-visible`
                              : `Make ${folder.name} internal only`
                          }
                          icon={folder.isInternalOnly ? EyeOff : Eye}
                          disabled={busy}
                          onClick={() =>
                            void patchFolder(folder.id, { isInternalOnly: !folder.isInternalOnly })
                          }
                        />
                        <IconAction
                          label={
                            deletable
                              ? `Delete ${folder.name}`
                              : `${folder.name} still has contents`
                          }
                          icon={Trash2}
                          danger
                          disabled={busy || !deletable}
                          onClick={() => void deleteFolder(folder.id)}
                        />
                      </RowActions>
                    )}
                  </div>
                );
              })}

              {files.map((doc) => (
                <div
                  key={doc.id}
                  className={cn(
                    'flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm',
                    doc.archived ? 'border-dashed border-border text-ink-faint' : 'border-border',
                  )}
                >
                  <FileIcon className="size-4 shrink-0 text-ink-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    <span className={cn('font-medium', doc.archived ? 'text-ink-muted' : 'text-ink')}>
                      {doc.filename}
                    </span>
                    {/*
                      Who put this here, which is the question a second
                      technician asks about a file they did not upload. The
                      page joins app_user for it, and a column fetched for
                      nothing is a column nobody notices is wrong.
                    */}
                    <span className="ml-2 text-xs text-ink-faint">
                      {formatBytes(doc.byteSize)}
                      {doc.uploadedBy && ` · ${doc.uploadedBy}`}
                    </span>
                  </span>
                  {doc.isInternalOnly && <Badge tone="warning">Internal</Badge>}
                  {doc.archived && <Badge tone="neutral">Archived</Badge>}
                  <RowActions>
                    <a
                      href={`/api/documents/${doc.id}/download`}
                      // The server sends Content-Disposition: attachment, so
                      // this never navigates the tab; `download` only supplies
                      // a fallback name.
                      download={doc.filename}
                      title={`Download ${doc.filename}`}
                      className="rounded p-1 text-ink-muted hover:bg-surface-sunken hover:text-ink"
                    >
                      <Download className="size-3.5" aria-hidden />
                      <span className="sr-only">Download {doc.filename}</span>
                    </a>
                    {canWrite && (
                      <>
                        <IconAction
                          label={`Rename ${doc.filename}`}
                          icon={Pencil}
                          disabled={busy}
                          onClick={() =>
                            setPending({
                              kind: 'document-rename',
                              id: doc.id,
                              value: doc.filename,
                            })
                          }
                        />
                        <IconAction
                          label={`Move ${doc.filename}`}
                          icon={FolderOpen}
                          disabled={busy}
                          onClick={() =>
                            setPending({
                              kind: 'document-move',
                              id: doc.id,
                              value: doc.folderId ?? '',
                            })
                          }
                        />
                        <IconAction
                          label={
                            doc.isInternalOnly
                              ? `Make ${doc.filename} client-visible`
                              : `Make ${doc.filename} internal only`
                          }
                          icon={doc.isInternalOnly ? EyeOff : Eye}
                          disabled={busy}
                          onClick={() =>
                            void patchDocument(doc.id, { isInternalOnly: !doc.isInternalOnly })
                          }
                        />
                        <IconAction
                          label={doc.archived ? `Restore ${doc.filename}` : `Archive ${doc.filename}`}
                          icon={doc.archived ? Undo2 : Trash2}
                          disabled={busy}
                          onClick={() => void patchDocument(doc.id, { archived: !doc.archived })}
                        />
                        {/*
                          Permanent deletion only appears on something already
                          archived, because the database refuses it otherwise —
                          helm.delete_document() enforces archive-first, the
                          same rail 0500 put in front of deleting a client.
                        */}
                        {canDelete && doc.archived && (
                          <IconAction
                            label={`Delete ${doc.filename} permanently`}
                            icon={Trash2}
                            danger
                            disabled={busy}
                            onClick={() =>
                              void send(`/api/documents/${doc.id}`, { method: 'DELETE' })
                            }
                          />
                        )}
                      </>
                    )}
                  </RowActions>
                </div>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
              className="size-3.5 rounded border-border-strong"
            />
            Show archived
          </label>
        </div>
      </Modal>

      {/* Create a folder. */}
      <Modal
        open={newFolder !== null}
        onOpenChange={(next) => !next && setNewFolder(null)}
        title="New folder"
        icon={FolderPlus}
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (newFolder?.trim()) void createFolder(newFolder.trim());
          }}
        >
          <div>
            <Label htmlFor="new-folder-name">Name</Label>
            <Input
              id="new-folder-name"
              value={newFolder ?? ''}
              autoFocus
              maxLength={120}
              onChange={(event) => setNewFolder(event.target.value)}
            />
            <FieldHint className="mt-1">
              Inside {trail[trail.length - 1]?.name ?? 'Documents'}.
              {internalNext && ' Marked internal only, along with everything put into it.'}
            </FieldHint>
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setNewFolder(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !newFolder?.trim()}>
              {busy && <Loader2 className="animate-spin" aria-hidden />} Create
            </Button>
          </div>
        </form>
      </Modal>

      {/* Rename or move, for a folder or a document. */}
      <Modal
        open={pending !== null}
        onOpenChange={(next) => !next && setPending(null)}
        title={
          pending?.kind.endsWith('rename')
            ? 'Rename'
            : pending
              ? 'Move'
              : ''
        }
        icon={pending?.kind.endsWith('rename') ? Pencil : FolderOpen}
      >
        {pending && (
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              const target = pending.value === '' ? null : pending.value;
              const ok =
                pending.kind === 'folder-rename'
                  ? await patchFolder(pending.id, { name: pending.value.trim() })
                  : pending.kind === 'folder-move'
                    ? await patchFolder(pending.id, { parentId: target })
                    : pending.kind === 'document-rename'
                      ? await patchDocument(pending.id, { filename: pending.value.trim() })
                      : await patchDocument(pending.id, { folderId: target });
              if (ok) setPending(null);
            }}
          >
            {pending.kind.endsWith('rename') ? (
              <div>
                <Label htmlFor="pending-name">Name</Label>
                <Input
                  id="pending-name"
                  value={pending.value}
                  autoFocus
                  maxLength={pending.kind === 'folder-rename' ? 120 : 200}
                  onChange={(event) => setPending({ ...pending, value: event.target.value })}
                />
              </div>
            ) : (
              <div>
                <Label htmlFor="pending-folder">Destination</Label>
                <Select
                  id="pending-folder"
                  value={pending.value}
                  onChange={(event) => setPending({ ...pending, value: event.target.value })}
                >
                  <option value="">Documents (top level)</option>
                  {folders
                    .filter(
                      (folder) =>
                        pending.kind !== 'folder-move' ||
                        canMoveInto(folders, pending.id, folder.id),
                    )
                    .map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {pathLabel(folders, folder.id)}
                      </option>
                    ))}
                </Select>
                <FieldHint className="mt-1">
                  A folder cannot be moved inside itself, so its own subtree is not listed.
                </FieldHint>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="animate-spin" aria-hidden />} Save
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </Card>
  );
}

function pathLabel(folders: readonly FolderRow[], folderId: string): string {
  return breadcrumbs(folders, folderId)
    .map((f) => f.name)
    .join(' / ');
}

function TreeBranch({
  node,
  current,
  onSelect,
}: {
  node: FolderTreeNode;
  current: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <TreeButton
        label={node.name}
        depth={node.depth + 1}
        active={current === node.id}
        internal={node.isInternalOnly}
        onClick={() => onSelect(node.id)}
      />
      {node.children.map((child) => (
        <TreeBranch key={child.id} node={child} current={current} onSelect={onSelect} />
      ))}
    </>
  );
}

function TreeButton({
  label,
  depth,
  active,
  internal,
  onClick,
}: {
  label: string;
  depth: number;
  active: boolean;
  internal?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ paddingLeft: `${depth * 0.75 + 0.375}rem` }}
      className={cn(
        'flex w-full items-center gap-1.5 truncate rounded px-1.5 py-1 text-left text-sm',
        active ? 'bg-surface-sunken font-medium text-ink' : 'text-ink-muted hover:bg-surface-sunken',
      )}
    >
      {depth === 0 ? (
        <FolderOpen className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <Folder className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="truncate">{label}</span>
      {internal && <EyeOff className="size-3 shrink-0 text-warning" aria-hidden />}
    </button>
  );
}

function RowActions({ children }: { children: React.ReactNode }) {
  return <div className="flex shrink-0 items-center gap-0.5">{children}</div>;
}

function IconAction({
  label,
  icon: Icon,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={cn(
        'rounded p-1 hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40',
        danger ? 'text-danger hover:text-danger' : 'text-ink-muted hover:text-ink',
      )}
    >
      <Icon className="size-3.5" />
      <span className="sr-only">{label}</span>
    </button>
  );
}
