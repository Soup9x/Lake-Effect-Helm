/**
 * Users, Auth.js tables, RBAC and machine identities.
 *
 * The auth_* tables are here so the Auth.js Drizzle adapter can be wired to
 * them, but they are reachable only from the `helm_auth` connection — see
 * db/sql/0220_grants.sql. Do not import them into request-path code.
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, pgTable, primaryKey, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea, citext, inet, inetArray, textArray, tstz, uuidArray } from './_types';
import { apiTokenType, authMethod, membershipStatus } from './enums';
import { tenant } from './tenancy';

export const appRole = pgTable('app_role', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  rank: integer('rank').notNull(),
  isTenantWide: boolean('is_tenant_wide').notNull().default(false),
  isSystem: boolean('is_system').notNull().default(true),
});

export const permission = pgTable('permission', {
  key: text('key').primaryKey(),
  category: text('category').notNull(),
  description: text('description').notNull(),
  mspOnly: boolean('msp_only').notNull().default(false),
});

export const rolePermission = pgTable('role_permission', {
  roleKey: text('role_key').notNull().references(() => appRole.key, { onDelete: 'cascade' }),
  permissionKey: text('permission_key').notNull().references(() => permission.key, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.roleKey, t.permissionKey] })]);

export const appUser = pgTable('app_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  emailVerified: tstz('email_verified'),
  name: text('name'),
  image: text('image'),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  mfaEnrolledAt: tstz('mfa_enrolled_at'),
  lastLoginAt: tstz('last_login_at'),
  disabledAt: tstz('disabled_at'),
  disabledReason: text('disabled_reason'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Auth.js adapter tables. Column names match what @auth/drizzle-adapter expects.
// ---------------------------------------------------------------------------
export const authAccount = pgTable('auth_account', {
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  refresh_token: text('refresh_token'),
  access_token: text('access_token'),
  expires_at: bigint('expires_at', { mode: 'number' }),
  token_type: text('token_type'),
  scope: text('scope'),
  id_token: text('id_token'),
  session_state: text('session_state'),
}, (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })]);

export const authSession = pgTable('auth_session', {
  sessionToken: text('session_token').primaryKey(),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  expires: tstz('expires').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  // Defaults to 'sso' because the Auth.js adapter INSERTs the three columns
  // above and nothing else; the local sign-in path sets it explicitly.
  authMethod: authMethod('auth_method').notNull().default('sso'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
});

export const authVerificationToken = pgTable('auth_verification_token', {
  identifier: text('identifier').notNull(),
  token: text('token').notNull(),
  expires: tstz('expires').notNull(),
}, (t) => [primaryKey({ columns: [t.identifier, t.token] })]);

export const authAuthenticator = pgTable('auth_authenticator', {
  credentialID: text('credential_id').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  providerAccountId: text('provider_account_id').notNull(),
  credentialPublicKey: text('credential_public_key').notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull(),
  credentialDeviceType: text('credential_device_type').notNull(),
  credentialBackedUp: boolean('credential_backed_up').notNull(),
  transports: text('transports'),
  friendlyName: text('friendly_name'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  lastUsedAt: tstz('last_used_at'),
}, (t) => [primaryKey({ columns: [t.userId, t.credentialID] })]);

// ---------------------------------------------------------------------------
// Tenant access
// ---------------------------------------------------------------------------
export const membership = pgTable('membership', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  roleKey: text('role_key').notNull().references(() => appRole.key, { onDelete: 'restrict' }),
  status: membershipStatus('status').notNull().default('active'),

  /** Explicit rather than "NULL means everything" — see db/sql/0020_identity.sql. */
  orgScopeAll: boolean('org_scope_all').notNull().default(false),
  orgScope: uuidArray('org_scope'),

  requireStepUp: boolean('require_step_up').notNull().default(true),
  expiresAt: tstz('expires_at'),
  invitedBy: uuid('invited_by').references(() => appUser.id, { onDelete: 'set null' }),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  revokedAt: tstz('revoked_at'),
  revokedReason: text('revoked_reason'),
}, (t) => [
  uniqueIndex('membership_user_tenant_uk').on(t.tenantId, t.userId),
  index('membership_tenant_idx').on(t.tenantId, t.status),
]);

