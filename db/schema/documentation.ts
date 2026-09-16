/**
 * Credentials, flexible assets, SOPs, expirations, search and files.
 */
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, index, integer, jsonb, pgTable, primaryKey,
  smallint, text, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { bytea, citext, inet, integerArray, textArray, tstz, tsvector } from './_types';
import {
  alertSeverity, attachmentScanStatus, credentialType, domainMatchType,
  expirationKind, exportKind, exportStatus, nodeType, schemaVersionStatus,
  sopRunStatus, sopStepKind, sopStepStatus,
} from './enums';
import { appUser } from './identity';
import { secretKind } from './enums';
import { secret } from './secrets';
import { tenant } from './tenancy';

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
export const credential = pgTable('credential', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('credential'),
  credentialType: credentialType('credential_type').notNull().default('standard_user'),
  username: text('username'),
  url: text('url'),
  notes: text('notes'),

  secretId: uuid('secret_id'),
  totpSecretId: uuid('totp_secret_id'),
  /**
   * Database-generated. Exists only to carry the composite FK that pins the
   * TOTP slot to a secret of kind 'totp_seed'. Never write to it.
   */
  totpSecretKind: secretKind('totp_secret_kind').generatedAlwaysAs(
    sql`CASE WHEN totp_secret_id IS NULL THEN NULL ELSE 'totp_seed'::secret_kind END`,
  ),
  totpAlgorithm: text('totp_algorithm').notNull().default('SHA1'),
  totpDigits: smallint('totp_digits').notNull().default(6),
  totpPeriodSeconds: smallint('totp_period_seconds').notNull().default(30),
  totpIssuer: text('totp_issuer'),
  totpAccount: text('totp_account'),

  isBreakGlass: boolean('is_break_glass').notNull().default(false),
  clientVisible: boolean('client_visible').notNull().default(false),
  lastVerifiedAt: tstz('last_verified_at'),
  verifiedBy: uuid('verified_by').references(() => appUser.id, { onDelete: 'set null' }),
});

export const credentialDomain = pgTable('credential_domain', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  credentialId: uuid('credential_id').notNull(),
  /** Lowercased punycode host. Never unicode — homographs would match. */
  host: citext('host').notNull(),
  matchType: domainMatchType('match_type').notNull().default('exact_host'),
  allowAutofill: boolean('allow_autofill').notNull().default(false),
  requireConfirmation: boolean('require_confirmation').notNull().default(true),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
}, (t) => [
  uniqueIndex('credential_domain_uk').on(t.credentialId, t.host, t.matchType),
  index('credential_domain_lookup_idx').on(t.tenantId, t.host),
]);

// ---------------------------------------------------------------------------
// Flexible assets
// ---------------------------------------------------------------------------
export const flexibleAssetType = pgTable('flexible_asset_type', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon'),
  colour: text('colour'),
  currentVersionId: uuid('current_version_id'),
  isActive: boolean('is_active').notNull().default(true),
  clientVisible: boolean('client_visible').notNull().default(false),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('flexible_type_key_uk').on(t.tenantId, t.key)]);

export const flexibleAssetTypeVersion = pgTable('flexible_asset_type_version', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  typeId: uuid('type_id').notNull(),
  version: integer('version').notNull(),
  status: schemaVersionStatus('status').notNull().default('draft'),
  /** JSON Schema 2020-12. Validated by Ajv on write. */
  jsonSchema: jsonb('json_schema').notNull(),
  uiSchema: jsonb('ui_schema').notNull().default({}),
  /** JSON Pointers to `x-helm-secret` fields, extracted at publish time. */
  secretFields: textArray('secret_fields').notNull().default([]),
  /** Explicit allow-list. Nothing is indexed by default. */
  searchableFields: textArray('searchable_fields').notNull().default([]),
  publishedAt: tstz('published_at'),
  publishedBy: uuid('published_by').references(() => appUser.id, { onDelete: 'set null' }),
  deprecatedAt: tstz('deprecated_at'),
  changeNote: text('change_note'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
}, (t) => [uniqueIndex('flexible_version_uk').on(t.typeId, t.version)]);

