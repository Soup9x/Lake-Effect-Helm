import { notFound } from 'next/navigation';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { categoryBySlug } from '@/lib/nav/org-categories';
import { CategoryGrid, type CategoryRecord } from '@/components/shell/category-grid';
import { ViewHeader } from '@/components/shell/view-header';
import { TabNav } from '@/components/shell/tab-nav';
import { CategoryActions } from '@/components/shell/category-actions';
import { importSpecFor, templateFor } from '@/lib/import/specs';
import { isClientRole } from '@/lib/ui/roles';

export const dynamic = 'force-dynamic';

/**
 * One category of one client, as a grid.
 *
 * THIS IS THE SHAPE THE REDESIGN IS FOR. The organisation overview renders every
 * section at once as a column of cards, which is readable at four sites and six
 * contacts and stops being readable at eighty passwords — which is what a
 * technician actually has. One category at a time, full width and filterable, is
 * what a documentation tool is for. The overview page is untouched and is still
 * the client's landing view; this is where the drawer goes.
 *
 * ARCHIVED IS A SERVER FILTER, TEXT IS A CLIENT ONE. Archived rows are excluded
 * by a WHERE clause, because fetching them unconditionally so the browser could
 * hide them would send rows nobody asked for. Text matching runs on rows already
 * delivered, which costs no round trip. Both sit in the URL either way, so a
 * filtered view stays a link somebody can paste into a ticket.
 */
