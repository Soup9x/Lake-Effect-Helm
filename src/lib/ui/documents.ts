/**
 * The folder tree, as arithmetic.
 *
 * The documents modal navigates a tree, and every question it asks — what is in
 * this folder, how did we get here, may this folder be dragged into that one —
 * is a pure function of two flat arrays. Keeping them here means they are
 * tested without a DOM, and it means the component is rendering rather than
 * deciding.
 *
 * The server hands down every folder and every document for the client in one
 * go. That is deliberate: this is metadata, a few hundred rows on a large
 * client, and fetching a page per folder would put a network round trip behind
 * every click in a modal that is meant to feel like a file browser.
 */

export interface FolderRow {
  id: string;
  parentId: string | null;
  name: string;
  isInternalOnly: boolean;
}

export interface DocumentRow {
  id: string;
  folderId: string | null;
  filename: string;
  contentType: string;
  byteSize: number;
  isInternalOnly: boolean;
  archived: boolean;
  uploadedAt: string;
  uploadedBy: string | null;
}

export interface FolderTreeNode extends FolderRow {
  depth: number;
  children: FolderTreeNode[];
}

/** Sort by name, the way a person reads a folder listing. */
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/**
 * Nest the flat rows.
 *
 * A row whose parent is not in the list is treated as top level rather than
 * dropped. That case should not arise — a folder and its parent are visible or
 * hidden together, because the internal-only flag is inherited downwards — but
 * silently losing a subtree would look like the documents had been deleted.
 */
export function buildTree(folders: readonly FolderRow[]): FolderTreeNode[] {
  const byId = new Map(folders.map((f) => [f.id, { ...f, depth: 0, children: [] as FolderTreeNode[] }]));
  const roots: FolderTreeNode[] = [];

  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const settle = (nodes: FolderTreeNode[], depth: number): FolderTreeNode[] => {
    nodes.sort(byName);
    for (const node of nodes) {
      node.depth = depth;
      settle(node.children, depth + 1);
    }
    return nodes;
  };

  return settle(roots, 0);
}

/** The path to a folder, top level first. Empty at the root of the tree. */
export function breadcrumbs(folders: readonly FolderRow[], folderId: string | null): FolderRow[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const trail: FolderRow[] = [];
  let cursor = folderId;
  // Bounded rather than `while (cursor)`: the database forbids a cycle, and a
  // tree that somehow had one should render wrong rather than hang the tab.
  for (let i = 0; cursor && i < 64; i += 1) {
    const node = byId.get(cursor);
    if (!node) break;
    trail.unshift(node);
    cursor = node.parentId;
  }
  return trail;
}

export function childFolders(folders: readonly FolderRow[], folderId: string | null): FolderRow[] {
  return folders.filter((f) => f.parentId === folderId).sort(byName);
}

export function documentsIn(
  documents: readonly DocumentRow[],
  folderId: string | null,
  options: { includeArchived?: boolean } = {},
): DocumentRow[] {
  return documents
    .filter((d) => d.folderId === folderId)
    .filter((d) => options.includeArchived || !d.archived)
    .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' }));
}

/** Every folder at or below this one. Includes the folder itself. */
export function subtreeIds(folders: readonly FolderRow[], folderId: string): Set<string> {
  const out = new Set<string>([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId && out.has(folder.parentId) && !out.has(folder.id)) {
        out.add(folder.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * May this folder be moved into that one?
 *
 * The database refuses a cycle outright, so this is about not offering the move
 * in the first place: a menu whose options mostly produce an error is worse
 * than a shorter menu. `null` is the top level and is always a valid target.
 */
export function canMoveInto(
  folders: readonly FolderRow[],
  folderId: string,
  targetId: string | null,
): boolean {
  if (targetId === null) return true;
  if (targetId === folderId) return false;
  return !subtreeIds(folders, folderId).has(targetId);
}

/** What a folder holds, counting everything beneath it. */
export function folderContents(
  folders: readonly FolderRow[],
  documents: readonly DocumentRow[],
  folderId: string,
): { directFolders: number; directDocuments: number; totalDocuments: number } {
  const subtree = subtreeIds(folders, folderId);
  return {
    directFolders: folders.filter((f) => f.parentId === folderId).length,
    // Archived documents count. They are still in the folder, and they are the
    // reason a delete that looks safe is refused.
    directDocuments: documents.filter((d) => d.folderId === folderId).length,
    totalDocuments: documents.filter((d) => d.folderId && subtree.has(d.folderId)).length,
  };
}

/** A folder can only be deleted when nothing at all is left in it. */
export function isDeletable(
  folders: readonly FolderRow[],
  documents: readonly DocumentRow[],
  folderId: string,
): boolean {
  const { directFolders, directDocuments } = folderContents(folders, documents, folderId);
  return directFolders === 0 && directDocuments === 0;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
