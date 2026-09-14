/**
 * Enum types.
 *
 * These mirror the `CREATE TYPE ... AS ENUM` statements in db/sql. `pnpm
 * db:drift` compares the two; a mismatch here is a type lie, not a cosmetic
 * difference — Drizzle will happily let you write a value the database rejects.
 */
import { pgEnum } from 'drizzle-orm/pg-core';

export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended', 'archived']);

export const organizationStatus = pgEnum('organization_status', [
  'prospect', 'onboarding', 'active', 'co_managed', 'offboarding', 'former',
]);

export const actorType = pgEnum('actor_type', ['user', 'service_account', 'system', 'integration']);

export const membershipStatus = pgEnum('membership_status', ['invited', 'active', 'suspended', 'revoked']);

export const apiTokenType = pgEnum('api_token_type', ['service_account', 'user_pat', 'browser_extension']);

export const dataKeyStatus = pgEnum('data_key_status', ['pending', 'active', 'retiring', 'retired', 'destroyed']);

export const secretKind = pgEnum('secret_kind', [
  'password', 'api_key', 'private_key', 'certificate', 'totp_seed',
  'connection_string', 'ssh_key', 'recovery_code', 'license_key', 'generic',
]);

export const secretSensitivity = pgEnum('secret_sensitivity', ['standard', 'elevated', 'critical']);

export const nodeType = pgEnum('node_type', [
  'device', 'network', 'ip_address', 'domain', 'ssl_certificate',
  'application', 'directory_service', 'contract', 'license',
  'isp_circuit', 'credential', 'sop', 'flexible_asset', 'vendor',
]);

export const nodeStatus = pgEnum('node_status', ['planned', 'active', 'maintenance', 'retired', 'decommissioned']);

export const linkRelation = pgEnum('link_relation', [
  'depends_on', 'supports',
  'hosted_on', 'hosts',
  'connects_to',
  'member_of', 'contains',
  'secures', 'secured_by',
  'resolves_to', 'resolved_by',
  'authenticates_to', 'authenticates',
  'backs_up', 'backed_up_by',
  'licenses', 'licensed_by',
  'documents', 'documented_by',
  'replaces', 'replaced_by',
  'related_to',
]);

export const linkOrigin = pgEnum('link_origin', ['manual', 'intrinsic', 'discovered', 'imported']);

export const deviceType = pgEnum('device_type', [
  'server', 'workstation', 'laptop', 'virtual_machine', 'hypervisor',
  'firewall', 'router', 'switch', 'access_point', 'nas', 'san',
  'printer', 'ups', 'camera', 'phone_system', 'iot', 'other',
]);

export const networkKind = pgEnum('network_kind', ['vlan', 'subnet', 'wan', 'vpn', 'wifi', 'management']);

export const ipAssignment = pgEnum('ip_assignment', ['static', 'dhcp', 'dhcp_reservation', 'virtual', 'floating']);

export const directoryKind = pgEnum('directory_kind', [
  'active_directory', 'entra_id', 'hybrid', 'ldap', 'google_workspace', 'okta',
]);

export const certificateIssuance = pgEnum('certificate_issuance', ['public_ca', 'internal_ca', 'self_signed', 'acme']);

export const credentialType = pgEnum('credential_type', [
  'local_admin', 'domain_admin', 'service_account', 'standard_user',
  'api', 'database', 'wifi', 'vpn', 'root', 'recovery', 'shared_mailbox', 'other',
]);

export const domainMatchType = pgEnum('domain_match_type', ['exact_host', 'registrable_domain', 'subdomain_of']);

export const schemaVersionStatus = pgEnum('schema_version_status', ['draft', 'published', 'deprecated']);

export const sopStepKind = pgEnum('sop_step_kind', [
  'manual', 'verification', 'command', 'link', 'approval', 'decision',
]);

export const sopRunStatus = pgEnum('sop_run_status', [
  'not_started', 'in_progress', 'blocked', 'completed', 'abandoned',
]);

export const sopStepStatus = pgEnum('sop_step_status', [
  'pending', 'in_progress', 'done', 'skipped', 'blocked', 'failed', 'not_applicable',
]);

export const expirationKind = pgEnum('expiration_kind', [
  'ssl_certificate', 'domain_registration', 'device_warranty', 'device_eol',
  'license', 'contract', 'isp_contract', 'credential_rotation',
  'api_token', 'sop_review', 'data_key_rotation',
]);

export const alertSeverity = pgEnum('alert_severity', ['info', 'notice', 'warning', 'critical', 'expired']);

export const integrationProvider = pgEnum('integration_provider', [
  'ninja_one', 'n_able_ncentral', 'n_able_rmm', 'datto_rmm',
  'connectwise_manage', 'connectwise_automate', 'halo_psa', 'autotask',
  'microsoft_graph', 'custom',
]);

export const integrationStatus = pgEnum('integration_status', ['configured', 'active', 'degraded', 'error', 'disabled']);

export const syncDirection = pgEnum('sync_direction', ['inbound', 'outbound', 'bidirectional']);

export const syncRunStatus = pgEnum('sync_run_status', ['queued', 'running', 'success', 'partial', 'failed', 'cancelled']);

export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', ['pending', 'delivered', 'failed', 'dead']);

export const attachmentScanStatus = pgEnum('attachment_scan_status', ['pending', 'clean', 'infected', 'failed', 'skipped']);

export const exportKind = pgEnum('export_kind', [
  'client_offboarding', 'compliance_audit', 'disaster_recovery', 'asset_inventory', 'ad_hoc',
]);

export const exportStatus = pgEnum('export_status', ['queued', 'running', 'completed', 'failed', 'expired', 'revoked']);

export const auditOutcome = pgEnum('audit_outcome', ['success', 'denied', 'error']);
