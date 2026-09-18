/**
 * UniFi Network controller mappings and the device inventory they produce.
 *
 * Mirrors db/sql/0430. Declared here so the drift check can see it; the tables
 * themselves are ordinary tenant data reachable from the request path, unlike
 * radius_config or oidc_provider.
 *
 * THE CONTROLLER API KEY IS NOT HERE, deliberately. It lives in `secret` like
 * every other credential, referenced by unifiSiteMapping.apiKeySecretId, so it
 * inherits the reveal ladder, the per-access audit row and the
 * helm_app-writes-but-never-reads boundary rather than re-earning them on a
 * bespoke column.
 */
import { bigint, boolean, index, integer, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea, tstz } from './_types';
import { networkAssetStatus, networkAssetType } from './enums';
import { appUser } from './identity';
import { secret, tenantDataKey } from './secrets';
import { tenant } from './tenancy';

/**
 * One UniFi site, bound to one Helm organisation.
 *
 * TLS: `tlsPinnedSha256` is a PIN, not a verification disable. A pinned
 * self-signed certificate still detects interception. Two CHECK constraints in
 * 0430 make the alternative unrepresentable — verification cannot be off with
 * nothing pinned, and a pin cannot exist without an acknowledgment naming who
 * accepted it.
 */
export const unifiSiteMapping = pgTable('unifi_site_mapping', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id').notNull(),

  name: text('name').notNull(),
  controllerUrl: text('controller_url').notNull(),
  /** The site's id in the Integration API. Text, because it was a slug on older builds. */
  unifiSiteId: text('unifi_site_id').notNull(),

  /** A reference into `secret`. Never a credential column. */
  apiKeySecretId: uuid('api_key_secret_id').references(() => secret.id, { onDelete: 'restrict' }),

  isActive: boolean('is_active').notNull().default(false),

  tlsVerify: boolean('tls_verify').notNull().default(true),
  tlsPinnedSha256: text('tls_pinned_sha256'),
  tlsExceptionAckBy: uuid('tls_exception_ack_by').references(() => appUser.id, { onDelete: 'set null' }),
  tlsExceptionAckAt: tstz('tls_exception_ack_at'),

  /** Per mapping, not hardcoded: a busy site and a quiet one want different numbers. */
  pollIntervalSeconds: integer('poll_interval_seconds').notNull().default(300),

  lastPollAt: tstz('last_poll_at'),
  lastPollOk: boolean('last_poll_ok'),
  lastPollError: text('last_poll_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  nextPollAt: tstz('next_poll_at').notNull().defaultNow(),
  lastDeviceCount: integer('last_device_count'),
  lastClientCount: integer('last_client_count'),

  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => appUser.id, { onDelete: 'set null' }),
}, (t) => [
  uniqueIndex('unifi_mapping_site_uk').on(t.tenantId, t.controllerUrl, t.unifiSiteId),
  index('unifi_mapping_due_idx').on(t.nextPollAt),
]);

/**
 * A device the controller reported, and what a human wrote about it.
 *
 * ENCRYPTION IS PER FIELD, not per table. MAC, IP, hostname, serial and a
 * user's custom name identify a machine and a person; uptime, signal, port and
 * firmware are telemetry with no confidentiality requirement, so they stay
 * queryable. Encrypting the latter would cost a DEK unwrap per row per read and
 * make "which access points are on old firmware" unanswerable in SQL.
 *
 * TWO ENVELOPES. The controller fields and `customNameEnc` are sealed
 * separately so the sync and a user cannot clobber each other — the
 * preservation guarantee is a property of the schema, not a rule the worker has
 * to remember.
 */
export const networkAssets = pgTable('network_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id').notNull(),
  /** SET NULL on mapping removal: losing a controller must not delete the inventory. */
  mappingId: uuid('mapping_id').references(() => unifiSiteMapping.id, { onDelete: 'set null' }),

  assetType: networkAssetType('asset_type').notNull(),

  /** HMAC under the per-tenant blind-index subkey. The upsert key. */
  macBlindIndex: bytea('mac_blind_index').notNull(),

  dataKeyId: uuid('data_key_id').notNull().references(() => tenantDataKey.id, { onDelete: 'restrict' }),
  /** nonce || tag || ciphertext, one envelope per field. */
  macAddressEnc: bytea('mac_address_enc').notNull(),
  ipAddressEnc: bytea('ip_address_enc'),
  hostnameEnc: bytea('hostname_enc'),
  serialEnc: bytea('serial_enc'),

  // Telemetry, in the clear and queryable.
  model: text('model'),
  firmwareVersion: text('firmware_version'),
  deviceState: text('device_state'),
  uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
  signalDbm: smallint('signal_dbm'),
  switchPort: integer('switch_port'),
  uplinkMacBlindIndex: bytea('uplink_mac_blind_index'),
  vlanId: integer('vlan_id'),
  ssid: text('ssid'),
  isWired: boolean('is_wired'),
  isOnline: boolean('is_online').notNull().default(false),
  lastSeenAt: tstz('last_seen_at'),
  lastSyncedAt: tstz('last_synced_at'),

  // User-owned. The sync never writes these.
  customNameEnc: bytea('custom_name_enc'),
  assetTag: text('asset_tag'),
  department: text('department'),
  notes: text('notes'),
  maintenanceStatus: networkAssetStatus('maintenance_status').notNull().default('active'),

  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('network_asset_mac_uk').on(t.tenantId, t.macBlindIndex),
  index('network_asset_lookup_idx').on(t.tenantId, t.macBlindIndex),
  index('network_asset_org_idx').on(t.tenantId, t.organizationId, t.assetType),
]);

/**
 * Where a device has been.
 *
 * Append-on-CHANGE. A device polled every five minutes for a year is a hundred
 * thousand rows of "still .47" and one row of the day it moved; a repeat poll
 * extends the open row instead of writing a new one.
 */
export const assetIpHistory = pgTable('asset_ip_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  assetId: uuid('asset_id').notNull(),

  dataKeyId: uuid('data_key_id').notNull().references(() => tenantDataKey.id, { onDelete: 'restrict' }),
  ipAddressEnc: bytea('ip_address_enc').notNull(),
  /** Indexed: "who held 10.2.0.47 when that alert fired" is why this table exists. */
  ipBlindIndex: bytea('ip_blind_index').notNull(),

  firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
  lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
}, (t) => [
  index('asset_ip_history_asset_idx').on(t.tenantId, t.assetId, t.lastSeenAt),
  index('asset_ip_history_ip_idx').on(t.tenantId, t.ipBlindIndex, t.lastSeenAt),
]);

export type UnifiSiteMapping = typeof unifiSiteMapping.$inferSelect;
export type NetworkAsset = typeof networkAssets.$inferSelect;
export type AssetIpHistory = typeof assetIpHistory.$inferSelect;
