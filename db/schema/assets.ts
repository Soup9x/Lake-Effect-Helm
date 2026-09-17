/**
 * The asset graph: the asset_node supertype, its concrete subtypes, and links.
 *
 * Subtype tables share `id` with their asset_node row. In SQL each declares
 * composite FKs on (id, tenant_id) and (id, node_type) so a subtype row can
 * neither cross tenants nor attach to a node of the wrong kind. Drizzle cannot
 * express those, so joins here are written on `id` and the guarantee lives in
 * db/sql/0060_core_assets.sql.
 */
import { boolean, char, date, index, integer, jsonb, numeric, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { cidr, citext, citextArray, inet, inetArray, macaddr, textArray, tstz } from './_types';
import {
  certificateIssuance, deviceType, directoryKind, ipAssignment,
  linkOrigin, linkRelation, networkKind, nodeStatus, nodeType,
} from './enums';
import { appUser } from './identity';
import { secret } from './secrets';

export const assetNode = pgTable('asset_node', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  siteId: uuid('site_id'),

  nodeType: nodeType('node_type').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  /** Informal context. `description` is what this asset IS; notes are what somebody needs to know about it. */
  notes: text('notes'),
  status: nodeStatus('status').notNull().default('active'),

  tags: textArray('tags').notNull().default([]),
  /** Documentation a co-managed client must never see. */
  isInternalOnly: boolean('is_internal_only').notNull().default(false),
  externalRef: text('external_ref'),
  /** 1 = cosmetic, 5 = business stops. */
  criticality: smallint('criticality').notNull().default(3),

  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => appUser.id, { onDelete: 'set null' }),
  archivedAt: tstz('archived_at'),
}, (t) => [
  index('asset_node_org_type_idx').on(t.tenantId, t.organizationId, t.nodeType),
  index('asset_node_site_idx').on(t.siteId),
]);

export const assetLink = pgTable('asset_link', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  sourceNodeId: uuid('source_node_id').notNull(),
  targetNodeId: uuid('target_node_id').notNull(),
  relation: linkRelation('relation').notNull(),
  origin: linkOrigin('origin').notNull().default('manual'),
  note: text('note'),
  confidence: smallint('confidence').notNull().default(100),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('asset_link_uk').on(t.sourceNodeId, t.targetNodeId, t.relation),
  index('asset_link_source_idx').on(t.sourceNodeId, t.relation),
  index('asset_link_target_idx').on(t.targetNodeId, t.relation),
]);

export const vendor = pgTable('vendor', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('vendor'),
  legalName: text('legal_name'),
  supportPhone: text('support_phone'),
  supportEmail: citext('support_email'),
  supportUrl: text('support_url'),
  supportHours: text('support_hours'),
  accountNumber: text('account_number'),
  escalationPath: text('escalation_path'),
});

export const network = pgTable('network', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('network'),
  kind: networkKind('kind').notNull(),
  cidr: cidr('cidr'),
  vlanId: integer('vlan_id'),
  gateway: inet('gateway'),
  dnsServers: inetArray('dns_servers'),
  dhcpRangeStart: inet('dhcp_range_start'),
  dhcpRangeEnd: inet('dhcp_range_end'),
  dhcpServerNodeId: uuid('dhcp_server_node_id'),
  ssid: text('ssid'),
  purpose: text('purpose'),
  isGuest: boolean('is_guest').notNull().default(false),
});

export const device = pgTable('device', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('device'),
  deviceType: deviceType('device_type').notNull(),
  hostname: citext('hostname'),
  fqdn: citext('fqdn'),
  manufacturer: text('manufacturer'),
  model: text('model'),
  serialNumber: text('serial_number'),
  assetTag: text('asset_tag'),
  operatingSystem: text('operating_system'),
  osVersion: text('os_version'),
  cpu: text('cpu'),
  memoryGb: numeric('memory_gb', { precision: 8, scale: 2 }),
  storageGb: numeric('storage_gb', { precision: 10, scale: 2 }),
  primaryMac: macaddr('primary_mac'),
  managementUrl: text('management_url'),
  primaryNetworkId: uuid('primary_network_id'),
  parentDeviceId: uuid('parent_device_id'),
  purchasedAt: date('purchased_at'),
  warrantyExpiresAt: date('warranty_expires_at'),
  endOfLifeAt: date('end_of_life_at'),
  lastSeenAt: tstz('last_seen_at'),
  rmmDeviceId: text('rmm_device_id'),
  backupPolicy: text('backup_policy'),
  monitoringEnabled: boolean('monitoring_enabled').notNull().default(true),
}, (t) => [
  index('device_hostname_idx').on(t.tenantId, t.hostname),
  index('device_serial_idx').on(t.tenantId, t.serialNumber),
]);

export const ipAddress = pgTable('ip_address', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('ip_address'),
  address: inet('address').notNull(),
  assignment: ipAssignment('assignment').notNull().default('static'),
  isPublic: boolean('is_public').notNull().default(false),
  networkId: uuid('network_id'),
  assignedNodeId: uuid('assigned_node_id'),
  ptrRecord: citext('ptr_record'),
  purpose: text('purpose'),
});

