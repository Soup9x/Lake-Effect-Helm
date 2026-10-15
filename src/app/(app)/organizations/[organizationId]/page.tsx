import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/ids';
import { Boxes, CalendarClock, KeyRound, MapPin, Users } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { NewSecretForm } from '@/components/new-secret-form';
import { SiteForm } from '@/components/site-form';
import { TopologyDesigner } from '@/components/topology-designer';
import { CredentialEditForm } from '@/components/credential-edit-form';
import { NewAssetForm } from '@/components/new-asset-form';
import { InlineRename } from '@/components/inline-rename';
import { TagEditor } from '@/components/tag-editor';
import { SectionBrowser } from '@/components/section-browser';
import { DocumentsCard } from '@/components/documents-card';
import { SectionBoundary } from '@/components/section-boundary';
import { maxUploadBytes } from '@/lib/documents/limits';
import type { DocumentRow, FolderRow } from '@/lib/ui/documents';
import { isClientRole } from '@/lib/ui/roles';
import {
  countStrength, isWeakStrength, strengthBucket, strengthLabel,
} from '@/lib/ui/strength';
import { FavoriteStar } from '@/components/favorite-star';
import { NotesCard } from '@/components/notes-card';
import { DocumentationHealthCard } from '@/components/documentation-health';
import { LogoControl } from '@/components/logo-control';
import { readDocumentationHealth } from '@/lib/health/queries';
import { logoSrc } from '@/lib/ui/logo';
import { HealthDot } from '@/components/ui/health-dot';
import { isFavorite, listRecentInOrganization, recordView } from '@/lib/workspace/queries';
import { listClientActivity, listRecentlyUpdated } from '@/lib/clients/activity';
import { listRunsForOrganization } from '@/lib/sops/queries';
import { ChecklistRunsCard } from '@/components/checklist-runs-card';
import {
  ActivityFeedWidget, ClientRecentlyViewedWidget, CredentialStrengthWidget,
  ImportantContactsWidget,
  PopularCredentialsWidget, RecentlyUpdatedWidget, type PopularCredential,
} from '@/components/client-widgets';
import { Badge, severityTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RevealButton } from '@/components/reveal-button';
import { formatDate, humanise, relativeDays } from '@/lib/ui/format';

interface OrgRow {
  id: string; name: string; legal_name: string | null; status: string;
  industry: string | null; employee_count: number | null; timezone: string | null;
  website: string | null; onboarded_at: Date | null; notes: string | null;
  tags: string[];
  logo_url: string | null;
  /** Whether 0680's organization_logo holds bytes for this client. */
  has_logo: boolean;
}

interface SiteRow {
  id: string; name: string; code: string | null; is_primary: boolean; address_line1: string | null;
  city: string | null; region: string | null; main_phone: string | null;
  notes: string | null;
}

interface ContactRow {
  id: string; first_name: string; last_name: string | null; title: string | null;
  email: string | null; phone: string | null; is_primary: boolean; is_emergency: boolean;
  // Group L. The other three flags, for the "who to call" widget — which ranks
  // the flags that already existed rather than adding a sixth (decision 35).
  is_technical: boolean; is_billing: boolean; is_authorised: boolean;
}

interface AssetRow {
  id: string; node_type: string; name: string; status: string; criticality: number;
}

interface CredentialRow {
  node_id: string; name: string; credential_type: string; username: string | null;
  url: string | null; secret_id: string | null; sensitivity: string | null;
  requires_reason: boolean; requires_step_up: boolean; is_break_glass: boolean;
  strength_score: number | null; tags: string[];
  /* Both maintained inside helm.reveal_secret(), immediately after it writes
     the secret.revealed audit row. "Most used" is therefore a view of the
     audited path and not a second, unaudited counter. */
  access_count: string | null; last_accessed_at: Date | null;
  notes: string | null; criticality: number; secret_label: string | null;
  /** Whether a TOTP seed is attached. A boolean, never the id and never the seed. */
  has_totp: boolean;
}

