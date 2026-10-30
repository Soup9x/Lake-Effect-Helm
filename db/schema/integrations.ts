/**
 * RMM / PSA / Graph integrations and outbound webhooks.
 *
 * Integration credentials are never columns here: `credentialSecretIds` maps a
 * role name to a secret uuid, and the sync worker resolves it through
 * helm.reveal_secret() so machine access to a client's RMM key is audited
 * exactly like a technician's.
 */
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea, citext, textArray, tstz } from './_types';
import {
  integrationProvider, integrationStatus, syncDirection,
  emailDelivery, notificationTransport, smtpSecurity, syncRunStatus, taskReminderKind,
  webhookDeliveryStatus, webhookFormat,
} from './enums';
import { appUser } from './identity';
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
  /** Field -> what the sync last wrote (0980); a field that differs was edited by a person. */
  applied: jsonb('applied').notNull().default({}),
  /** What the integration reports beyond the record's own columns, shown read-only (1080). */
  profile: jsonb('profile'),
}, (t) => [
  uniqueIndex('external_identity_external_uk').on(t.connectionId, t.externalType, t.externalId),
  uniqueIndex('external_identity_node_uk').on(t.connectionId, t.nodeId, t.externalType),
]);

/**
 * NinjaOne's organisations and the client each imports to (0980). A null
 * organization is listed and not imported; excludedAt says whether somebody
 * chose that or nobody has decided yet (1070).
 */
