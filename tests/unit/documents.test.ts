/**
 * The folder tree, without a browser.
 *
 * Everything the documents modal does between clicks is here: nesting, the
 * breadcrumb trail, which folders a move may target, and whether a folder is
 * empty enough to delete. The component renders these answers; getting one of
 * them wrong is a wrong menu or a delete button that promises something the
 * database then refuses.
 */
import { describe, expect, it } from 'vitest';
import {
  breadcrumbs,
  buildTree,
  canMoveInto,
  childFolders,
  documentsIn,
  folderContents,
  formatBytes,
  isDeletable,
  subtreeIds,
  type DocumentRow,
  type FolderRow,
} from '../../src/lib/ui/documents';

const folder = (id: string, name: string, parentId: string | null = null, internal = false): FolderRow => ({
  id,
  name,
  parentId,
  isInternalOnly: internal,
});

const doc = (
  id: string,
  filename: string,
  folderId: string | null = null,
  extra: Partial<DocumentRow> = {},
): DocumentRow => ({
  id,
  folderId,
  filename,
  contentType: 'application/pdf',
  byteSize: 1024,
  isInternalOnly: false,
  archived: false,
  uploadedAt: '2026-09-21T00:00:00.000Z',
  uploadedBy: 'A Technician',
  ...extra,
});

/*
 *  Contracts
 *    2026
 *      Signed
 *  Onboarding
 */
const FOLDERS: FolderRow[] = [
  folder('contracts', 'Contracts'),
  folder('y2026', '2026', 'contracts'),
  folder('signed', 'Signed', 'y2026'),
  folder('onboarding', 'Onboarding'),
];

describe('buildTree', () => {
  it('nests and sorts by name at every level', () => {
    const tree = buildTree([...FOLDERS, folder('archive', 'Archive')]);

    expect(tree.map((n) => n.name)).toEqual(['Archive', 'Contracts', 'Onboarding']);
    expect(tree[1]!.children.map((n) => n.name)).toEqual(['2026']);
    expect(tree[1]!.children[0]!.children.map((n) => n.name)).toEqual(['Signed']);
  });

  it('records depth, which is what the indentation reads', () => {
    const tree = buildTree(FOLDERS);
    expect(tree[0]!.depth).toBe(0);
    expect(tree[0]!.children[0]!.depth).toBe(1);
    expect(tree[0]!.children[0]!.children[0]!.depth).toBe(2);
  });

  it('shows a folder whose parent is missing rather than losing its subtree', () => {
    // Should not arise — internal-only is inherited, so a folder and its parent
    // are visible or hidden together — but a silently dropped subtree looks
    // exactly like documents that have been deleted.
    const tree = buildTree([folder('orphan', 'Orphan', 'gone')]);
    expect(tree.map((n) => n.name)).toEqual(['Orphan']);
  });

  it('is case-insensitive about ordering, the way a file listing is', () => {
    const tree = buildTree([folder('a', 'zebra'), folder('b', 'Apple')]);
    expect(tree.map((n) => n.name)).toEqual(['Apple', 'zebra']);
  });
});

describe('breadcrumbs', () => {
  it('runs from the top level down to the folder', () => {
    expect(breadcrumbs(FOLDERS, 'signed').map((f) => f.name)).toEqual(['Contracts', '2026', 'Signed']);
  });

  it('is empty at the root of the tree', () => {
    expect(breadcrumbs(FOLDERS, null)).toEqual([]);
  });

  it('terminates on a cycle instead of hanging the tab', () => {
    // The database forbids this outright. If one ever existed, rendering the
    // wrong path beats locking the browser.
    const cyclic = [folder('a', 'A', 'b'), folder('b', 'B', 'a')];
    expect(breadcrumbs(cyclic, 'a').length).toBeLessThanOrEqual(64);
  });
});

describe('listing a folder', () => {
  const DOCS = [
    doc('d1', 'beta.pdf', 'contracts'),
    doc('d2', 'Alpha.pdf', 'contracts'),
    doc('d3', 'gone.pdf', 'contracts', { archived: true }),
    doc('d4', 'root.pdf', null),
  ];

  it('returns the direct children only', () => {
    expect(childFolders(FOLDERS, 'contracts').map((f) => f.name)).toEqual(['2026']);
    expect(childFolders(FOLDERS, null).map((f) => f.name)).toEqual(['Contracts', 'Onboarding']);
  });

  it('hides archived documents by default and sorts case-insensitively', () => {
    expect(documentsIn(DOCS, 'contracts').map((d) => d.filename)).toEqual(['Alpha.pdf', 'beta.pdf']);
  });

  it('shows them when asked', () => {
    expect(documentsIn(DOCS, 'contracts', { includeArchived: true }).map((d) => d.filename)).toEqual([
      'Alpha.pdf',
      'beta.pdf',
      'gone.pdf',
    ]);
  });

  it('treats null as the top level, not as "every folder"', () => {
    expect(documentsIn(DOCS, null).map((d) => d.filename)).toEqual(['root.pdf']);
  });
});

describe('moving a folder', () => {
  it('collects a subtree including the folder itself', () => {
    expect([...subtreeIds(FOLDERS, 'contracts')].sort()).toEqual(['contracts', 'signed', 'y2026']);
  });

  it('refuses itself and anything beneath it', () => {
    expect(canMoveInto(FOLDERS, 'contracts', 'contracts')).toBe(false);
    expect(canMoveInto(FOLDERS, 'contracts', 'y2026')).toBe(false);
    expect(canMoveInto(FOLDERS, 'contracts', 'signed')).toBe(false);
  });

  it('allows a sibling, an unrelated branch, and the top level', () => {
    expect(canMoveInto(FOLDERS, 'contracts', 'onboarding')).toBe(true);
    expect(canMoveInto(FOLDERS, 'signed', 'onboarding')).toBe(true);
    expect(canMoveInto(FOLDERS, 'contracts', null)).toBe(true);
  });
});

describe('deleting a folder', () => {
  it('is offered only when nothing at all is left in it', () => {
    const docs = [doc('d1', 'x.pdf', 'signed')];

    expect(isDeletable(FOLDERS, docs, 'contracts')).toBe(false); // has a subfolder
    expect(isDeletable(FOLDERS, docs, 'signed')).toBe(false); // has a document
    expect(isDeletable(FOLDERS, docs, 'onboarding')).toBe(true);
  });

  it('counts an ARCHIVED document as contents, because the database does', () => {
    // This is the case that would otherwise offer a delete the server refuses:
    // an archived file is still in its folder and still holds it open.
    const docs = [doc('d1', 'old.pdf', 'onboarding', { archived: true })];

    expect(isDeletable(FOLDERS, docs, 'onboarding')).toBe(false);
    expect(folderContents(FOLDERS, docs, 'onboarding').directDocuments).toBe(1);
  });

  it('reports what is beneath a folder, not just directly in it', () => {
    const docs = [doc('d1', 'a.pdf', 'signed'), doc('d2', 'b.pdf', 'y2026')];
    const counts = folderContents(FOLDERS, docs, 'contracts');

    expect(counts.directFolders).toBe(1);
    expect(counts.directDocuments).toBe(0);
    expect(counts.totalDocuments).toBe(2);
  });
});

describe('formatBytes', () => {
  it('reads the way a file listing does', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
