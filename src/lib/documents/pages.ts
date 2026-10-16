/**
 * Written documents (0810): read, create and correct a page.
 *
 * The body is the editor's JSON (a ProseMirror document). Its plain text is
 * derived here, on every write, and stored beside it for search; the client
 * is never trusted to supply it. Everything else — the folder's internal-only
 * flag landing on the page, one title per folder, who may see what — is the
 * database's, as it is for files.
 */
import { z } from 'zod';
import type { HelmTx } from '../db/client';

/** The editor's document shape, loosely: a tree of typed nodes with text leaves. */
export const bodySchema: z.ZodType<EditorNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1).max(40),
    attrs: z.record(z.string(), z.unknown()).optional(),
    marks: z.array(z.object({ type: z.string().min(1).max(40), attrs: z.record(z.string(), z.unknown()).optional() })).optional(),
    text: z.string().max(100_000).optional(),
    content: z.array(bodySchema).max(5000).optional(),
  }),
);
export interface EditorNode {
  type: string;
  attrs?: Record<string, unknown> | undefined;
  marks?: { type: string; attrs?: Record<string, unknown> | undefined }[] | undefined;
  text?: string | undefined;
  content?: EditorNode[] | undefined;
}

export const EMPTY_BODY: EditorNode = { type: 'doc', content: [] };

/** The body's words, one line per block, bounded: search indexes this. */
export function plainText(node: EditorNode, depth = 0): string {
  if (depth > 64) return '';
  if (node.text) return node.text;
  const parts = (node.content ?? []).map((c) => plainText(c, depth + 1));
  const block = ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'tableRow'].includes(node.type);
  return parts.join(block ? '' : '\n').slice(0, 200_000) + (block ? '\n' : '');
}

export interface PageRow {
  id: string;
  organizationId: string;
  folderId: string | null;
  title: string;
  isInternalOnly: boolean;
  archived: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface PageView extends PageRow {
  body: EditorNode;
  bodyText: string;
}

interface RawPage {
  id: string; organization_id: string; folder_id: string | null; title: string;
  is_internal_only: boolean; archived_at: Date | null; version: number;
  updated_at: Date; updated_by_name: string | null; body?: EditorNode; body_text?: string;
}

const toRow = (r: RawPage): PageRow => ({
  id: r.id, organizationId: r.organization_id, folderId: r.folder_id, title: r.title,
  isInternalOnly: r.is_internal_only, archived: r.archived_at !== null, version: r.version,
  updatedAt: r.updated_at.toISOString(), updatedBy: r.updated_by_name,
});

export async function listPages(tx: HelmTx, organizationId: string): Promise<PageRow[]> {
  const rows = await tx<RawPage[]>`
    SELECT p.id, p.organization_id, p.folder_id, p.title, p.is_internal_only, p.archived_at, p.version,
           p.updated_at, coalesce(u.name, u.email::text) AS updated_by_name
    FROM document_page p LEFT JOIN app_user u ON u.id = p.updated_by
    WHERE p.organization_id = ${organizationId}::uuid AND p.deleted_at IS NULL
    ORDER BY lower(p.title) LIMIT 2000
  `;
  return rows.map(toRow);
}

export async function readPage(tx: HelmTx, pageId: string): Promise<PageView | null> {
  const [r] = await tx<RawPage[]>`
    SELECT p.id, p.organization_id, p.folder_id, p.title, p.is_internal_only, p.archived_at, p.version,
           p.updated_at, coalesce(u.name, u.email::text) AS updated_by_name, p.body, p.body_text
    FROM document_page p LEFT JOIN app_user u ON u.id = p.updated_by
    WHERE p.id = ${pageId}::uuid AND p.deleted_at IS NULL
  `;
  if (!r) return null;
  return { ...toRow(r), body: r.body ?? EMPTY_BODY, bodyText: r.body_text ?? '' };
}

export async function createPage(
  tx: HelmTx,
  tenantId: string,
  actorId: string,
  input: { organizationId: string; folderId: string | null; title: string; body: EditorNode; isInternalOnly: boolean },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO document_page (
      tenant_id, organization_id, folder_id, title, body, body_text, is_internal_only, created_by, updated_by
    ) VALUES (
      ${tenantId}::uuid, ${input.organizationId}::uuid, ${input.folderId}::uuid, ${input.title},
      ${tx.json(input.body as never)}::jsonb, ${plainText(input.body)}, ${input.isInternalOnly},
      ${actorId}::uuid, ${actorId}::uuid
    )
    RETURNING id
  `;
  if (!row) throw new Error('the document could not be created');
  return row.id;
}

export interface PagePatch {
  title?: string | undefined;
  body?: EditorNode | undefined;
  folderId?: string | null | undefined;
  isInternalOnly?: boolean | undefined;
  archived?: boolean | undefined;
}

export async function updatePage(tx: HelmTx, actorId: string, pageId: string, patch: PagePatch): Promise<boolean> {
  const [row] = await tx<{ id: string }[]>`
    UPDATE document_page SET
      title            = coalesce(${patch.title ?? null}, title),
      body             = ${patch.body === undefined ? tx`body` : tx`${tx.json(patch.body as never)}::jsonb`},
      body_text        = ${patch.body === undefined ? tx`body_text` : plainText(patch.body)},
      version          = ${patch.body === undefined ? tx`version` : tx`version + 1`},
      folder_id        = ${patch.folderId === undefined ? tx`folder_id` : tx`${patch.folderId}::uuid`},
      is_internal_only = coalesce(${patch.isInternalOnly ?? null}, is_internal_only),
      archived_at      = ${
        patch.archived === undefined ? tx`archived_at` : patch.archived ? tx`coalesce(archived_at, now())` : null
      },
      updated_by       = ${actorId}::uuid
    WHERE id = ${pageId}::uuid AND deleted_at IS NULL
    RETURNING id
  `;
  return row !== undefined;
}