export const flexibleAssetRecord = pgTable('flexible_asset_record', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('flexible_asset'),
  typeId: uuid('type_id').notNull(),
  /** Pins the schema this record was validated against. */
  typeVersionId: uuid('type_version_id').notNull(),
  data: jsonb('data').notNull().default({}),
  validatedAt: tstz('validated_at'),
  needsMigration: boolean('needs_migration').notNull().default(false),
}, (t) => [index('flexible_record_type_idx').on(t.tenantId, t.typeId)]);

export const flexibleAssetSecret = pgTable('flexible_asset_secret', {
  recordId: uuid('record_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  /** RFC 6901 JSON Pointer, e.g. "/api_key". */
  fieldPath: text('field_path').notNull(),
  secretId: uuid('secret_id').notNull().references(() => secret.id, { onDelete: 'restrict' }),
  createdAt: tstz('created_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.recordId, t.fieldPath] })]);

// ---------------------------------------------------------------------------
// SOPs
// ---------------------------------------------------------------------------
export const sop = pgTable('sop', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('sop'),
  category: text('category'),
  summary: text('summary'),
  body: text('body'),
  currentVersion: integer('current_version').notNull().default(0),
  reviewIntervalDays: integer('review_interval_days'),
  lastReviewedAt: tstz('last_reviewed_at'),
  reviewedBy: uuid('reviewed_by').references(() => appUser.id, { onDelete: 'set null' }),
  ownerUserId: uuid('owner_user_id').references(() => appUser.id, { onDelete: 'set null' }),
  isGlobal: boolean('is_global').notNull().default(false),
  requiresApproval: boolean('requires_approval').notNull().default(false),
  estimatedMinutes: integer('estimated_minutes'),
});

export const sopStep = pgTable('sop_step', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  sopId: uuid('sop_id').notNull(),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  kind: sopStepKind('kind').notNull().default('manual'),
  isOptional: boolean('is_optional').notNull().default(false),
  requiresEvidence: boolean('requires_evidence').notNull().default(false),
  requiresNote: boolean('requires_note').notNull().default(false),
  credentialNodeId: uuid('credential_node_id'),
  estimatedMinutes: integer('estimated_minutes'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('sop_step_position_uk').on(t.sopId, t.position)]);

export const sopVersion = pgTable('sop_version', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  sopId: uuid('sop_id').notNull(),
  version: integer('version').notNull(),
  snapshot: jsonb('snapshot').notNull(),
  snapshotSha256: bytea('snapshot_sha256').notNull(),
  changeNote: text('change_note'),
  publishedAt: tstz('published_at').notNull().defaultNow(),
  publishedBy: uuid('published_by').references(() => appUser.id, { onDelete: 'set null' }),
}, (t) => [uniqueIndex('sop_version_uk').on(t.sopId, t.version)]);

export const sopRun = pgTable('sop_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  siteId: uuid('site_id'),
  sopId: uuid('sop_id').notNull(),
  /** The frozen procedure this run actually followed. */
  sopVersionId: uuid('sop_version_id').notNull(),
  status: sopRunStatus('status').notNull().default('not_started'),
  title: text('title').notNull(),
  ticketRef: text('ticket_ref'),
  subjectNodeId: uuid('subject_node_id'),
  startedAt: tstz('started_at'),
  startedBy: uuid('started_by').references(() => appUser.id, { onDelete: 'set null' }),
  completedAt: tstz('completed_at'),
  completedBy: uuid('completed_by').references(() => appUser.id, { onDelete: 'set null' }),
  abandonedReason: text('abandoned_reason'),
  approvedAt: tstz('approved_at'),
  approvedBy: uuid('approved_by').references(() => appUser.id, { onDelete: 'set null' }),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [index('sop_run_org_idx').on(t.tenantId, t.organizationId, t.status)]);

export const sopRunStep = pgTable('sop_run_step', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  runId: uuid('run_id').notNull(),
  position: integer('position').notNull(),
  /** Copied, not referenced: a completed run must stay readable. */
  title: text('title').notNull(),
  body: text('body'),
  kind: sopStepKind('kind').notNull(),
  isOptional: boolean('is_optional').notNull().default(false),
  requiresEvidence: boolean('requires_evidence').notNull().default(false),
  status: sopStepStatus('status').notNull().default('pending'),
  note: text('note'),
  evidence: jsonb('evidence').notNull().default({}),
  startedAt: tstz('started_at'),
  completedAt: tstz('completed_at'),
  completedBy: uuid('completed_by').references(() => appUser.id, { onDelete: 'set null' }),
  auditEventUid: uuid('audit_event_uid'),
}, (t) => [uniqueIndex('sop_run_step_position_uk').on(t.runId, t.position)]);

// ---------------------------------------------------------------------------
// Expirations and alerts
// ---------------------------------------------------------------------------
export const expiration = pgTable('expiration', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  kind: expirationKind('kind').notNull(),
  nodeId: uuid('node_id'),
  sourceTable: text('source_table').notNull(),
  sourceId: uuid('source_id').notNull(),
  label: text('label').notNull(),
  expiresAt: tstz('expires_at').notNull(),
  autoRenew: boolean('auto_renew').notNull().default(false),
  criticality: smallint('criticality').notNull().default(3),
  acknowledgedAt: tstz('acknowledged_at'),
  acknowledgedBy: uuid('acknowledged_by').references(() => appUser.id, { onDelete: 'set null' }),
  acknowledgedUntil: tstz('acknowledged_until'),
  acknowledgeNote: text('acknowledge_note'),
  refreshedAt: tstz('refreshed_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('expiration_source_uk').on(t.sourceTable, t.sourceId, t.kind),
  index('expiration_due_idx').on(t.tenantId, t.expiresAt),
]);

export const alertRule = pgTable('alert_rule', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id'),
  name: text('name').notNull(),
  kinds: expirationKind('kinds').array().notNull().default([]),
  leadDays: integerArray('lead_days').notNull(),
  minCriticality: smallint('min_criticality').notNull().default(1),
  channel: text('channel').notNull(),
  target: text('target').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const alertEvent = pgTable('alert_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  ruleId: uuid('rule_id').notNull().references(() => alertRule.id, { onDelete: 'cascade' }),
  expirationId: uuid('expiration_id').notNull().references(() => expiration.id, { onDelete: 'cascade' }),
  leadDay: integer('lead_day').notNull(),
  severity: alertSeverity('severity').notNull(),
  firedAt: tstz('fired_at').notNull().defaultNow(),
  deliveredAt: tstz('delivered_at'),
  deliveryStatus: text('delivery_status').notNull().default('pending'),
  deliveryError: text('delivery_error'),
  payload: jsonb('payload').notNull().default({}),
}, (t) => [
  /** Idempotency: one notification per rule, per expiry, per threshold. */
  uniqueIndex('alert_event_uk').on(t.ruleId, t.expirationId, t.leadDay),
]);

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
export const searchDocument = pgTable('search_document', {
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  siteId: uuid('site_id'),
  title: text('title').notNull(),
  subtitle: text('subtitle'),
  body: text('body'),
  /** Exact handles: hostnames, serials, IPs. Lowercased, unstemmed. */
  identifiers: textArray('identifiers').notNull().default([]),
  tags: textArray('tags').notNull().default([]),
  nodeId: uuid('node_id'),
  isInternalOnly: boolean('is_internal_only').notNull().default(false),
  clientVisible: boolean('client_visible').notNull().default(false),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  /**
   * Database-generated weighted vector. Declared so drift detection can see it;
   * it is never written from the application.
   */
  tsv: tsvector('tsv').generatedAlwaysAs(
    sql`setweight(to_tsvector('english', coalesce(title, '')), 'A')
     || setweight(array_to_tsvector(identifiers), 'A')
     || setweight(to_tsvector('english', coalesce(subtitle, '')), 'B')
     || setweight(array_to_tsvector(tags), 'B')
     || setweight(to_tsvector('english', coalesce(body, '')), 'D')`,
  ),
}, (t) => [primaryKey({ columns: [t.entityType, t.entityId] })]);

// ---------------------------------------------------------------------------
// Files, notes, exports
// ---------------------------------------------------------------------------
export const attachment = pgTable('attachment', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  nodeId: uuid('node_id'),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  storageKey: text('storage_key').notNull().unique(),
  contentSha256: bytea('content_sha256').notNull(),
  dataKeyId: uuid('data_key_id'),
  encryptionNonce: bytea('encryption_nonce'),
  scanStatus: attachmentScanStatus('scan_status').notNull().default('pending'),
  scannedAt: tstz('scanned_at'),
  isInternalOnly: boolean('is_internal_only').notNull().default(false),
  uploadedAt: tstz('uploaded_at').notNull().defaultNow(),
  uploadedBy: uuid('uploaded_by').references(() => appUser.id, { onDelete: 'set null' }),
  deletedAt: tstz('deleted_at'),
});