export const membershipPermission = pgTable('membership_permission', {
  membershipId: uuid('membership_id').notNull().references(() => membership.id, { onDelete: 'cascade' }),
  permissionKey: text('permission_key').notNull().references(() => permission.key, { onDelete: 'cascade' }),
  /** false is a DENY and beats the role grant. */
  granted: boolean('granted').notNull(),
  reason: text('reason').notNull(),
  grantedBy: uuid('granted_by').references(() => appUser.id, { onDelete: 'set null' }),
  createdAt: tstz('created_at').notNull().defaultNow(),
  expiresAt: tstz('expires_at'),
}, (t) => [primaryKey({ columns: [t.membershipId, t.permissionKey] })]);

export const serviceAccount = pgTable('service_account', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  roleKey: text('role_key').notNull().references(() => appRole.key, { onDelete: 'restrict' }),
  orgScopeAll: boolean('org_scope_all').notNull().default(false),
  orgScope: uuidArray('org_scope'),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  disabledAt: tstz('disabled_at'),

  /**
   * Reveal purposes this machine identity may use; null means unrestricted.
   * Enforced inside helm.reveal_secret(), which is what makes it a boundary
   * rather than a hint. See db/sql/0290_worker_identities.sql.
   */
  allowedRevealPurposes: textArray('allowed_reveal_purposes'),
  /** A Helm-managed worker identity. Its authorisation is fixed by trigger. */
  isSystem: boolean('is_system').notNull().default(false),
}, (t) => [uniqueIndex('service_account_name_uk').on(t.tenantId, t.name)]);