export const domain = pgTable('domain', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('domain'),
  domainName: citext('domain_name').notNull(),
  registrar: text('registrar'),
  registrarVendorId: uuid('registrar_vendor_id'),
  registeredAt: date('registered_at'),
  expiresAt: date('expires_at'),
  autoRenew: boolean('auto_renew').notNull().default(false),
  nameservers: textArray('nameservers'),
  dnsProvider: text('dns_provider'),
  /** Its absence during an offboarding dispute is how domains get stolen. */
  transferLocked: boolean('transfer_locked'),
  whoisPrivacy: boolean('whois_privacy'),
  dnssecEnabled: boolean('dnssec_enabled').notNull().default(false),
  registrarCredentialId: uuid('registrar_credential_id'),
}, (t) => [uniqueIndex('domain_name_uk').on(t.tenantId, t.domainName)]);

export const sslCertificate = pgTable('ssl_certificate', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('ssl_certificate'),
  commonName: citext('common_name').notNull(),
  subjectAltNames: citextArray('subject_alt_names').notNull().default([]),
  issuer: text('issuer'),
  issuance: certificateIssuance('issuance').notNull().default('public_ca'),
  serialNumber: text('serial_number'),
  fingerprintSha256: text('fingerprint_sha256'),
  keyAlgorithm: text('key_algorithm'),
  keySize: integer('key_size'),
  notBefore: tstz('not_before'),
  notAfter: tstz('not_after'),
  autoRenew: boolean('auto_renew').notNull().default(false),
  renewalMethod: text('renewal_method'),
  domainId: uuid('domain_id'),
  installedOnNodeId: uuid('installed_on_node_id'),
  privateKeySecretId: uuid('private_key_secret_id'),
}, (t) => [index('ssl_expiry_idx').on(t.tenantId, t.notAfter)]);

export const directoryService = pgTable('directory_service', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('directory_service'),
  kind: directoryKind('kind').notNull(),
  domainName: citext('domain_name'),
  netbiosName: text('netbios_name'),
  forestName: citext('forest_name'),
  functionalLevel: text('functional_level'),
  entraTenantId: uuid('entra_tenant_id'),
  entraPrimaryDomain: citext('entra_primary_domain'),
  syncEnabled: boolean('sync_enabled').notNull().default(false),
  syncTool: text('sync_tool'),
  syncServerNodeId: uuid('sync_server_node_id'),
  passwordPolicyNotes: text('password_policy_notes'),
  fsmoRoles: jsonb('fsmo_roles').notNull().default({}),
});

export const application = pgTable('application', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('application'),
  vendorId: uuid('vendor_id'),
  category: text('category'),
  version: text('version'),
  isSaas: boolean('is_saas').notNull().default(false),
  url: text('url'),
  adminUrl: text('admin_url'),
  hostedOnNodeId: uuid('hosted_on_node_id'),
  databaseNodeId: uuid('database_node_id'),
  authentication: text('authentication'),
  ssoDirectoryId: uuid('sso_directory_id'),
  businessCriticality: smallint('business_criticality'),
  dataClassification: text('data_classification'),
  rtoMinutes: integer('rto_minutes'),
  rpoMinutes: integer('rpo_minutes'),
});

export const ispCircuit = pgTable('isp_circuit', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('isp_circuit'),
  vendorId: uuid('vendor_id'),
  circuitId: text('circuit_id'),
  serviceType: text('service_type'),
  downloadMbps: integer('download_mbps'),
  uploadMbps: integer('upload_mbps'),
  isPrimary: boolean('is_primary').notNull().default(false),
  staticIpBlock: cidr('static_ip_block'),
  handoffDeviceNodeId: uuid('handoff_device_node_id'),
  accountNumber: text('account_number'),
  supportPhone: text('support_phone'),
  contractEndsAt: date('contract_ends_at'),
  monthlyCost: numeric('monthly_cost', { precision: 12, scale: 2 }),
});

export const contract = pgTable('contract', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('contract'),
  vendorId: uuid('vendor_id'),
  contractNumber: text('contract_number'),
  contractType: text('contract_type'),
  startsAt: date('starts_at'),
  endsAt: date('ends_at'),
  autoRenew: boolean('auto_renew').notNull().default(false),
  noticePeriodDays: integer('notice_period_days'),
  value: numeric('value', { precision: 14, scale: 2 }),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  billingCycle: text('billing_cycle'),
  signedByContactId: uuid('signed_by_contact_id'),
});

export const license = pgTable('license', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  nodeType: nodeType('node_type').notNull().default('license'),
  vendorId: uuid('vendor_id'),
  applicationId: uuid('application_id'),
  licenseType: text('license_type'),
  seatsPurchased: integer('seats_purchased'),
  seatsUsed: integer('seats_used'),
  /** Product keys are secrets, not text columns. */
  licenseKeySecretId: uuid('license_key_secret_id').references(() => secret.id, { onDelete: 'set null' }),
  startsAt: date('starts_at'),
  expiresAt: date('expires_at'),
  autoRenew: boolean('auto_renew').notNull().default(false),
  costPerSeat: numeric('cost_per_seat', { precision: 12, scale: 2 }),
});

export type AssetNode = typeof assetNode.$inferSelect;
export type AssetLink = typeof assetLink.$inferSelect;
export type Device = typeof device.$inferSelect;
export type Network = typeof network.$inferSelect;
export type Domain = typeof domain.$inferSelect;
export type SslCertificate = typeof sslCertificate.$inferSelect;

/** Relations that invert to themselves; the rest have a named opposite. */
export const SYMMETRIC_RELATIONS = ['connects_to', 'related_to'] as const;