export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; category: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { organizationId, category: slug } = await params;
  const search = await searchParams;
  const category = categoryBySlug(slug);
  if (!category) notFound();

  const includeArchived = search.archived === '1';
  const identity = await getServerIdentity();

  const data = await withTenant(actorOf(identity), async (tx) => {
    const [org] = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM organization WHERE id = ${organizationId}::uuid
    `;
    if (!org) return null;

    // Authoritative, and the same number helm.reveal_secret compares against —
    // rather than mapping a role key to a rank in the browser.
    const [rank] = await tx<{ rank: number }[]>`SELECT helm.current_role_rank() AS rank`;
    const actorRoleRank = rank?.rank ?? 0;

    if (category.kind === 'node') {
      /*
       * One query serves every node category, credentials included.
       *
       * The credential LEFT JOIN is what makes a Passwords row useful — a
       * username to copy, whether a second factor exists — and costs nothing on
       * the categories that are not credentials, where both sides are NULL.
       * `totp_secret_id IS NOT NULL` rather than the id: the grid needs to know a
       * code can be generated, never which secret holds the seed.
       */
      const rows = await tx<{
        id: string; name: string; status: string;
        updated_at: Date; updated_by_name: string | null;
        username: string | null; url: string | null; has_totp: boolean;
        secret_label: string | null; is_internal_only: boolean;
        secret_id: string | null; sensitivity: string | null;
        requires_step_up: boolean | null; requires_reason: boolean | null;
        min_role_rank: number | null;
      }[]>`
        SELECT n.id, n.name, n.status::text,
               n.updated_at, u.name AS updated_by_name,
               c.username, c.url,
               c.totp_secret_id IS NOT NULL AS has_totp,
               m.label AS secret_label,
               n.is_internal_only,
               -- The access policy, for the permissions dialog. All five come
               -- from v_secret_metadata and are NULL on every category that is
               -- not a credential.
               m.id::text AS secret_id, m.sensitivity::text, m.requires_step_up,
               m.requires_reason, m.min_role_rank
        FROM asset_node n
        LEFT JOIN app_user u ON u.id = n.updated_by
        LEFT JOIN credential c ON c.id = n.id
        LEFT JOIN v_secret_metadata m ON m.id = c.secret_id
        WHERE n.organization_id = ${organizationId}::uuid
          AND n.node_type = ${category.source}::node_type
          ${includeArchived ? tx`` : tx`AND n.archived_at IS NULL`}
        ORDER BY n.name
        LIMIT 500
      `;
      const [totalRow] = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM asset_node
        WHERE organization_id = ${organizationId}::uuid
          AND node_type = ${category.source}::node_type
      `;
      return {
        org,
        actorRoleRank,
        total: Number(totalRow?.n ?? 0),
        records: rows.map<CategoryRecord>((r) => ({
          id: r.id,
          name: r.name,
          href: `/assets/${r.id}`,
          secondary: r.username,
          type: r.status,
          extra: r.secret_label,
          internalOnly: r.is_internal_only,
          hasTotp: r.has_totp,
          externalUrl: r.url,
          updatedAt: r.updated_at.toISOString(),
          updatedBy: r.updated_by_name,
          removeKind: 'node',
          permissions: {
            internalOnly: r.is_internal_only,
            ...(r.secret_id
              ? {
                  secret: {
                    id: r.secret_id,
                    sensitivity: (r.sensitivity ?? 'standard') as 'standard' | 'elevated' | 'critical',
                    requiresStepUp: r.requires_step_up ?? false,
                    requiresReason: r.requires_reason ?? false,
                    minRoleRank: r.min_role_rank ?? 40,
                  },
                }
              : {}),
          },
        })),
      };
    }

    if (category.source === 'contact') {
      const rows = await tx<{
        id: string; first_name: string; last_name: string | null; title: string | null;
        email: string | null; phone: string | null; is_primary: boolean; updated_at: Date;
      }[]>`
        SELECT id, first_name, last_name, title, email::text, phone, is_primary, updated_at
        FROM contact
        WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
        ORDER BY is_primary DESC, last_name NULLS LAST, first_name
      `;
      return {
        org,
        actorRoleRank,
        total: rows.length,
        records: rows.map<CategoryRecord>((r) => ({
          id: r.id,
          name: [r.first_name, r.last_name].filter(Boolean).join(' '),
          secondary: r.email,
          type: r.title,
          extra: r.phone,
          flagged: r.is_primary,
          updatedAt: r.updated_at.toISOString(),
          // No visibility flag on `contact`, so no permissions action.
          removeKind: 'contact',
        })),
      };
    }

    if (category.source === 'site') {
      const rows = await tx<{
        id: string; name: string; code: string | null; city: string | null;
        main_phone: string | null; is_primary: boolean; updated_at: Date;
      }[]>`
        SELECT id, name, code, city, main_phone, is_primary, updated_at
        FROM site
        WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
        ORDER BY is_primary DESC, name
      `;
      return {
        org,
        actorRoleRank,
        total: rows.length,
        records: rows.map<CategoryRecord>((r) => ({
          id: r.id,
          name: r.name,
          secondary: r.city,
          type: r.code,
          extra: r.main_phone,
          flagged: r.is_primary,
          updatedAt: r.updated_at.toISOString(),
          removeKind: 'site',
        })),
      };
    }

    /*
     * Documents: the one category with FOLDERS, and therefore the one that
     * exercises the grid's folder row. Top-level folders come back as their own
     * rows with a child count; loose documents follow them.
     */
    const [folders, docs, totalRows] = await Promise.all([
      tx<{ id: string; name: string; n: string }[]>`
        SELECT f.id, f.name, count(a.id)::text AS n
        FROM document_folder f
        LEFT JOIN attachment a
          ON a.folder_id = f.id AND a.is_document AND a.deleted_at IS NULL
        WHERE f.organization_id = ${organizationId}::uuid AND f.parent_id IS NULL
        GROUP BY f.id, f.name
        ORDER BY f.name
      `,
      /*
       * `uploaded_at`, not created_at: an attachment records when it ARRIVED,
       * which is the only timestamp it has. deleted_at and archived_at are both
       * respected — a soft-deleted document is gone, and an archived one appears
       * only when the toolbar asks for it.
       */
      tx<{
        id: string; filename: string; content_type: string; byte_size: number;
        uploaded_at: Date; uploaded_by_name: string | null; is_internal_only: boolean;
      }[]>`
        SELECT a.id, a.filename, a.content_type, a.byte_size, a.uploaded_at,
               u.name AS uploaded_by_name, a.is_internal_only
        FROM attachment a
        LEFT JOIN app_user u ON u.id = a.uploaded_by
        WHERE a.organization_id = ${organizationId}::uuid
          AND a.is_document AND a.folder_id IS NULL AND a.deleted_at IS NULL
          ${includeArchived ? tx`` : tx`AND a.archived_at IS NULL`}
        ORDER BY a.filename
        LIMIT 500
      `,
      tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM attachment
        WHERE organization_id = ${organizationId}::uuid
          AND is_document AND deleted_at IS NULL
      `,
    ]);

    return {
      org,
      actorRoleRank,
      total: Number(totalRows[0]?.n ?? 0),
      records: [
        ...folders.map<CategoryRecord>((f) => ({
          id: f.id,
          name: f.name,
          folder: {
            itemCount: Number(f.n),
            itemNoun: 'Document',
            href: `/organizations/${organizationId}/documents`,
          },
        })),
        ...docs.map<CategoryRecord>((d) => ({
          id: d.id,
          name: d.filename,
          href: `/api/documents/${d.id}/download`,
          secondary: d.content_type,
          extra: `${Math.max(1, Math.round(d.byte_size / 1024))} KB`,
          internalOnly: d.is_internal_only,
          updatedAt: d.uploaded_at.toISOString(),
          updatedBy: d.uploaded_by_name,
          removeKind: 'document',
          permissions: { internalOnly: d.is_internal_only },
        })),
      ],
    };
  });

  if (!data) notFound();

  /*
   * Sites for the create form's picker, read through RLS so it can only ever
   * offer sites this actor may already see. One extra query on a page that
   * already makes three, and only when the person can create anything.
   */
  const canWrite = !isClientRole(identity.roleKey);
  const sites = canWrite
    ? await withTenant(actorOf(identity), (tx) =>
        tx<{ id: string; name: string }[]>`
          SELECT id, name FROM site
          WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
          ORDER BY name
        `)
    : [];
  const base = `/organizations/${organizationId}`;

  /*
   * Shared / Personal exists only where Helm has a real distinction to draw.
   * Passwords do: a credential is either client-visible or MSP-internal. Adding
   * the tabs everywhere would be a control with one option on every other
   * category.
   */
  const importSpec = importSpecFor(category.slug);
  /*
   * SOPs are the one category with no create path: 'sop' is not in the assets
   * route's CREATABLE list, so there is nothing for + New to call. Documents are
   * created by uploading a file, which the documents page already does.
   */
  const canCreate = category.source !== 'sop' && category.source !== 'attachment';

  const tabs =
    category.slug === 'passwords'
      ? [
          { href: `${base}/passwords`, label: 'Shared' },
          { href: `${base}/passwords?mine=1`, label: 'Personal' },
        ]
      : [];

  /*
   * What the three flexible columns mean for THIS category. Without this every
   * grid called its second column "Username", which is right for passwords and
   * nonsense for documents, where that slot holds a content type.
   */
  const labels =
    category.source === 'contact'
      ? { secondary: 'Email', type: 'Title', extra: 'Phone' }
      : category.source === 'site'
        ? { secondary: 'City', type: 'Code', extra: 'Phone' }
        : category.source === 'attachment'
          ? { secondary: 'Content type', type: 'Status', extra: 'Size' }
          : category.source === 'credential'
            ? { secondary: 'Username', type: 'Status', extra: 'Vault entry' }
            : { secondary: 'Address', type: 'Status', extra: 'Detail' };

  return (
    <>
      <ViewHeader
        trail={[{ label: data.org.name, href: base }]}
        title={category.label}
        actions={
          canWrite ? (
            <CategoryActions
              organizationId={organizationId}
              category={category.slug}
              categoryLabel={category.label}
              /*
               * Only asset categories pin a node type. Contacts, locations and
               * passwords each have their own form, and documents and SOPs have
               * no create path at all — CategoryActions renders nothing for
               * those rather than a button that cannot work.
               */
              {...(category.kind === 'node' && category.source !== 'credential'
                ? { nodeType: category.source }
                : {})}
              {...(importSpec
                ? { importSpec: { templateHeader: templateFor(importSpec), hint: importSpec.hint } }
                : {})}
              sites={sites}
              canCreate={canCreate}
            />
          ) : null
        }
      />
      <TabNav
        tabs={tabs}
        activeHref={search.mine === '1' ? `${base}/passwords?mine=1` : `${base}/passwords`}
      />
      <CategoryGrid
        records={data.records}
        total={data.total}
        categoryLabel={category.label}
        canWrite={canWrite}
        labels={labels}
        actorRoleRank={data.actorRoleRank}
      />
    </>
  );
}