interface ExpiryRow {
  id: string; label: string; kind: string; expires_at: Date; severity: string; days_remaining: number;
}

/** Flat rows; src/lib/ui/documents.ts nests them. */
interface FolderQueryRow {
  id: string; parent_id: string | null; name: string; is_internal_only: boolean;
}

interface DocumentQueryRow {
  id: string; folder_id: string | null; filename: string; content_type: string;
  byte_size: string; is_internal_only: boolean; archived_at: Date | null;
  uploaded_at: Date; uploaded_by_name: string | null;
}

interface HealthRow {
  health: string; expired_count: number; critical_count: number;
  warning_count: number; reasons: string[] | null;
}

/**
 * One client, everything Helm knows about them.
 *
 * Six queries rather than one join: they are independent lists with different
 * cardinalities, and a single query would fan out the credential rows across
 * every asset. Each is RLS-scoped in its own right, so an organisation the
 * actor cannot see produces `notFound()` at the first query rather than an
 * empty page that looks like a data problem.
 */
export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const identity = await getServerIdentity();
  const { organizationId } = await params;
  if (!isUuid(organizationId)) notFound();

  const data = await withTenant(actorOf(identity), async (tx, session) => {
    const [organization] = await tx<OrgRow[]>`
      SELECT id, name, legal_name, status::text, industry, employee_count,
             timezone, website, onboarded_at, notes, tags, logo_url,
             -- EXISTS rather than a join: one bit is wanted, the bytes are
             -- never read here, and organization_logo is RLS-scoped in its own
             -- right so an invisible client contributes nothing.
             EXISTS (
               SELECT 1 FROM organization_logo l WHERE l.organization_id = o.id
             ) AS has_logo
      FROM organization o WHERE o.id = ${organizationId}::uuid AND o.deleted_at IS NULL
    `;
    if (!organization) return null;

    // Recorded before the rest, and only once the organisation has been proven
    // readable: an id that RLS refuses returns above, so nothing lands in
    // somebody's history for a client they cannot see.
    await recordView(tx, { organizationId });

    const [
      sites, contacts, assets, credentials, expiries, health, pinned, folders, documents,
      recentlyUpdated, recentlyViewed, activity, runs, documentationHealth,
    ] = await Promise.all([
      tx<SiteRow[]>`
        SELECT id, name, code, is_primary, address_line1, city, region, main_phone, notes
        FROM site WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
        ORDER BY is_primary DESC, name
      `,
      tx<ContactRow[]>`
        SELECT id, first_name, last_name, title, email::text, phone,
               is_primary, is_emergency, is_technical, is_billing, is_authorised
        FROM contact WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
        ORDER BY is_primary DESC, last_name NULLS LAST, first_name
      `,
      tx<AssetRow[]>`
        SELECT id, node_type::text, name, status::text, criticality
        FROM asset_node
        WHERE organization_id = ${organizationId}::uuid AND archived_at IS NULL
          AND node_type <> 'credential'
        ORDER BY criticality DESC, node_type, name
        LIMIT 300
      `,
      tx<CredentialRow[]>`
        SELECT n.id AS node_id, n.name, n.tags, n.notes, n.criticality,
               c.credential_type::text, c.username::text, c.url,
               c.secret_id::text, c.is_break_glass,
               c.totp_secret_id IS NOT NULL AS has_totp,
               m.label AS secret_label,
               m.sensitivity::text, m.requires_reason, m.requires_step_up, m.strength_score,
               m.access_count, m.last_accessed_at
        FROM credential c
        JOIN asset_node n ON n.id = c.id
        LEFT JOIN v_secret_metadata m ON m.id = c.secret_id
        WHERE n.organization_id = ${organizationId}::uuid AND n.archived_at IS NULL
        ORDER BY n.name
      `,
      tx<ExpiryRow[]>`
        SELECT id, label, kind::text, expires_at, severity::text, days_remaining
        FROM v_expiration_dashboard
        WHERE organization_id = ${organizationId}::uuid
        ORDER BY expires_at LIMIT 200
      `,
      tx<HealthRow[]>`
        SELECT health, expired_count, critical_count, warning_count, reasons
        FROM v_client_health WHERE organization_id = ${organizationId}::uuid
      `,
      isFavorite(tx, organizationId),
      /*
       * The client's whole document tree, metadata only, in two queries.
       *
       * RLS decides what comes back — an internal-only folder and everything
       * under it simply is not in these rows for a co-managed client actor,
       * which is why the modal has no visibility logic of its own. Archived
       * documents ARE fetched: they are hidden by default and shown behind a
       * checkbox, and they are the reason a folder delete is refused.
       */
      tx<FolderQueryRow[]>`
        SELECT id, parent_id, name, is_internal_only
        FROM document_folder
        WHERE organization_id = ${organizationId}::uuid
        ORDER BY name
      `,
      tx<DocumentQueryRow[]>`
        SELECT a.id, a.folder_id, a.filename, a.content_type, a.byte_size,
               a.is_internal_only, a.archived_at, a.uploaded_at,
               -- app_user has "name", not "display_name" -- the Auth.js
               -- adapter schema names it, and it is nullable. Same fallback
               -- getServerIdentity() uses: an account that never set a name is
               -- still somebody, and a dash in a document list is less use
               -- than an address.
               coalesce(u.name, u.email::text) AS uploaded_by_name
        FROM attachment a
        LEFT JOIN app_user u ON u.id = a.uploaded_by
        WHERE a.organization_id = ${organizationId}::uuid
          AND a.is_document AND a.deleted_at IS NULL
        ORDER BY lower(a.filename)
        LIMIT 2000
      `,
      /*
       * The three widget reads. In the same Promise.all as everything else and
       * on the same transaction, so they add round trips rather than a second
       * connection hold, and they see exactly the rows RLS gave the queries
       * above.
       *
       * listClientActivity returns [] for an actor without `audit:read` —
       * the policy filters every row and the query still succeeds. That is why
       * `canReadAudit` is read from the session below and passed to the widget:
       * from the array alone, "no permission" and "nothing happened" are the
       * same empty list.
       */
      listRecentlyUpdated(tx, organizationId),
      listRecentInOrganization(tx, organizationId),
      listClientActivity(tx, organizationId),
      /*
       * Checklist runs for this client, open ones first.
       *
       * Added in F1, which is also when anything could create one: the model in
       * 0090 was complete and no code path had ever written sop_run. Read
       * through v_sop_run_progress so the counts come from one place rather than
       * being recomputed per card.
       */
      listRunsForOrganization(tx, organizationId),
      /*
       * The health ring's counts, from v_documentation_health. One aggregate
       * over this client's nodes, on the same transaction as everything else,
       * and it returns null for an organisation RLS does not show — which
       * cannot happen here, because the read above already returned.
       */
      readDocumentationHealth(tx, organizationId),
    ]);

    return {
      organization, sites, contacts, assets, credentials, expiries,
      health: health[0], pinned, folders, documents,
      recentlyUpdated, recentlyViewed, activity, runs, documentationHealth,
      canWriteOrganization: session.permissions.includes('organization:write'),
      canDeleteDocuments: session.permissions.includes('asset:delete'),
      canReadAudit: session.permissions.includes('audit:read'),
      /*
       * Who may see HOW OFTEN a credential has been read.
       *
       * Not gated by RLS, and that is the point of gating it here.
       * secret_rls_select admits any actor in the organisation's scope whose
       * credential node is visible — it does not consult `secret:read`, let
       * alone `secret:reveal` — so v_secret_metadata hands access_count and
       * last_accessed_at to a client_read_only actor as readily as to a
       * technician. The columns were always readable; until this card they had
       * nowhere to surface.
       *
       * `secret:reveal` is the right gate because it is the permission that
       * PRODUCES the number. Every increment happens inside
       * helm.reveal_secret(), which refuses an actor without it, so "how many
       * times was this revealed" is answerable only by somebody who could have
       * done the revealing. In the shipped catalogue that is super_admin,
       * tier1, tier2 and api_service — and notably NOT client_admin, which
       * holds secret:read and audit:read but not secret:reveal.
       */
      canSeeAccessCounts: session.permissions.includes('secret:reveal'),
    };
  });

  // RLS makes "not yours" and "not there" the same answer; so does this page.
  if (!data) notFound();

  const {
    organization, sites, contacts, assets, credentials, expiries, health, pinned,
    folders, documents, recentlyUpdated, recentlyViewed, activity, runs,
    canDeleteDocuments, canReadAudit, canSeeAccessCounts,
    documentationHealth, canWriteOrganization,
  } = data;

  // Which image the avatar loads, and the same rule the clients list and the
  // recents strip use — see src/lib/ui/logo.ts for why there are two sources
  // and why an upload wins.
  const logo = logoSrc(organization.id, organization.has_logo, organization.logo_url);
  const canWrite = !isClientRole(identity.roleKey);

  const folderRows: FolderRow[] = folders.map((f) => ({
    id: f.id,
    parentId: f.parent_id,
    name: f.name,
    isInternalOnly: f.is_internal_only,
  }));
  /*
   * Two widgets out of rows the page already had.
   *
   * The credentials list was fetched above with its strength and access columns
   * joined in; bucketing and sorting it here costs no query and, more to the
   * point, guarantees the figures on the cards describe exactly the list
   * underneath them. A second query with its own WHERE would eventually
   * disagree with the first, and the card would be blamed for the discrepancy.
   */
  const withSecret = credentials.filter((c) => c.secret_id !== null);
  const strengthCounts = countStrength(withSecret.map((c) => c.strength_score));

  /*
   * THE GATE IS ON THE DATA, not on the rendering, and the difference is the
   * whole point. This is a server component: whatever it hands a child is
   * serialised into the RSC payload and travels to the browser whether or not
   * anything draws it. Building the list and then hiding the card would ship
   * every read count to exactly the actor it was being withheld from, where
   * the network tab is one keypress away. So an actor without secret:reveal
   * gets an empty array, and the numbers never leave the server.
   */
  const popularCredentials: PopularCredential[] = !canSeeAccessCounts
    ? []
    : withSecret
        .map((c) => ({
          nodeId: c.node_id,
          name: c.name,
          accessCount: Number(c.access_count ?? 0),
          lastAccessedAt: c.last_accessed_at,
        }))
        // Never-read credentials are not "least popular", they are absent from
        // the question. access_count is a bigint, so it arrives as a string
        // and Number() above is what makes this a numeric sort rather than a
        // lexical one — '9' > '10' is true for strings and would put nine
        // reads above ten.
        .filter((c) => c.accessCount > 0)
        .sort((a, b) => b.accessCount - a.accessCount)
        .slice(0, 5);

  const documentRows: DocumentRow[] = documents.map((d) => ({
    id: d.id,
    folderId: d.folder_id,
    filename: d.filename,
    contentType: d.content_type,
    byteSize: Number(d.byte_size),
    isInternalOnly: d.is_internal_only,
    archived: d.archived_at !== null,
    uploadedAt: d.uploaded_at.toISOString(),
    uploadedBy: d.uploaded_by_name,
  }));

  return (
    <>
      <PageHeader
        title={organization.name}
        trail={[{ label: 'Clients', href: '/organizations' }]}
        description={
          [organization.legal_name, organization.industry, organization.timezone]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        actions={
          <div className="flex items-center gap-2">
            {/*
              The logo sits in the header rather than in a settings panel,
              because this is the page where somebody notices it is missing.
              Read-only roles see the avatar with no controls, which is why the
              component takes canWrite rather than being conditionally
              rendered: a client user should still see their own logo.
            */}
            <LogoControl
              organizationId={organization.id}
              name={organization.name}
              src={logo}
              canWrite={canWriteOrganization}
            />
            <HealthDot
              showLabel
              organizationId={organization.id}
              health={{
                health: health?.health ?? 'green',
                expiredCount: health?.expired_count ?? 0,
                criticalCount: health?.critical_count ?? 0,
                warningCount: health?.warning_count ?? 0,
                reasons: health?.reasons ?? null,
              }}
            />
            <FavoriteStar
              organizationId={organization.id}
              pinned={pinned}
              label={organization.name}
            />
            {canWrite && (
              // The slug stays: it is in URLs and in the mappings that
              // correlate this client with an RMM or PSA.
              <InlineRename
                currentName={organization.name}
                endpoint={`/api/organizations/${organization.id}`}
                inputId="rename-org"
                label="Client name"
                hint="The slug and every existing link stay as they are."
              />
            )}
            <Button asChild variant="secondary" size="sm">
              <Link href={`/exports?organizationId=${organization.id}`}>Export documentation</Link>
            </Button>
          </div>
        }
      />
      <PageBody>
        {/*
          The client's own tags, which were displayed nowhere but the client
          LIST — the one place you cannot act on a single client. Adding a tag
          was possible through the bulk bar; taking one off was not possible
          anywhere, because nothing rendered a control over them.
        */}
        <div className="mb-4">
          <TagEditor
            target="client"
            id={organization.id}
            tags={organization.tags}
            canWrite={canWrite}
          />
        </div>
        {canWrite && (
          <div className="mb-4 flex flex-wrap gap-2">
            <NewSecretForm organizationId={organization.id} />
            <SiteForm organizationId={organization.id} />
            <NewAssetForm
              organizationId={organization.id}
              sites={sites.map((s) => ({ id: s.id, name: s.name }))}
            />
          </div>
        )}
        <NotesCard
          endpoint={`/api/organizations/${organization.id}`}
          notes={organization.notes}
          canEdit={canWrite}
        />
        {/*
          THE WIDGET ROWS, above the sections rather than beside them.

          A right-hand column was the other option and it is what the reference
          product does, but the five sections below are already three-up and
          two-up grids: squeezing a sidebar next to them leaves the credentials
          table about forty characters wide on a laptop. Across the top, the
          cards are glanceable on the way to the thing somebody came for, and
          they collapse to one column on a phone like everything else here.

          Three compact cards, then two lists. All five take data the server
          component fetched; none of them queries. See client-widgets.tsx.
        */}
        <div className="grid gap-4 lg:grid-cols-3">
          <CredentialStrengthWidget
            counts={strengthCounts}
            withoutSecret={credentials.length - withSecret.length}
          />
          <PopularCredentialsWidget
            credentials={popularCredentials}
            canSeeAccessCounts={canSeeAccessCounts}
          />
          <ClientRecentlyViewedWidget items={recentlyViewed} />
          {/*
            Group L. Near the top, which is the whole difference it makes: the
            full contacts table has always been further down and already badges
            Primary and Emergency, but somebody on a call should not have to
            scroll past every asset to find a phone number.
          */}
          <ImportantContactsWidget
            organizationId={organization.id}
            totalContacts={contacts.length}
            contacts={contacts.map((contact) => ({
              id: contact.id,
              name: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
              title: contact.title,
              email: contact.email,
              phone: contact.phone,
              isPrimary: contact.is_primary,
              isTechnical: contact.is_technical,
              isBilling: contact.is_billing,
              isEmergency: contact.is_emergency,
              isAuthorised: contact.is_authorised,
            }))}
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <RecentlyUpdatedWidget items={recentlyUpdated} organizationId={organization.id} />
          <ActivityFeedWidget activity={activity} canReadAudit={canReadAudit} />
        </div>
        {/*
          The health ring, beside Recently updated on purpose: the two read the
          same column from opposite ends. Recently updated says what moved;
          this says what has not. Rendered whenever the view returned a row,
          including a client with nothing documented — the card says so itself
          rather than being hidden, because "nothing is documented here" is the
          most actionable thing it could tell somebody.
        */}
        {documentationHealth && (
          <DocumentationHealthCard
            health={documentationHealth}
            organizationId={organization.id}
            viewsRecorded={documentationHealth.lastViewedAt !== null}
          />
        )}
        {/*
          Checklist runs. Rendered only when there are any, rather than as a
          permanent empty card: a client with no runs is the common case while
          procedures are being written, and a card that says "none" on every
          client is furniture. Starting one happens on the procedure, which is
          where the version being run is visible.
        */}
        {runs.length > 0 && <ChecklistRunsCard runs={runs} />}
        {/*
          FIVE SECTIONS, FIVE CARDS, and the lists themselves in modals.
          Each of these used to render inline and in full: every credential,
          every asset, every site, every contact, one after another. On a client
          with real documentation the page became a scroll, and whatever
          somebody came for was under three lists they were not reading.

          The rows are built here, in the server component, and handed to
          SectionBrowser as data — SelectableRow is {id, label, cells} and every
          cell is already a node, so filtering happens in the browser without a
          second description of what a row looks like. Bulk selection comes
          along unchanged for the two sections that had it.
        */}
        <div className="grid gap-4 lg:grid-cols-3">
          <SectionBrowser
            title="Sites"
            icon={<MapPin className="size-4 text-ink-faint" aria-hidden />}
            emptyTitle="No sites documented."
            columns={['Site', 'Address', 'Phone']}
            rows={sites.map((site) => ({
              id: site.id,
              label: site.name,
              search: [site.name, site.code, site.address_line1, site.city, site.region,
                       site.main_phone, site.notes]
                .filter(Boolean).join(' ').toLowerCase(),
              cells: [
                <div key="name" className="flex items-center gap-2">
                  <span className="font-medium text-ink">{site.name}</span>
                  {site.is_primary && <Badge tone="brand">Primary</Badge>}
                  {canWrite && (
                    <SiteForm
                      organizationId={organization.id}
                      site={{
                        id: site.id,
                        values: {
                          name: site.name,
                          code: site.code ?? '',
                          city: site.city ?? '',
                          region: site.region ?? '',
                          addressLine1: site.address_line1 ?? '',
                          mainPhone: site.main_phone ?? '',
                          isPrimary: site.is_primary,
                          notes: site.notes ?? '',
                        },
                      }}
                    />
                  )}
                  {/* Open for anybody who may read the client; only editable
                      with asset:write, which the component is told about
                      rather than deciding for itself. */}
                  <TopologyDesigner
                    siteId={site.id}
                    siteName={site.name}
                    canEdit={canWrite}
                  />
                </div>,
                <div key="addr" className="text-ink-muted">
                  {[site.address_line1, site.city, site.region].filter(Boolean).join(', ') || '—'}
                  {site.notes && (
                    <p className="mt-1 whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs">
                      {site.notes}
                    </p>
                  )}
                </div>,
                <span key="phone" className="text-ink-faint">{site.main_phone ?? '—'}</span>,
              ],
            }))}
          />

          <SectionBrowser
            title="Contacts"
            icon={<Users className="size-4 text-ink-faint" aria-hidden />}
            emptyTitle="No contacts documented."
            columns={['Contact', 'Title', 'Reach them']}
            filters={[{ key: 'role', label: 'Role' }]}
            rows={contacts.map((contact) => ({
              id: contact.id,
              label: `${contact.first_name} ${contact.last_name}`,
              search: [contact.first_name, contact.last_name, contact.title,
                       contact.email, contact.phone]
                .filter(Boolean).join(' ').toLowerCase(),
              // Emergency and primary are the two reasons somebody opens this
              // list looking for a particular person rather than a name.
              facets: {
                role: contact.is_emergency ? 'emergency' : contact.is_primary ? 'primary' : 'other',
              },
              cells: [
                <div key="name" className="flex items-center gap-2">
                  <span className="font-medium text-ink">
                    {contact.first_name} {contact.last_name}
                  </span>
                  {contact.is_emergency && <Badge tone="critical">Emergency</Badge>}
                  {contact.is_primary && <Badge tone="brand">Primary</Badge>}
                </div>,
                <span key="title" className="text-ink-muted">{contact.title ?? '—'}</span>,
                <span key="reach" className="text-ink-faint">
                  {[contact.email, contact.phone].filter(Boolean).join(' · ') || '—'}
                </span>,
              ],
            }))}
          />

          <SectionBrowser
            title="Expiring"
            icon={<CalendarClock className="size-4 text-ink-faint" aria-hidden />}
            emptyTitle="Nothing tracked."
            columns={['Item', 'Kind', 'Expires', 'Severity']}
            filters={[{ key: 'kind', label: 'Kind' }]}
            showWindows
            rows={expiries.map((expiry) => ({
              id: expiry.id,
              label: expiry.label,
              search: [expiry.label, expiry.kind, expiry.severity]
                .filter(Boolean).join(' ').toLowerCase(),
              facets: { kind: expiry.kind, severity: expiry.severity },
              days: expiry.days_remaining,
              cells: [
                <span key="label" className="truncate text-ink">{expiry.label}</span>,
                <span key="kind" className="text-ink-muted">{humanise(expiry.kind)}</span>,
                <span key="when" className="text-ink-faint">
                  {formatDate(expiry.expires_at)} ({relativeDays(expiry.days_remaining)})
                </span>,
                <Badge key="sev" tone={severityTone(expiry.severity)}>{expiry.severity}</Badge>,
              ],
            }))}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <SectionBrowser
            title="Credentials"
            icon={<KeyRound className="size-4 text-ink-faint" aria-hidden />}
            emptyTitle="No credentials documented"
            emptyDescription="Credentials stored here are encrypted per tenant and every read is recorded."
            bulk={{ target: 'node', selectable: canWrite }}
            filters={[
              { key: 'type', label: 'Account type' },
              { key: 'sensitivity', label: 'Sensitivity' },
              // The strength card above counts these buckets; this is how you
              // get from a count to the rows behind it. Same strengthBucket(),
              // so the filter cannot disagree with the number.
              { key: 'strength', label: 'Strength' },
            ]}
            columns={[
              'Credential',
              'Username',
              'Sensitivity',
              <span key="s" className="w-96">Secret</span>,
              <span key="e" className="sr-only">Edit</span>,
            ]}
            rows={credentials.map((credential) => ({
              id: credential.node_id,
              label: credential.name,
              search: [credential.name, credential.username, credential.url,
                       credential.credential_type, credential.secret_label,
                       ...credential.tags]
                .filter(Boolean).join(' ').toLowerCase(),
              facets: {
                type: credential.credential_type,
                sensitivity: credential.sensitivity ?? 'unknown',
                // A credential with no stored secret has no strength to filter
                // on; the card counts those separately for the same reason.
                strength: credential.secret_id
                  ? strengthBucket(credential.strength_score)
                  : 'no_secret',
              },
              cells: [
                <div key="name">
                  <Link
                    href={`/assets/${credential.node_id}`}
                    className="font-medium text-ink hover:text-brand"
                  >
                    {credential.name}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-ink-faint">
                      {humanise(credential.credential_type)}
                    </span>
                    {credential.is_break_glass && <Badge tone="critical">Break glass</Badge>}
                    {isWeakStrength(credential.strength_score) && (
                      <Badge tone="warning">{strengthLabel(credential.strength_score)}</Badge>
                    )}
                    {credential.tags.map((tag) => (
                      <Badge key={tag} tone="neutral">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>,
                <span key="user" className="font-mono text-xs text-ink-muted">
                  {credential.username ?? '—'}
                </span>,
                <Badge
                  key="sens"
                  tone={
                    credential.sensitivity === 'critical'
                      ? 'critical'
                      : credential.sensitivity === 'elevated'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {credential.sensitivity ?? 'unknown'}
                </Badge>,
                credential.secret_id ? (
                  <RevealButton
                    key="reveal"
                    secretId={credential.secret_id}
                    label={credential.name}
                    requiresReason={credential.requires_reason}
                    requiresStepUp={credential.requires_step_up}
                  />
                ) : (
                  <span key="reveal" className="text-xs text-ink-faint">No stored secret</span>
                ),
                <CredentialEditForm
                  key="edit"
                  secretId={credential.secret_id ?? ''}
                  nodeId={credential.node_id}
                  tags={credential.tags}
                  hasTotp={credential.has_totp}
                  canEdit={canWrite && credential.secret_id !== null}
                  values={{
                    label: credential.secret_label ?? credential.name,
                    name: credential.name,
                    username: credential.username ?? '',
                    url: credential.url ?? '',
                    notes: credential.notes ?? '',
                    sensitivity: credential.sensitivity ?? 'standard',
                    credentialType: credential.credential_type,
                    requiresStepUp: credential.requires_step_up,
                    requiresReason: credential.requires_reason,
                    isBreakGlass: credential.is_break_glass,
                    criticality: credential.criticality,
                  }}
                />,
              ],
            }))}
          />

          <SectionBrowser
            title="Assets"
            icon={<Boxes className="size-4 text-ink-faint" aria-hidden />}
            emptyTitle="No assets documented"
            bulk={{ target: 'node', selectable: canWrite }}
            filters={[
              { key: 'type', label: 'Type' },
              { key: 'status', label: 'Status' },
              { key: 'criticality', label: 'Criticality' },
            ]}
            columns={['Name', 'Type', 'Status', 'Criticality']}
            rows={assets.map((asset) => ({
              id: asset.id,
              label: asset.name,
              search: [asset.name, asset.node_type, asset.status]
                .filter(Boolean).join(' ').toLowerCase(),
              facets: {
                type: asset.node_type,
                status: asset.status,
                criticality: String(asset.criticality),
              },
              cells: [
                <Link key="name" href={`/assets/${asset.id}`} className="font-medium hover:text-brand">
                  {asset.name}
                </Link>,
                <span key="type" className="text-ink-muted">{humanise(asset.node_type)}</span>,
                <span key="status" className="text-ink-muted">{asset.status}</span>,
                <span key="crit" className="tabular-nums text-ink-muted">{asset.criticality}</span>,
              ],
            }))}
          />

          {/*
            Documents, the sixth card. Not a SectionBrowser: the other five
            filter a flat list, and a folder tree is navigation rather than
            filtering. Everything it renders arrived through RLS, so an
            internal-only subtree is absent from these props entirely rather
            than hidden by the component.

            Wrapped, because it is the newest and busiest section here — a
            file browser with uploads, a tree and six actions per row. A throw
            inside it now costs this card, not the credentials somebody opened
            this page to read. It does NOT catch a serialisation failure;
            nothing does. See src/app/(app)/error.tsx.
          */}
          <SectionBoundary title="Documents">
            <DocumentsCard
              organizationId={organization.id}
              folders={folderRows}
              documents={documentRows}
              canWrite={canWrite}
              canDelete={canDeleteDocuments}
              maxBytes={maxUploadBytes()}
            />
          </SectionBoundary>
        </div>
      </PageBody>
    </>
  );
}