export const note = pgTable('note', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  nodeId: uuid('node_id'),
  body: text('body').notNull(),
  isInternalOnly: boolean('is_internal_only').notNull().default(true),
  isPinned: boolean('is_pinned').notNull().default(false),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  deletedAt: tstz('deleted_at'),
});

export const exportJob = pgTable('export_job', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  kind: exportKind('kind').notNull(),
  format: text('format').notNull(),
  status: exportStatus('status').notNull().default('queued'),
  /** Turning this on is a separately-permissioned, separately-audited act. */
  includeSecrets: boolean('include_secrets').notNull().default(false),
  scope: jsonb('scope').notNull().default({}),
  reason: text('reason').notNull(),
  requestedBy: uuid('requested_by').references(() => appUser.id, { onDelete: 'set null' }),
  /** Secret-bearing exports require a second person; enforced by CHECK. */
  approvedBy: uuid('approved_by').references(() => appUser.id, { onDelete: 'set null' }),
  approvedAt: tstz('approved_at'),
  storageKey: text('storage_key'),
  byteSize: bigint('byte_size', { mode: 'number' }),
  contentSha256: bytea('content_sha256'),
  encryptionMethod: text('encryption_method'),
  recordCount: integer('record_count'),
  secretCount: integer('secret_count'),
  startedAt: tstz('started_at'),
  completedAt: tstz('completed_at'),
  error: text('error'),
  expiresAt: tstz('expires_at').notNull(),
  downloadedCount: integer('downloaded_count').notNull().default(0),
  lastDownloadedAt: tstz('last_downloaded_at'),
  revokedAt: tstz('revoked_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),

  /**
   * Digest of the scope at the moment of approval. helm.export_backlog()
   * recomputes it and refuses to render when it no longer matches, so a job
   * widened after review cannot ride that review.
   */
  approvedScopeSha256: bytea('approved_scope_sha256'),
  /** Secrets the render could not include, and why. Never silently dropped. */
  omittedSecretCount: integer('omitted_secret_count').notNull().default(0),
  omissions: jsonb('omissions').notNull().default([]),
});

export const exportDownload = pgTable('export_download', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  exportJobId: uuid('export_job_id').notNull().references(() => exportJob.id, { onDelete: 'cascade' }),
  downloadedAt: tstz('downloaded_at').notNull().defaultNow(),
  downloadedBy: uuid('downloaded_by').references(() => appUser.id, { onDelete: 'set null' }),
  ip: inet('ip'),
  userAgent: text('user_agent'),
});

export type Credential = typeof credential.$inferSelect;
export type FlexibleAssetType = typeof flexibleAssetType.$inferSelect;
export type FlexibleAssetTypeVersion = typeof flexibleAssetTypeVersion.$inferSelect;
export type FlexibleAssetRecord = typeof flexibleAssetRecord.$inferSelect;
export type Sop = typeof sop.$inferSelect;
export type SopRun = typeof sopRun.$inferSelect;
export type Expiration = typeof expiration.$inferSelect;
export type ExportJob = typeof exportJob.$inferSelect;
