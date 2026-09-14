/**
 * Gathering what goes into an export.
 *
 * Runs inside an ordinary tenant context, so RLS decides what is visible. That
 * is deliberate and load-bearing: the export sees exactly what its actor sees,
 * and a scope restricted to two organisations cannot produce a bundle covering
 * three. Nothing here uses a SECURITY DEFINER read.
 *
 * Secret MATERIAL is not collected here. This module gathers metadata —
 * usernames, URLs, labels, which node a credential belongs to — and the
 * secret ids. Material is resolved separately, one audited reveal per secret,
 * so a 400-credential handover leaves 400 audit rows.
 */
import type { HelmTx } from '../db/client';

/**
 * Every field is explicitly `| undefined` rather than merely optional: this
 * object is parsed from a request body under exactOptionalPropertyTypes, where
 * "absent" and "present and undefined" are different types and JSON only
 * produces the second.
 */
export interface ExportScope {
  /** Restrict to specific asset node ids. Empty means everything in the org. */
  readonly nodeIds?: string[] | undefined;
  /** Restrict to specific node types. Empty means all types. */
  readonly nodeTypes?: string[] | undefined;
  /** Include SOPs. Default true for offboarding, false for an inventory. */
  readonly includeSops?: boolean | undefined;
  /** Include the relationship graph. */
  readonly includeGraph?: boolean | undefined;
}

export interface CollectedExport {
  readonly organization: OrganizationRecord;
  readonly sites: SiteRecord[];
  readonly contacts: ContactRecord[];
  readonly assets: AssetRecord[];
  readonly credentials: CredentialRecord[];
  readonly relationships: RelationshipRecord[];
  readonly expirations: ExpirationRecord[];
  readonly procedures: ProcedureRecord[];
  readonly flexibleAssets: FlexibleAssetRecord[];
  readonly attestation: Attestation;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  legal_name: string | null;
  status: string;
  industry: string | null;
  employee_count: number | null;
  timezone: string | null;
  website: string | null;
  onboarded_at: Date | null;
  offboarded_at: Date | null;
}

export interface SiteRecord {
  id: string; name: string; code: string | null; is_primary: boolean;
  address_line1: string | null; city: string | null; region: string | null;
  postal_code: string | null; country: string | null; main_phone: string | null;
  after_hours_phone: string | null; access_notes: string | null;
}

export interface ContactRecord {
  id: string; first_name: string; last_name: string | null; title: string | null;
  email: string | null; phone: string | null; mobile: string | null;
  is_primary: boolean; is_technical: boolean; is_emergency: boolean; is_authorised: boolean;
}

export interface AssetRecord {
  id: string; node_type: string; name: string; description: string | null;
  status: string; tags: string[]; criticality: number; site_id: string | null;
  /** Subtype columns, flattened. Shape varies by node_type. */
  detail: Record<string, unknown>;
}

export interface CredentialRecord {
  node_id: string; name: string; credential_type: string;
  username: string | null; url: string | null; notes: string | null;
  client_visible: boolean; is_break_glass: boolean;
  secret_id: string | null; secret_label: string | null;
  secret_kind: string | null; sensitivity: string | null;
  totp_secret_id: string | null;
  /**
   * Filled by the render, never by collection. Indexed so the render can write
   * either field by name without casting away the type.
   */
  material?: string | null;
  totp_seed?: string | null;
  [field: string]: unknown;
}

export interface RelationshipRecord {
  source_id: string; source_name: string; relation: string;
  target_id: string; target_name: string;
}

export interface ExpirationRecord {
  kind: string; label: string; expires_at: Date; severity: string; days_remaining: number;
}

export interface ProcedureRecord {
  id: string; name: string; category: string | null; summary: string | null;
  body: string | null; steps: { position: number; title: string; body: string | null }[];
}

export interface FlexibleAssetRecord {
  id: string; name: string; type_name: string; data: Record<string, unknown>;
}

/**
 * What an auditor needs to judge whether the bundle can be trusted.
 *
 * Not decoration. "Was this produced from a database whose audit chain was
 * intact, under a key nobody on the app server could read" is the question
 * behind a compliance export, and answering it inside the artefact means the
 * answer travels with it.
 */
export interface Attestation {
  generatedAt: string;
  tenantName: string;
  auditChainSeq: number;
  auditAnchoredSeq: number;
  auditAnchoredAt: string | null;
  auditAnchorRef: string | null;
  keyCustody: { provider: string; kekId: string; hostHeldKek: boolean; developmentKey: boolean }[];
}

