/**
 * One client's page, as queries.
 *
 * Nine reads rather than one join: they are independent lists with different
 * cardinalities, and a single query would fan the credential rows out across
 * every asset. Each is RLS-scoped in its own right, so an organisation the
 * actor cannot see produces nothing at the first read rather than an empty
 * page that looks like a data problem. The page composes them in one
 * Promise.all on one transaction; this module owns the SQL and the row shapes,
 * which used to be a third of the page.
 */
import type { HelmTx } from '../db/client';

export interface OrgRow {
  id: string; name: string; legal_name: string | null; status: string;
  /** What the organisation is to the MSP (0600); see lib/ui/organization-relationship. */
  relationship: string;
  industry: string | null; employee_count: number | null; timezone: string | null;
  website: string | null; onboarded_at: Date | null; notes: string | null;
  tags: string[];
  logo_url: string | null;
  /** Whether 0680's organization_logo holds bytes for this client. */
  has_logo: boolean;
}

export interface SiteRow {
  id: string; name: string; code: string | null; is_primary: boolean;
  address_line1: string | null; address_line2: string | null;
  city: string | null; region: string | null; postal_code: string | null; country: string;
  timezone: string | null; main_phone: string | null; after_hours_phone: string | null;
  public_ips: string[]; access_notes: string | null; physical_security: string | null;
  notes: string | null;
}

export interface ContactRow {
  id: string; first_name: string; last_name: string | null; title: string | null;
  email: string | null; phone: string | null; is_primary: boolean; is_emergency: boolean;
  // Group L. The other three flags, for the "who to call" widget — which ranks
  // the flags that already existed rather than adding a sixth (decision 35).
  is_technical: boolean; is_billing: boolean; is_authorised: boolean;
}

export interface AssetRow {
  id: string; node_type: string; name: string; status: string; criticality: number;
}