export const apiToken = pgTable('api_token', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  tokenType: apiTokenType('token_type').notNull(),
  serviceAccountId: uuid('service_account_id').references(() => serviceAccount.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => appUser.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  /** First 8 characters, for lookup. The token itself is never stored. */
  tokenPrefix: text('token_prefix').notNull().unique(),
  /** sha256 of the token. Compare in constant time. */
  tokenHash: bytea('token_hash').notNull(),
  scopes: textArray('scopes').notNull().default([]),
  ipAllowlist: inetArray('ip_allowlist'),

  lastUsedAt: tstz('last_used_at'),
  lastUsedIp: inet('last_used_ip'),
  useCount: bigint('use_count', { mode: 'number' }).notNull().default(0),
  expiresAt: tstz('expires_at'),
  revokedAt: tstz('revoked_at'),
  revokedReason: text('revoked_reason'),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const browserExtensionInstall = pgTable('browser_extension_install', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  apiTokenId: uuid('api_token_id').references(() => apiToken.id, { onDelete: 'set null' }),
  deviceLabel: text('device_label').notNull(),
  devicePublicKey: bytea('device_public_key').notNull(),
  browser: text('browser'),
  extensionVersion: text('extension_version'),
  approvedAt: tstz('approved_at'),
  approvedBy: uuid('approved_by').references(() => appUser.id, { onDelete: 'set null' }),
  lastSeenAt: tstz('last_seen_at'),
  lastSeenIp: inet('last_seen_ip'),
  revokedAt: tstz('revoked_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const stepUpVerification = pgTable('step_up_verification', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  method: text('method').notNull(),
  verifiedAt: tstz('verified_at').notNull().defaultNow(),
  expiresAt: tstz('expires_at').notNull(),
  requestId: text('request_id'),
  ip: inet('ip'),
}, (t) => [index('step_up_active_idx').on(t.userId, t.expiresAt)]);

export type AppUser = typeof appUser.$inferSelect;
export type Membership = typeof membership.$inferSelect;
export type ServiceAccount = typeof serviceAccount.$inferSelect;
export type ApiToken = typeof apiToken.$inferSelect;

/** Role ranks, mirroring db/sql/0900_seed_system_data.sql. */
export const ROLE_RANK = {
  super_admin: 100,
  tier3: 80,
  tier2: 60,
  tier1: 40,
  client_admin: 30,
  client_read_only: 20,
  api_service: 10,
} as const satisfies Record<string, number>;

export type RoleKey = keyof typeof ROLE_RANK;

// -----------------------------------------------------------------------------
// Local authentication (db/sql/0340_local_authentication.sql).
//
// Reachable only from the `helm_auth` connection. helm_app holds column grants
// that exclude password_phc and previous_phc, so a query built from this schema
// on the app pool will be refused by the database if it selects either — which
// is the intended outcome, not a bug to work around.
// -----------------------------------------------------------------------------

export const localCredential = pgTable('local_credential', {
  userId: uuid('user_id').primaryKey().references(() => appUser.id, { onDelete: 'cascade' }),
  passwordPhc: text('password_phc').notNull(),
  algorithm: text('algorithm').notNull().default('argon2id'),
  passwordChangedAt: tstz('password_changed_at').notNull().defaultNow(),
  mustChange: boolean('must_change').notNull().default(false),
  previousPhc: textArray('previous_phc').notNull().default(sql`'{}'`),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: tstz('locked_until'),
  lastSuccessAt: tstz('last_success_at'),
  lastFailureAt: tstz('last_failure_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [index('local_credential_locked_idx').on(t.lockedUntil)]);

export const authAttempt = pgTable('auth_attempt', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  occurredAt: tstz('occurred_at').notNull().defaultNow(),
  email: citext('email'),
  userId: uuid('user_id').references(() => appUser.id, { onDelete: 'set null' }),
  ip: inet('ip'),
  outcome: text('outcome').notNull(),
  userAgent: text('user_agent'),
}, (t) => [
  index('auth_attempt_email_idx').on(t.email, t.occurredAt),
  index('auth_attempt_ip_idx').on(t.ip, t.occurredAt),
  index('auth_attempt_pruning_idx').on(t.occurredAt),
]);

export const passwordReset = pgTable('password_reset', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  tokenSha256: bytea('token_sha256').notNull().unique(),
  origin: text('origin').notNull(),
  issuedBy: uuid('issued_by').references(() => appUser.id, { onDelete: 'set null' }),
  expiresAt: tstz('expires_at').notNull(),
  usedAt: tstz('used_at'),
  invalidatedAt: tstz('invalidated_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdIp: inet('created_ip'),
}, (t) => [
  index('password_reset_user_idx').on(t.userId, t.createdAt),
  index('password_reset_live_idx').on(t.expiresAt),
]);

export type LocalCredential = typeof localCredential.$inferSelect;
export type AuthAttempt = typeof authAttempt.$inferSelect;
export type PasswordReset = typeof passwordReset.$inferSelect;

/**
 * RADIUS server settings and the enveloped shared secret (db/sql/0360).
 *
 * Declared here so the drift check can see it, NOT so request-path code can
 * query it: helm_app holds no privilege on this table at all, by design. The
 * shared secret authenticates the RADIUS server to Helm, so it sits behind
 * helm_auth exactly as local_credential.password_phc does.
 *
 * The envelope columns mirror tenant_data_key + secret_version because it is
 * the same construction: a DEK wrapped by the master KEK, and the secret sealed
 * under that DEK with an AAD binding it to this tenant.
 */
export const radiusConfig = pgTable('radius_config', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenant.id, { onDelete: 'cascade' }),

  enabled: boolean('enabled').notNull().default(false),
  host: text('host').notNull(),
  port: integer('port').notNull().default(1812),
  timeoutMs: integer('timeout_ms').notNull().default(5000),
  retries: smallint('retries').notNull().default(2),
  nasIdentifier: text('nas_identifier').notNull().default('lake-effect-helm'),

  wrapProvider: text('wrap_provider').notNull(),
  kekId: text('kek_id').notNull(),
  wrappedDek: bytea('wrapped_dek').notNull(),
  secretCiphertext: bytea('secret_ciphertext').notNull(),
  secretNonce: bytea('secret_nonce').notNull(),
  secretTag: bytea('secret_tag').notNull(),
  secretAad: text('secret_aad').notNull(),

  lastTestAt: tstz('last_test_at'),
  lastTestOk: boolean('last_test_ok'),
  lastTestError: text('last_test_error'),

  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => appUser.id, { onDelete: 'set null' }),
});