const NODE_DETAIL_SOURCES: ReadonlyMap<string, string> = new Map([
  ['device', 'device'],
  ['network', 'network'],
  ['ip_address', 'ip_address'],
  ['domain', 'domain'],
  ['ssl_certificate', 'ssl_certificate'],
  ['application', 'application'],
  ['directory_service', 'directory_service'],
  ['contract', 'contract'],
  ['license', 'license'],
  ['isp_circuit', 'isp_circuit'],
  ['vendor', 'vendor'],
]);

export async function collectExport(
  tx: HelmTx,
  organizationId: string,
  scope: ExportScope,
): Promise<CollectedExport> {
  const [organization] = await tx<OrganizationRecord[]>`
    SELECT id, name, legal_name, status, industry, employee_count, timezone, website,
           onboarded_at, offboarded_at
    FROM organization
    WHERE id = ${organizationId}::uuid AND deleted_at IS NULL
  `;
  if (!organization) {
    // RLS makes "not yours" and "not there" the same answer, which is the
    // intended behaviour and the reason this message does not distinguish them.
    throw new Error('organisation is not visible in this context');
  }

  const nodeIds = scope.nodeIds ?? [];
  const nodeTypes = scope.nodeTypes ?? [];

  const sites = await tx<SiteRecord[]>`
    SELECT id, name, code, is_primary, address_line1, city, region, postal_code,
           country, main_phone, after_hours_phone, access_notes
    FROM site WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
    ORDER BY is_primary DESC, name
  `;

  const contacts = await tx<ContactRecord[]>`
    SELECT id, first_name, last_name, title, email::text, phone, mobile,
           is_primary, is_technical, is_emergency, is_authorised
    FROM contact WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
    ORDER BY is_primary DESC, last_name, first_name
  `;

  const nodes = await tx<(Omit<AssetRecord, 'detail'> & { detail: null })[]>`
    SELECT id, node_type::text, name, description, status::text, tags, criticality, site_id, NULL AS detail
    FROM asset_node
    WHERE organization_id = ${organizationId}::uuid
      AND archived_at IS NULL
      AND (${nodeIds.length === 0} OR id = ANY(${nodeIds}::uuid[]))
      AND (${nodeTypes.length === 0} OR node_type::text = ANY(${nodeTypes}))
    ORDER BY node_type, name
  `;

  const assets = await attachDetail(tx, nodes);

  const credentials = await tx<CredentialRecord[]>`
    SELECT n.id AS node_id, n.name, c.credential_type::text,
           c.username::text, c.url, c.notes, c.client_visible, c.is_break_glass,
           c.secret_id::text, c.totp_secret_id::text,
           s.label AS secret_label, s.kind::text AS secret_kind, s.sensitivity::text AS sensitivity
    FROM credential c
    JOIN asset_node n ON n.id = c.id
    LEFT JOIN v_secret_metadata s ON s.id = c.secret_id
    WHERE n.organization_id = ${organizationId}::uuid
      AND n.archived_at IS NULL
      AND (${nodeIds.length === 0} OR n.id = ANY(${nodeIds}::uuid[]))
    ORDER BY n.name
  `;

  const relationships = scope.includeGraph === false ? [] : await tx<RelationshipRecord[]>`
    SELECT e.from_node_id AS source_id, sn.name AS source_name, e.relation::text,
           e.to_node_id AS target_id, tn.name AS target_name
    FROM v_asset_edge e
    JOIN asset_node sn ON sn.id = e.from_node_id
    JOIN asset_node tn ON tn.id = e.to_node_id
    WHERE sn.organization_id = ${organizationId}::uuid
      AND tn.organization_id = ${organizationId}::uuid
    ORDER BY sn.name, e.relation, tn.name
  `;

  const expirations = await tx<ExpirationRecord[]>`
    SELECT kind::text, label, expires_at, severity::text, days_remaining
    FROM v_expiration_dashboard
    WHERE organization_id = ${organizationId}::uuid
    ORDER BY expires_at
  `;

  const procedures = scope.includeSops === false ? [] : await collectProcedures(tx, organizationId);

  const flexibleAssets = await tx<FlexibleAssetRecord[]>`
    SELECT n.id, n.name, t.name AS type_name, r.data
    FROM flexible_asset_record r
    JOIN asset_node n ON n.id = r.id
    JOIN flexible_asset_type t ON t.id = r.type_id
    WHERE n.organization_id = ${organizationId}::uuid AND n.archived_at IS NULL
    ORDER BY t.name, n.name
  `;

  return {
    organization,
    sites,
    contacts,
    assets,
    credentials,
    relationships,
    expirations,
    procedures,
    flexibleAssets,
    attestation: await collectAttestation(tx),
  };
}

