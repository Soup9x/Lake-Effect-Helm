/**
 * A written document's dependencies (1130): the asset, document, contact,
 * site or diagram a page relies on.
 *
 * Every read resolves the target through its own table, under the caller's
 * RLS, and drops the link when the target does not come back. A link to an
 * internal-only record therefore disappears for a client user rather than
 * showing a row with no name, and the database's same-client guard means
 * there is nothing across clients to hide.
 */
import type { HelmTx } from '../db/client';
import { humanise } from '../ui/format';

export const DEPENDENCY_KINDS = ['asset', 'document', 'contact', 'site', 'diagram'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

const TARGET_COLUMN: Record<DependencyKind, string> = {
  asset: 'target_node_id',
  document: 'target_page_id',
  contact: 'target_contact_id',
  site: 'target_site_id',
  diagram: 'target_diagram_id',
};

export interface Dependency {
  id: string;
  kind: DependencyKind;
  targetId: string;
  title: string;
  /** What the target is, for the chip: "Server", "Document", "Contact". */
  label: string;
  href: string;
  archived: boolean;
  note: string | null;
}

/** A page that depends on something, seen from that something. */
export interface Dependent {
  id: string;
  pageId: string;
  title: string;
  href: string;
  archived: boolean;
  note: string | null;
}

interface RawDependency {
  id: string;
  kind: DependencyKind;
  target_id: string;
  title: string | null;
  node_type: string | null;
  archived: boolean | null;
  note: string | null;
}

function hrefFor(kind: DependencyKind, id: string): string {
  switch (kind) {
    case 'asset': return `/assets/${id}`;
    case 'document': return `/documents/${id}`;
    case 'contact': return `/contacts/${id}`;
    case 'site': return `/locations/${id}`;
    case 'diagram': return `/diagrams/${id}`;
  }
}

const KIND_LABEL: Record<DependencyKind, string> = {
  asset: 'Asset', document: 'Document', contact: 'Contact', site: 'Location', diagram: 'Diagram',
};

/** What this page depends on, grouped by kind and then by name. */
export async function listDependencies(tx: HelmTx, pageId: string): Promise<Dependency[]> {
  const rows = await tx<RawDependency[]>`
    SELECT l.id, l.note,
           CASE WHEN l.target_node_id IS NOT NULL THEN 'asset'
                WHEN l.target_page_id IS NOT NULL THEN 'document'
                WHEN l.target_contact_id IS NOT NULL THEN 'contact'
                WHEN l.target_site_id IS NOT NULL THEN 'site'
                ELSE 'diagram' END AS kind,
           coalesce(l.target_node_id, l.target_page_id, l.target_contact_id, l.target_site_id, l.target_diagram_id) AS target_id,
           coalesce(n.name, p.title, nullif(trim(c.first_name || ' ' || c.last_name), ''), s.name, d.name) AS title,
           n.node_type::text AS node_type,
           coalesce(n.archived_at, p.archived_at, c.archived_at, s.archived_at, d.archived_at) IS NOT NULL AS archived
    FROM document_page_link l
    LEFT JOIN asset_node n ON n.id = l.target_node_id
    LEFT JOIN document_page p ON p.id = l.target_page_id AND p.deleted_at IS NULL
    LEFT JOIN contact c ON c.id = l.target_contact_id
    LEFT JOIN site s ON s.id = l.target_site_id
    LEFT JOIN network_diagram d ON d.id = l.target_diagram_id
    WHERE l.page_id = ${pageId}::uuid
    LIMIT 500
  `;
  const order = new Map(DEPENDENCY_KINDS.map((k, i) => [k, i]));
  return rows
    .filter((r): r is RawDependency & { title: string } => r.title !== null)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      targetId: r.target_id,
      title: r.title,
      label: r.kind === 'asset' && r.node_type ? humanise(r.node_type) : KIND_LABEL[r.kind],
      href: hrefFor(r.kind, r.target_id),
      archived: r.archived === true,
      note: r.note,
    }))
    .sort((a, b) => (order.get(a.kind)! - order.get(b.kind)!) || a.title.localeCompare(b.title));
}

/** The documents that depend on a record: an asset, a contact, a site, a diagram or another page. */
export async function listDependents(tx: HelmTx, kind: DependencyKind, targetId: string): Promise<Dependent[]> {
  const rows = await tx<{ id: string; page_id: string; title: string; archived: boolean; note: string | null }[]>`
    SELECT l.id, p.id AS page_id, p.title, p.archived_at IS NOT NULL AS archived, l.note
    FROM document_page_link l
    JOIN document_page p ON p.id = l.page_id AND p.deleted_at IS NULL
    WHERE ${tx.unsafe(TARGET_COLUMN[kind])} = ${targetId}::uuid
    ORDER BY p.archived_at IS NOT NULL, lower(p.title)
    LIMIT 500
  `;
  return rows.map((r) => ({
    id: r.id, pageId: r.page_id, title: r.title, href: `/documents/${r.page_id}`, archived: r.archived, note: r.note,
  }));
}

export class DependencyError extends Error {
  constructor(readonly code: 'not_found' | 'other_client' | 'duplicate' | 'self', message: string) {
    super(message);
  }
}

/** Link a page to a record. Returns the link's id. */
export async function addDependency(
  tx: HelmTx,
  tenantId: string,
  actorId: string,
  input: { pageId: string; kind: DependencyKind; targetId: string; note?: string | undefined },
): Promise<string> {
  if (input.kind === 'document' && input.targetId === input.pageId) {
    throw new DependencyError('self', 'a document cannot depend on itself');
  }
  try {
    // organization_id is overwritten by the guard trigger from the page; the
    // placeholder here only satisfies NOT NULL until it does.
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO document_page_link (tenant_id, organization_id, page_id, ${tx.unsafe(TARGET_COLUMN[input.kind])}, note, created_by)
      SELECT ${tenantId}::uuid, p.organization_id, p.id, ${input.targetId}::uuid, ${input.note ?? null}, ${actorId}::uuid
      FROM document_page p WHERE p.id = ${input.pageId}::uuid AND p.deleted_at IS NULL
      RETURNING id
    `;
    if (!row) throw new DependencyError('not_found', 'no such document');
    return row.id;
  } catch (error) {
    if (error instanceof DependencyError) throw error;
    const code = (error as { code?: string }).code;
    if (code === '23505') throw new DependencyError('duplicate', 'this document already depends on that');
    if (code === '23514') throw new DependencyError('other_client', 'a document can only depend on records of the same client');
    if (code === '23503') throw new DependencyError('not_found', 'no such record to link to');
    throw error;
  }
}

/** Remove one of a page's dependencies. False when there was no such link. */
export async function removeDependency(tx: HelmTx, pageId: string, linkId: string): Promise<boolean> {
  const rows = await tx`
    DELETE FROM document_page_link WHERE id = ${linkId}::uuid AND page_id = ${pageId}::uuid RETURNING id
  `;
  return rows.length > 0;
}
