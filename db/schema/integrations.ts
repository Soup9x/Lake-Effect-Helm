/**
 * RMM / PSA / Graph integrations and outbound webhooks.
 *
 * Integration credentials are never columns here: `credentialSecretIds` maps a
 * role name to a secret uuid, and the sync worker resolves it through
 * helm.reveal_secret() so machine access to a client's RMM key is audited
 * exactly like a technician's.
 */
import { boolean, index, integer, jsonb, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea, textArray, tstz } from './_types';
import {
  integrationProvider, integrationStatus, syncDirection,
  syncRunStatus, webhookDeliveryStatus,
} from './enums';
import { appUser } from './identity';
import { secret } from './secrets';
import { tenant } from './tenancy';

export const integrationConnection = pgTable('integration_connection', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  /** NULL for a tenant-wide connection; set for a per-client one. */
  organizationId: uuid('organization_id'),
  provider: integrationProvider('provider').notNull(),
  displayName: text('display_name').notNull(),
  status: integrationStatus('status').notNull().default('configured'),
  direction: syncDirection('direction').notNull().default('inbound'),
  baseUrl: text('base_url'),
  /** Non-sensitive configuration only. */
  config: jsonb('config').notNull().default({}),
  /** Role -> secret uuid. References, never material. */
  credentialSecretIds: jsonb('credential_secret_ids').notNull().default({}),
  syncEnabled: boolean('sync_enabled').notNull().default(false),
  syncIntervalMinutes: integer('sync_interval_minutes').notNull().default(60),
  syncCursor: text('sync_cursor'),
  lastSyncAt: tstz('last_sync_at'),
  lastSuccessAt: tstz('last_success_at'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastError: text('last_error'),
  /** Inbound sync must not clobber a technician's manual edit. */
  respectManualEdits: boolean('respect_manual_edits').notNull().default(true),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  disabledAt: tstz('disabled_at'),
}, (t) => [index('integration_due_idx').on(t.tenantId, t.lastSyncAt)]);

export const integrationSyncRun = pgTable('integration_sync_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  status: syncRunStatus('status').notNull().default('queued'),
  triggerSource: text('trigger_source').notNull().default('schedule'),
  startedAt: tstz('started_at'),
  finishedAt: tstz('finished_at'),
  recordsSeen: integer('records_seen').notNull().default(0),
  recordsCreated: integer('records_created').notNull().default(0),
  recordsUpdated: integer('records_updated').notNull().default(0),
  recordsSkipped: integer('records_skipped').notNull().default(0),
  recordsFailed: integer('records_failed').notNull().default(0),
  cursorBefore: text('cursor_before'),
  cursorAfter: text('cursor_after'),
  errorSummary: text('error_summary'),
  details: jsonb('details').notNull().default({}),
}, (t) => [index('sync_run_connection_idx').on(t.connectionId, t.startedAt)]);

export const externalIdentity = pgTable('external_identity', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  nodeId: uuid('node_id').notNull(),
  externalId: text('external_id').notNull(),
  externalType: text('external_type').notNull(),
  externalUrl: text('external_url'),
  payloadSha256: bytea('payload_sha256'),
  lastSyncedAt: tstz('last_synced_at').notNull().defaultNow(),
  /** The external system owns this record; local edits will be overwritten. */
  isAuthoritative: boolean('is_authoritative').notNull().default(false),
}, (t) => [
  uniqueIndex('external_identity_external_uk').on(t.connectionId, t.externalType, t.externalId),
  uniqueIndex('external_identity_node_uk').on(t.connectionId, t.nodeId, t.externalType),
]);

export const webhookEndpoint = pgTable('webhook_endpoint', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id'),
  name: text('name').notNull(),
  url: text('url').notNull(),
  /** HMAC signing key, stored as a secret so it rotates like everything else. */
  signingSecretId: uuid('signing_secret_id').notNull().references(() => secret.id, { onDelete: 'restrict' }),
  events: textArray('events').notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),
  maxAttempts: smallint('max_attempts').notNull().default(6),
  timeoutMs: integer('timeout_ms').notNull().default(5000),
  customHeaders: jsonb('custom_headers').notNull().default({}),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const webhookDelivery = pgTable('webhook_delivery', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  endpointId: uuid('endpoint_id').notNull(),
  eventType: text('event_type').notNull(),
  eventUid: uuid('event_uid').notNull(),
  payload: jsonb('payload').notNull(),
  status: webhookDeliveryStatus('status').notNull().default('pending'),
  attempts: smallint('attempts').notNull().default(0),
  nextAttemptAt: tstz('next_attempt_at').notNull().defaultNow(),
  lastAttemptAt: tstz('last_attempt_at'),
  responseCode: integer('response_code'),
  responseBody: text('response_body'),
  error: text('error'),
  createdAt: tstz('created_at').notNull().defaultNow(),
}, (t) => [
  /** Same event to the same endpoint exactly once. */
  uniqueIndex('webhook_delivery_uk').on(t.endpointId, t.eventUid),
  index('webhook_delivery_due_idx').on(t.nextAttemptAt),
]);

export type IntegrationConnection = typeof integrationConnection.$inferSelect;
export type ExternalIdentity = typeof externalIdentity.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoint.$inferSelect;