/**
 * Pull each subtype's columns in one query per type present.
 *
 * Per type rather than a wide LEFT JOIN across eleven tables: the join produces
 * a row of mostly-NULL columns whose names collide (`kind` exists on four of
 * them), and disambiguating that is more code than this loop.
 */
async function attachDetail(
  tx: HelmTx,
  nodes: (Omit<AssetRecord, 'detail'> & { detail: null })[],
): Promise<AssetRecord[]> {
  const byType = new Map<string, string[]>();
  for (const node of nodes) {
    const table = NODE_DETAIL_SOURCES.get(node.node_type);
    if (!table) continue;
    const list = byType.get(table) ?? [];
    list.push(node.id);
    byType.set(table, list);
  }

  const details = new Map<string, Record<string, unknown>>();

  for (const [table, ids] of byType) {
    // The table name comes from NODE_DETAIL_SOURCES, never from input.
    const rows = await tx<{ id: string; row: Record<string, unknown> }[]>`
      SELECT id, to_jsonb(t) - 'id' - 'tenant_id' - 'node_type' AS row
      FROM ${tx(table)} t
      WHERE id = ANY(${ids}::uuid[])
    `;
    for (const row of rows) details.set(row.id, row.row);
  }

  return nodes.map((node) => ({
    id: node.id,
    node_type: node.node_type,
    name: node.name,
    description: node.description,
    status: node.status,
    tags: node.tags,
    criticality: node.criticality,
    site_id: node.site_id,
    detail: details.get(node.id) ?? {},
  }));
}

async function collectProcedures(tx: HelmTx, organizationId: string): Promise<ProcedureRecord[]> {
  const procedures = await tx<Omit<ProcedureRecord, 'steps'>[]>`
    SELECT n.id, n.name, s.category::text, s.summary, s.body
    FROM sop s
    JOIN asset_node n ON n.id = s.id
    WHERE n.organization_id = ${organizationId}::uuid AND n.archived_at IS NULL
    ORDER BY s.category, n.name
  `;

  if (procedures.length === 0) return [];

  const steps = await tx<{ sop_id: string; position: number; title: string; body: string | null }[]>`
    SELECT sop_id, position, title, body
    FROM sop_step
    WHERE sop_id = ANY(${procedures.map((p) => p.id)}::uuid[])
    ORDER BY sop_id, position
  `;

  const grouped = new Map<string, ProcedureRecord['steps']>();
  for (const step of steps) {
    const list = grouped.get(step.sop_id) ?? [];
    list.push({ position: step.position, title: step.title, body: step.body });
    grouped.set(step.sop_id, list);
  }

  return procedures.map((p) => ({ ...p, steps: grouped.get(p.id) ?? [] }));
}

async function collectAttestation(tx: HelmTx): Promise<Attestation> {
  const [tenant] = await tx<{ name: string }[]>`
    SELECT name FROM tenant WHERE id = helm.current_tenant_id()
  `;

  const [head] = await tx<{
    chain_seq: string; anchored_seq: string; anchored_at: Date | null; anchor_ref: string | null;
  }[]>`
    SELECT chain_seq, anchored_seq, anchored_at, anchor_ref
    FROM audit_chain_head WHERE tenant_id = helm.current_tenant_id()
  `;

  const custody = await tx<{
    wrap_provider: string; kek_id: string; host_held_kek: boolean; development_key: boolean;
  }[]>`SELECT wrap_provider, kek_id, host_held_kek, development_key FROM helm.key_custody()`;

  return {
    generatedAt: new Date().toISOString(),
    tenantName: tenant?.name ?? 'unknown',
    auditChainSeq: Number(head?.chain_seq ?? 0),
    auditAnchoredSeq: Number(head?.anchored_seq ?? 0),
    auditAnchoredAt: head?.anchored_at?.toISOString() ?? null,
    auditAnchorRef: head?.anchor_ref ?? null,
    keyCustody: custody.map((k) => ({
      provider: k.wrap_provider,
      kekId: k.kek_id,
      hostHeldKek: k.host_held_kek,
      developmentKey: k.development_key,
    })),
  };
}