export const ninjaOrganization = pgTable('ninja_organization', {
  tenantId: uuid('tenant_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  ninjaOrgId: text('ninja_org_id').notNull(),
  name: text('name').notNull(),
  organizationId: uuid('organization_id'),
  deviceCount: integer('device_count'),
  seenAt: tstz('seen_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  excludedAt: tstz('excluded_at'),
}, (t) => [
  primaryKey({ columns: [t.connectionId, t.ninjaOrgId] }),
]);

/**
 * Action1's organizations and the client each imports to (1160), as NinjaOne's
 * are: a null organization is listed and not imported, and excludedAt says
 * whether somebody chose that or nobody has decided yet.
 */
export const action1Organization = pgTable('action1_organization', {
  tenantId: uuid('tenant_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  action1OrgId: text('action1_org_id').notNull(),
  name: text('name').notNull(),
  organizationId: uuid('organization_id'),
  excludedAt: tstz('excluded_at'),
  deviceCount: integer('device_count'),
  seenAt: tstz('seen_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.connectionId, t.action1OrgId] }),
]);

/**
 * NinjaOne's locations and the site each became (1080). applied is what the
 * sync last wrote to the site, so a field somebody edited is left alone.
 */
export const ninjaLocation = pgTable('ninja_location', {
  tenantId: uuid('tenant_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  ninjaLocationId: text('ninja_location_id').notNull(),
  ninjaOrgId: text('ninja_org_id'),
  name: text('name').notNull(),
  siteId: uuid('site_id'),
  applied: jsonb('applied').notNull().default({}),
  seenAt: tstz('seen_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.connectionId, t.ninjaLocationId] }),
  index('ninja_location_site_idx').on(t.siteId),
]);

/**
 * A Microsoft 365 user and the contact it became (0990). Contacts are not
 * asset nodes, so this is external_identity's idea for them.
 */
export const m365ContactLink = pgTable('m365_contact_link', {
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  graphUserId: text('graph_user_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  payloadSha256: bytea('payload_sha256'),
  applied: jsonb('applied').notNull().default({}),
  lastSyncedAt: tstz('last_synced_at').notNull().defaultNow(),
  /** Department, office, address, aliases, groups: Microsoft 365's, shown read-only (1060). */
  profile: jsonb('profile').notNull().default({}),
}, (t) => [
  primaryKey({ columns: [t.connectionId, t.graphUserId] }),
  uniqueIndex('m365_contact_link_contact_uk').on(t.connectionId, t.contactId),
  index('m365_contact_link_contact_idx').on(t.contactId),
]);

/**
 * Outbound notification destinations (db/sql/0110, reshaped by 0420).
 *
 * Declared here so the drift check can see it, NOT so request-path code can
 * query it: helm_app holds no privilege on this table at all, by column. For
 * Discord and Teams the URL *is* the credential — whoever holds it can post as
 * Helm — so it sits behind helm_worker, which is the role that delivers.
 *
 * 0420 dropped two columns that were wrong once this table carried traffic:
 * `url`, which was a plaintext credential in a table tier3 could read, and
 * `signing_secret_id`, which routed signing through helm.reveal_secret() and
 * would have written an audit row per webhook delivery. Both now live inside
 * one envelope, sealed the same way every other pre-use secret in this schema
 * is.
 */
export const webhookEndpoint = pgTable('webhook_endpoint', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id'),
  name: text('name').notNull(),
  /** Which payload shape: generic, slack, discord or teams. */
  format: webhookFormat('format').notNull().default('generic'),
  /** 0690. Email is a transport here, not a second notification system. */
  transport: notificationTransport('transport').notNull().default('webhook'),
  /**
   * 0690. Plaintext on purpose, unlike the URL: a webhook URL IS the
   * credential, while an address is a destination an administrator has to be
   * able to read. Null for a webhook destination; a CHECK ties each to its
   * transport.
   */
  emailAddress: citext('email_address'),
  events: textArray('events').notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),

  /** Display only. Enough to tell two Discord webhooks apart, showing neither. */
  urlHost: text('url_host'),
  urlDigest: text('url_digest'),
  signingSecretSet: boolean('signing_secret_set').notNull().default(false),

  /** One envelope over {"url": ..., "signingSecret": ...}. */
  wrapProvider: text('wrap_provider'),
  kekId: text('kek_id'),
  wrappedDek: bytea('wrapped_dek'),
  secretCiphertext: bytea('secret_ciphertext'),
  secretNonce: bytea('secret_nonce'),
  secretTag: bytea('secret_tag'),
  secretAad: text('secret_aad'),

  maxAttempts: smallint('max_attempts').notNull().default(6),
  timeoutMs: integer('timeout_ms').notNull().default(5000),
  customHeaders: jsonb('custom_headers').notNull().default({}),

  lastDeliveryAt: tstz('last_delivery_at'),
  lastDeliveryOk: boolean('last_delivery_ok'),
  lastDeliveryError: text('last_delivery_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),

  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => appUser.id, { onDelete: 'set null' }),
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
  /** The one line a human reads. Built in SQL so every format says the same words. */
  subject: text('subject').notNull(),
  organizationId: uuid('organization_id'),
  occurredAt: tstz('occurred_at').notNull().defaultNow(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  deliveredAt: tstz('delivered_at'),
  /** 1220: archived out of the settings page's delivery log. */
  archivedAt: tstz('archived_at'),
}, (t) => [
  /** Same event to the same endpoint exactly once. */
  uniqueIndex('webhook_delivery_uk').on(t.endpointId, t.eventUid),
  index('webhook_delivery_due_idx').on(t.nextAttemptAt),
]);

export type IntegrationConnection = typeof integrationConnection.$inferSelect;
export type ExternalIdentity = typeof externalIdentity.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoint.$inferSelect;

/**
 * How far the audit fan-out has read, per tenant (db/sql/0420).
 *
 * chain_seq rather than a timestamp: the audit chain is contiguous per tenant,
 * so a sequence cannot skip a row the way "everything since t" can when two
 * transactions commit out of order.
 */
export const notificationCursor = pgTable('notification_cursor', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenant.id, { onDelete: 'cascade' }),
  lastChainSeq: bigint('last_chain_seq', { mode: 'number' }).notNull().default(0),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export type NotificationCursor = typeof notificationCursor.$inferSelect;


/**
 * 0690 — the mail relay. One per tenant, off until enabled.
 *
 * The six envelope columns are present here because drift compares against the
 * live catalogue, but helm_app cannot SELECT them: 0690 revokes the table
 * privilege and grants only the display columns back, which is the same
 * construction 0420 uses for the webhook URL.
 */
export const smtpSetting = pgTable('smtp_setting', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenant.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  /** 1010: the relay below, or Graph sendMail through the MSP's own connection. */
  delivery: emailDelivery('delivery').notNull().default('smtp'),
  graphConnectionId: uuid('graph_connection_id'),
  /** Null only when delivery is microsoft_graph and no relay was ever set. */
  host: text('host'),
  port: integer('port').notNull().default(587),
  security: smtpSecurity('security').notNull().default('starttls'),
  tlsVerify: boolean('tls_verify').notNull().default(true),
  /**
   * The relay's certificate in PEM when one is pinned — not a fingerprint. A
   * fingerprint cannot be enforced: Node skips checkServerIdentity entirely
   * when rejectUnauthorized is false, and refuses a self-signed chain before
   * reaching it when true. 0690's header has the measurement.
   */
  tlsPinnedCertificate: text('tls_pinned_certificate'),
  plaintextAcknowledgedAt: tstz('plaintext_acknowledged_at'),
  plaintextAcknowledgedBy: uuid('plaintext_acknowledged_by'),
  username: text('username'),
  passwordSet: boolean('password_set').notNull().default(false),
  wrapProvider: text('wrap_provider'),
  kekId: text('kek_id'),
  wrappedDek: bytea('wrapped_dek'),
  secretCiphertext: bytea('secret_ciphertext'),
  secretNonce: bytea('secret_nonce'),
  secretTag: bytea('secret_tag'),
  secretAad: text('secret_aad'),
  fromAddress: citext('from_address').notNull(),
  fromName: text('from_name'),
  allowedRecipientDomains: textArray('allowed_recipient_domains').notNull().default([]),
  lastSendAt: tstz('last_send_at'),
  lastSendOk: boolean('last_send_ok'),
  lastSendError: text('last_send_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

/**
 * 0690 — what a person wants to be emailed about.
 *
 * Keyed to the MEMBERSHIP rather than the user, so somebody belonging to two
 * tenants decides separately for each. A jsonb set with a SQL validator and
 * NOTIFICATION_KINDS as the TypeScript mirror, which is the construction
 * user_dashboard.widgets and user_sidebar both use.
 */
export const userNotificationPreference = pgTable('user_notification_preference', {
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  kinds: jsonb('kinds').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

/**
 * 0690 — personal reminders about assigned checklist steps.
 *
 * Its own queue rather than webhook_delivery: that table keys on
 * (endpoint, event) and every row belongs to a destination, while these belong
 * to a person. Keyed (step, kind, lead_day), which is 0100's alert_event
 * construction — a job that runs hourly must not remind somebody hourly.
 */
export const taskReminder = pgTable('task_reminder', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  stepId: uuid('step_id').notNull(),
  userId: uuid('user_id').notNull(),
  kind: taskReminderKind('kind').notNull(),
  leadDay: integer('lead_day').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: smallint('attempts').notNull().default(0),
  nextAttemptAt: tstz('next_attempt_at').notNull().defaultNow(),
  lastAttemptAt: tstz('last_attempt_at'),
  error: text('error'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  sentAt: tstz('sent_at'),
});

/**
 * 0700 — the per-person in-app inbox.
 *
 * The one notification table that points INWARDS. webhook_delivery belongs to
 * a destination and task_reminder is a message about to be sent; neither can
 * express "this person has not seen this", which is the whole of what a bell
 * is — hence `readAt`.
 *
 * `dedupeKey` carries two shapes in one column: an audit event_uid, or
 * 'step:<uuid>:<lead>' for a reminder. One column so the uniqueness is one
 * constraint rather than a partial index per shape.
 *
 * Written only by SECURITY DEFINER functions and a trigger on task_reminder.
 * helm_app holds SELECT, DELETE and UPDATE on `readAt` alone — a column grant,
 * because RLS cannot restrict a column and rewriting the subject of a
 * notification about an export would be putting words in Helm's mouth.
 */
export const userNotification = pgTable('user_notification', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  kind: text('kind').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  subject: text('subject').notNull(),
  href: text('href'),
  organizationId: uuid('organization_id'),
  occurredAt: tstz('occurred_at').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  readAt: tstz('read_at'),
});
