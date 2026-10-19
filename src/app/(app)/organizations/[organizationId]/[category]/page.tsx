import { notFound } from 'next/navigation';
import { contactTags, type ContactFlags } from '@/lib/contacts/tags';
import { siteValuesFrom } from '@/lib/sites/values';
import { isUuid } from '@/lib/ids';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { categoryBySlug } from '@/lib/nav/org-categories';
import { CategoryGrid, type CategoryRecord } from '@/components/shell/category-grid';
import { ViewHeader } from '@/components/shell/view-header';
import { TabNav } from '@/components/shell/tab-nav';
import { CategoryActions } from '@/components/shell/category-actions';
import { DocumentsActions } from '@/components/shell/documents-actions';
import { maxUploadBytes } from '@/lib/documents/limits';
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
  if (!isUuid(organizationId)) notFound();
  const search = await searchParams;
  const category = categoryBySlug(slug);
  if (!category) notFound();

  const includeArchived = search.archived === '1';
  /*
   * WHICH SET OF RECORDS, and the tab labels changed to match what Helm can
   * actually express.
   *
   * These tabs said "Shared / Personal", borrowed from IT Glue, where Personal
   * means a vault only you can open. Helm has no such thing — no per-user
   * ownership, no personal vault, nothing in the schema that makes a record
   * private to one technician. Leaving the label would have been the worst kind
   * of wrong in a credential vault: somebody would reasonably read "Personal" as
   * "only I can see this" and file a client's domain admin password there.
   *
   * What Helm DOES have is is_internal_only, which 0390 enforces through RLS —
   * a client-side role does not see the row at all. That is a real and useful
   * split for an MSP ("what can this customer see?"), so the tabs now say what
   * they filter on.
   */
  const view = search.view === 'internal' ? 'internal' : search.view === 'shared' ? 'shared' : 'all';
  const identity = await getServerIdentity();

  let canDelete = false;
  const data = await withTenant(actorOf(identity), async (tx, session) => {
    const [org] = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM organization WHERE id = ${organizationId}::uuid
    `;
    if (!org) return null;
    // Offers Delete permanently on archived documents; the database decides.
    canDelete = session.permissions.includes('asset:delete');

    // Authoritative, and the same number helm.reveal_secret compares against —
    // rather than mapping a role key to a rank in the browser.
    const [rank] = await tx<{ rank: number }[]>`SELECT helm.current_role_rank() AS rank`;
    const actorRoleRank = rank?.rank ?? 0;

    if (category.source === 'device') {
      /*
       * Configurations, with the columns the reference list shows: status,
       * type, OS, primary IP, serial, warranty expiry and location (0800).
       * Its own query rather than a widening of the generic one below, which
       * joins credential metadata nothing here needs.
       */
      const rows = await tx<{
        id: string; name: string; status: string; updated_at: Date; updated_by_name: string | null;
        is_internal_only: boolean; device_type: string; operating_system: string | null;
        os_version: string | null; primary_ip: string | null; serial_number: string | null;
        warranty_expires_at: Date | null; site_name: string | null; archived: boolean;
      }[]>`
        SELECT n.id, n.name, n.status::text, n.updated_at, u.name AS updated_by_name, n.is_internal_only,
               n.archived_at IS NOT NULL AS archived,
               d.device_type::text, d.operating_system, d.os_version, host(d.primary_ip) AS primary_ip,
               d.serial_number, d.warranty_expires_at, s.name AS site_name
        FROM asset_node n
        JOIN device d ON d.id = n.id
        LEFT JOIN app_user u ON u.id = n.updated_by
        LEFT JOIN site s ON s.id = n.site_id
        WHERE n.organization_id = ${organizationId}::uuid AND n.node_type = 'device'
          ${includeArchived ? tx`` : tx`AND n.archived_at IS NULL`}
          ${view === 'all' ? tx`` : tx`AND n.is_internal_only = ${view === 'internal'}`}
        ORDER BY n.name
        LIMIT 500
      `;
      const [totalRow] = await tx<{ n: string; shared: string; internal: string }[]>`
        SELECT count(*)::text AS n,
               count(*) FILTER (WHERE NOT is_internal_only)::text AS shared,
               count(*) FILTER (WHERE is_internal_only)::text     AS internal
        FROM asset_node
        WHERE organization_id = ${organizationId}::uuid AND node_type = 'device'
          ${includeArchived ? tx`` : tx`AND archived_at IS NULL`}
      `;
      return {
        org,
        actorRoleRank,
        total: Number(totalRow?.n ?? 0),
        tabCounts: { shared: Number(totalRow?.shared ?? 0), internal: Number(totalRow?.internal ?? 0) },
        records: rows.map<CategoryRecord>((r) => ({
          id: r.id,
          name: r.name,
          href: `/assets/${r.id}`,
          secondary: r.device_type.replace(/_/g, ' '),
          type: r.status,
          extra: [r.operating_system, r.os_version].filter(Boolean).join(' ') || null,
          internalOnly: r.is_internal_only,
          updatedAt: r.updated_at.toISOString(),
          updatedBy: r.updated_by_name,
          removeKind: 'node',
          archived: r.archived,
          permissions: { internalOnly: r.is_internal_only },
          cells: {
            primaryIp: r.primary_ip,
            serial: r.serial_number,
            expires: r.warranty_expires_at ? r.warranty_expires_at.toISOString().slice(0, 10) : null,
            location: r.site_name,
          },
        })),
      };
    }

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
        min_role_rank: number | null; archived: boolean;
      }[]>`
        SELECT n.id, n.name, n.status::text, n.archived_at IS NOT NULL AS archived,
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
          ${view === 'all' ? tx`` : tx`AND n.is_internal_only = ${view === 'internal'}`}
        ORDER BY n.name
        LIMIT 500
      `;
      /*
       * Both tab counts and the grand total in one pass. FILTER rather than
       * three statements: the drawer already costs a query per page.
       *
       * It carries the SAME archived predicate as the list above, deliberately.
       * Count every row regardless and "Include archived" would read "12 of 9";
       * count only live rows and the archived view would read the same. The two
       * numbers in "X of Y" have to be drawn from one population to mean
       * anything, and the tab counts have to match what their tab will list.
       */
      const [totalRow] = await tx<{ n: string; shared: string; internal: string }[]>`
        SELECT count(*)::text AS n,
               count(*) FILTER (WHERE NOT is_internal_only)::text AS shared,
               count(*) FILTER (WHERE is_internal_only)::text     AS internal
        FROM asset_node
        WHERE organization_id = ${organizationId}::uuid
          AND node_type = ${category.source}::node_type
          ${includeArchived ? tx`` : tx`AND archived_at IS NULL`}
      `;
      return {
        org,
        actorRoleRank,
        total: Number(totalRow?.n ?? 0),
        tabCounts: {
          shared: Number(totalRow?.shared ?? 0),
          internal: Number(totalRow?.internal ?? 0),
        },
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
          archived: r.archived,
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
      const rows = await tx<({
        id: string; first_name: string; last_name: string | null; title: string | null;
        email: string | null; phone: string | null; updated_at: Date; archived: boolean;
      } & ContactFlags)[]>`
        SELECT id, first_name, last_name, title, email::text, phone, updated_at,
               is_primary, is_technical, is_billing, is_emergency, is_authorised,
               archived_at IS NOT NULL AS archived
        FROM contact
        WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
          ${includeArchived ? tx`` : tx`AND archived_at IS NULL`}
        ORDER BY is_primary DESC, last_name NULLS LAST, first_name
      `;
      return {
        org,
        actorRoleRank,
        total: rows.length,
        records: rows.map<CategoryRecord>((r) => ({
          id: r.id,
          name: [r.first_name, r.last_name].filter(Boolean).join(' '),
          // Each contact has a page of its own now; Edit stays a dialog.
          href: `/contacts/${r.id}`,
          // Primary · Technical · Billing — under the name, and matched by the
          // list's filter, so "technical" narrows to the technical people.
          subtext: contactTags(r).join(' · ') || null,
          archived: r.archived,
          secondary: r.email,
          type: r.title,
          extra: r.phone,
          flagged: r.is_primary,
          updatedAt: r.updated_at.toISOString(),
          // No visibility flag on `contact`, so no permissions action.
          removeKind: 'contact',
          editContact: { organizationId },
        })),
      };
    }

    if (category.source === 'site') {
      const rows = await tx<(Parameters<typeof siteValuesFrom>[0] & {
        id: string; updated_at: Date;
      })[]>`
        SELECT id, name, code, is_primary, address_line1, address_line2, city, region, postal_code,
               country, timezone, main_phone, after_hours_phone,
               ARRAY(SELECT abbrev(ip) FROM unnest(public_ips) AS ip) AS public_ips,
               access_notes, physical_security, notes, updated_at
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
          // A location has no page of its own; Edit opens the location dialog.
          editSite: { organizationId, values: siteValuesFrom(r) },
        })),
      };
    }

    /*
     * Documents: the one category with FOLDERS, and therefore the one that
     * exercises the grid's folder row. Top-level folders come back as their own
     * rows with a child count; loose documents follow them.
     */
    /*
     * The Documents directory (0810). `?folder=` is the folder being looked at;
     * its subfolders, its files and its written documents are listed, and a
     * folder row opens that folder here rather than sending everyone to the
     * same page. The folder's own path is the header's trail.
     */
    const current = typeof search.folder === 'string' && isUuid(search.folder) ? search.folder : null;
    const [here, folders, docs, pages, totalRows] = await Promise.all([
      current
        ? tx<{ id: string; name: string; path: string[]; parent_id: string | null }[]>`
            SELECT f.id, f.name, helm.document_folder_path(f.id) AS path, f.parent_id
            FROM document_folder f WHERE f.id = ${current}::uuid
          `
        : Promise.resolve([]),
      tx<{ id: string; name: string; n: string }[]>`
        SELECT f.id, f.name,
               ((SELECT count(*) FROM attachment a WHERE a.folder_id = f.id AND a.is_document AND a.deleted_at IS NULL)
                + (SELECT count(*) FROM document_page p WHERE p.folder_id = f.id AND p.deleted_at IS NULL)
                + (SELECT count(*) FROM document_folder c WHERE c.parent_id = f.id))::text AS n
        FROM document_folder f
        WHERE f.organization_id = ${organizationId}::uuid
          AND f.parent_id IS NOT DISTINCT FROM ${current}::uuid
        ORDER BY f.name
      `,
      tx<{
        id: string; filename: string; content_type: string; byte_size: number;
        uploaded_at: Date; uploaded_by_name: string | null; is_internal_only: boolean; archived: boolean;
      }[]>`
        SELECT a.id, a.filename, a.content_type, a.byte_size, a.uploaded_at,
               u.name AS uploaded_by_name, a.is_internal_only, a.archived_at IS NOT NULL AS archived
        FROM attachment a
        LEFT JOIN app_user u ON u.id = a.uploaded_by
        WHERE a.organization_id = ${organizationId}::uuid
          AND a.is_document AND a.folder_id IS NOT DISTINCT FROM ${current}::uuid AND a.deleted_at IS NULL
          ${includeArchived ? tx`` : tx`AND a.archived_at IS NULL`}
        ORDER BY a.filename
        LIMIT 500
      `,
      tx<{
        id: string; title: string; version: number; updated_at: Date; updated_by_name: string | null;
        is_internal_only: boolean; archived: boolean;
      }[]>`
        SELECT p.id, p.title, p.version, p.updated_at, coalesce(u.name, u.email::text) AS updated_by_name,
               p.is_internal_only, p.archived_at IS NOT NULL AS archived
        FROM document_page p
        LEFT JOIN app_user u ON u.id = p.updated_by
        WHERE p.organization_id = ${organizationId}::uuid
          AND p.folder_id IS NOT DISTINCT FROM ${current}::uuid AND p.deleted_at IS NULL
          ${includeArchived ? tx`` : tx`AND p.archived_at IS NULL`}
        ORDER BY lower(p.title)
        LIMIT 500
      `,
      // The whole client's count, for "X of Y": one population, as everywhere.
      tx<{ n: string }[]>`
        SELECT ((SELECT count(*) FROM attachment WHERE organization_id = ${organizationId}::uuid
                   AND is_document AND deleted_at IS NULL ${includeArchived ? tx`` : tx`AND archived_at IS NULL`})
              + (SELECT count(*) FROM document_page WHERE organization_id = ${organizationId}::uuid
                   AND deleted_at IS NULL ${includeArchived ? tx`` : tx`AND archived_at IS NULL`}))::text AS n
      `,
    ]);
    if (current && here.length === 0) return null;

    return {
      org,
      actorRoleRank,
      total: Number(totalRows[0]?.n ?? 0),
      folder: here[0] ? { id: here[0].id, name: here[0].name, path: here[0].path, parentId: here[0].parent_id } : null,
      records: [
        ...folders.map<CategoryRecord>((f) => ({
          id: f.id,
          name: f.name,
          folder: {
            itemCount: Number(f.n),
            itemNoun: 'Item',
            href: `/organizations/${organizationId}/documents?folder=${f.id}`,
          },
          removeKind: 'folder',
        })),
        ...pages.map<CategoryRecord>((p) => ({
          id: p.id,
          name: p.title,
          href: `/documents/${p.id}`,
          secondary: 'Written document',
          extra: `v${p.version}`,
          internalOnly: p.is_internal_only,
          updatedAt: p.updated_at.toISOString(),
          updatedBy: p.updated_by_name,
          removeKind: 'page',
          archived: p.archived,
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
          archived: d.archived,
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
  // The configuration form's pickers (0800): the client's people, and the
  // devices and networks an interface can be connected to.
  const pickers = canWrite && category.source === 'device'
    ? await withTenant(actorOf(identity), async (tx) => {
        const [contacts, connectable] = await Promise.all([
          tx<{ id: string; name: string }[]>`
            SELECT id, first_name || ' ' || last_name AS name FROM contact
            WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL AND archived_at IS NULL
            ORDER BY last_name, first_name
          `,
          tx<{ id: string; name: string }[]>`
            SELECT id, name FROM asset_node
            WHERE organization_id = ${organizationId}::uuid AND archived_at IS NULL
              AND node_type IN ('device', 'network')
            ORDER BY name LIMIT 500
          `,
        ]);
        return { contacts, connectable };
      })
    : { contacts: [], connectable: [] };
  const base = `/organizations/${organizationId}`;

  const importSpec = importSpecFor(category.slug);
  /*
   * Documents are created by uploading a file, which the documents page already
   * does, so + New has nothing to open there.
   *
   * SOPs were the other exception until F1 and are not any more: 'sop' is still
   * absent from the assets route's CREATABLE list — a procedure's payload is its
   * steps, so creating one through the generic path would make a node that
   * documents nothing — but POST /api/sops exists now and CategoryActions opens
   * NewProcedureForm for this category.
   */
  const canCreate = category.source !== 'attachment';

  /*
   * Offered on every category whose rows carry is_internal_only — which is every
   * node category. Restricting it to Passwords would have been arbitrary: "what
   * can this client see?" is as live a question about their firewall as about
   * their registrar login.
   *
   * Hidden entirely when nothing is internal-only, because a split with one
   * populated side is a control that only ever says the same thing.
   */
  const counts = 'tabCounts' in data ? data.tabCounts : null;
  const tabs =
    category.kind === 'node' && counts && counts.internal > 0
      ? [
          { href: `${base}/${category.slug}`, label: 'All', count: counts.shared + counts.internal },
          { href: `${base}/${category.slug}?view=shared`, label: 'Shared with client', count: counts.shared },
          { href: `${base}/${category.slug}?view=internal`, label: 'Internal only', count: counts.internal },
        ]
      : [];

  /*
   * What the three flexible columns mean for THIS category. Without this every
   * grid called its second column "Username", which is right for passwords and
   * nonsense for documents, where that slot holds a content type.
   */
  const labels =
    category.source === 'device'
      ? { secondary: 'Type', type: 'Status', extra: 'OS' }
      : category.source === 'contact'
      ? { secondary: 'Email', type: 'Title', extra: 'Phone' }
      : category.source === 'site'
        ? { secondary: 'City', type: 'Code', extra: 'Phone' }
        : category.source === 'attachment'
          ? { secondary: 'Kind', type: 'Status', extra: 'Size' }
          : category.source === 'credential'
            ? { secondary: 'Username', type: 'Status', extra: 'Vault entry' }
            : { secondary: 'Address', type: 'Status', extra: 'Detail' };

  return (
    <>
      <ViewHeader
        trail={
          'folder' in data && data.folder
            ? [
                { label: data.org.name, href: base },
                { label: 'Documents', href: `${base}/documents` },
                ...data.folder.path.slice(0, -1).map((name) => ({ label: name })),
              ]
            : [{ label: data.org.name, href: base }]
        }
        title={'folder' in data && data.folder ? data.folder.name : category.label}
        actions={
          canWrite && category.source === 'attachment' ? (
            <DocumentsActions
              organizationId={organizationId}
              folderId={'folder' in data && data.folder ? data.folder.id : null}
              maxBytes={maxUploadBytes()}
            />
          ) : canWrite ? (
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
              contacts={pickers.contacts}
              connectable={pickers.connectable}
              canCreate={canCreate}
            />
          ) : null
        }
      />
      <TabNav
        tabs={tabs}
        activeHref={view === 'all' ? `${base}/${category.slug}` : `${base}/${category.slug}?view=${view}`}
      />
      <CategoryGrid
        records={data.records}
        /*
         * The denominator in "3 of 4" is the rows in THIS view, not in the
         * category. On the Internal only tab, "3 of 12" would be comparing a
         * filtered count against a total the tab is deliberately excluding.
         */
        total={
          counts && view !== 'all'
            ? (view === 'internal' ? counts.internal : counts.shared)
            : data.total
        }
        categoryLabel={category.label}
        canWrite={canWrite}
        canDelete={canDelete}
        labels={labels}
        actorRoleRank={data.actorRoleRank}
        columnScope={category.slug}
        extraColumns={
          category.source === 'device'
            ? [
                { key: 'primaryIp', header: 'Primary IP' },
                { key: 'serial', header: 'Serial number' },
                { key: 'expires', header: 'Expires', secondary: true },
                { key: 'location', header: 'Location', secondary: true },
              ]
            : []
        }
      />
    </>
  );
}