export interface CredentialRow {
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

export interface ExpiryRow {
  id: string; label: string; kind: string; expires_at: Date; severity: string; days_remaining: number;
}

/** Flat rows; src/lib/ui/documents.ts nests them. */
export interface FolderQueryRow {
  id: string; parent_id: string | null; name: string; is_internal_only: boolean;
}

export interface DocumentQueryRow {
  id: string; folder_id: string | null; filename: string; content_type: string;
  byte_size: string; is_internal_only: boolean; archived_at: Date | null;
  uploaded_at: Date; uploaded_by_name: string | null;
}

export interface HealthRow {
  health: string; expired_count: number; critical_count: number;
  warning_count: number; reasons: string[] | null;
}


export async function readOrganization(tx: HelmTx, organizationId: string): Promise<OrgRow | undefined> {
  const [row] = await tx<OrgRow[]>`
      SELECT id, name, legal_name, status::text, relationship::text, industry, employee_count,
             timezone, website, onboarded_at, notes, tags, logo_url,
             -- EXISTS rather than a join: one bit is wanted, the bytes are
             -- never read here, and organization_logo is RLS-scoped in its own
             -- right so an invisible client contributes nothing.
             EXISTS (
               SELECT 1 FROM organization_logo l WHERE l.organization_id = o.id
             ) AS has_logo
      FROM organization o WHERE o.id = ${organizationId}::uuid AND o.deleted_at IS NULL
    `;
  return row;
}

export function listSites(tx: HelmTx, organizationId: string): Promise<SiteRow[]> {
  return tx<SiteRow[]>`
        SELECT id, name, code, is_primary, address_line1, address_line2, city, region, postal_code,
               country, timezone, main_phone, after_hours_phone,
               ARRAY(SELECT abbrev(ip) FROM unnest(public_ips) AS ip) AS public_ips,
               access_notes, physical_security, notes
        FROM site WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
        ORDER BY is_primary DESC, name
      `;
}

export function listContacts(tx: HelmTx, organizationId: string): Promise<ContactRow[]> {
  return tx<ContactRow[]>`
        SELECT id, first_name, last_name, title, email::text, phone,
               is_primary, is_emergency, is_technical, is_billing, is_authorised
        FROM contact WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
        ORDER BY is_primary DESC, last_name NULLS LAST, first_name
      `;
}

export function listAssets(tx: HelmTx, organizationId: string): Promise<AssetRow[]> {
  return tx<AssetRow[]>`
        SELECT id, node_type::text, name, status::text, criticality
        FROM asset_node
        WHERE organization_id = ${organizationId}::uuid AND archived_at IS NULL
          AND node_type <> 'credential'
        ORDER BY criticality DESC, node_type, name
        LIMIT 300
      `;
}

export function listCredentials(tx: HelmTx, organizationId: string): Promise<CredentialRow[]> {
  return tx<CredentialRow[]>`
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
      `;
}

export function listExpiries(tx: HelmTx, organizationId: string): Promise<ExpiryRow[]> {
  return tx<ExpiryRow[]>`
        SELECT id, label, kind::text, expires_at, severity::text, days_remaining
        FROM v_expiration_dashboard
        WHERE organization_id = ${organizationId}::uuid
        ORDER BY expires_at LIMIT 200
      `;
}

export async function readClientHealth(tx: HelmTx, organizationId: string): Promise<HealthRow | undefined> {
  const [row] = await tx<HealthRow[]>`
        SELECT health, expired_count, critical_count, warning_count, reasons
        FROM v_client_health WHERE organization_id = ${organizationId}::uuid
      `;
  return row;
}

/**
 * The client's whole document tree, metadata only, in two reads.
 *
 * RLS decides what comes back — an internal-only folder and everything under
 * it simply is not in these rows for a co-managed client actor, which is why
 * the modal has no visibility logic of its own. Archived documents ARE
 * fetched: they are hidden by default and shown behind a checkbox, and they
 * are the reason a folder delete is refused.
 */
export function listDocumentFolders(tx: HelmTx, organizationId: string): Promise<FolderQueryRow[]> {
  return tx<FolderQueryRow[]>`
        SELECT id, parent_id, name, is_internal_only
        FROM document_folder
        WHERE organization_id = ${organizationId}::uuid
        ORDER BY name
      `;
}

/** The files attached to one written document (0810). */
export function listPageAttachments(tx: HelmTx, pageId: string): Promise<DocumentQueryRow[]> {
  return tx<DocumentQueryRow[]>`
        SELECT a.id, a.folder_id, a.filename, a.content_type, a.byte_size,
               a.is_internal_only, a.archived_at, a.uploaded_at,
               coalesce(u.name, u.email::text) AS uploaded_by_name
        FROM attachment a
        LEFT JOIN app_user u ON u.id = a.uploaded_by
        WHERE a.page_id = ${pageId}::uuid AND a.deleted_at IS NULL
        ORDER BY a.archived_at IS NOT NULL, lower(a.filename)
        LIMIT 500
      `;
}

/** The files attached to one asset (0780): not documents, so not in the tree. */
export function listNodeAttachments(tx: HelmTx, nodeId: string): Promise<DocumentQueryRow[]> {
  return tx<DocumentQueryRow[]>`
        SELECT a.id, a.folder_id, a.filename, a.content_type, a.byte_size,
               a.is_internal_only, a.archived_at, a.uploaded_at,
               coalesce(u.name, u.email::text) AS uploaded_by_name
        FROM attachment a
        LEFT JOIN app_user u ON u.id = a.uploaded_by
        WHERE a.node_id = ${nodeId}::uuid AND a.deleted_at IS NULL
        ORDER BY a.archived_at IS NOT NULL, lower(a.filename)
        LIMIT 500
      `;
}

export function listDocuments(tx: HelmTx, organizationId: string): Promise<DocumentQueryRow[]> {
  return tx<DocumentQueryRow[]>`
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
      `;
}
