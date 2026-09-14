/**
 * Key hierarchy and AES-256-GCM envelopes.
 *
 * IMPORTANT: `secretVersion` is declared here so its shape is typed, NOT so it
 * can be queried. The `helm_app` role has no SELECT privilege on the underlying
 * table (db/sql/0220_grants.sql) and RLS grants no read policy
 * (db/sql/0200_rls_policies.sql). Any attempt to select from it through Drizzle
 * fails at the database, by design. Use the reveal API in
 * db/sql/0210_secret_access_api.sql, which writes the audit event in the same
 * transaction as the read.
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea, tstz } from './_types';
import { actorType, dataKeyStatus, secretKind, secretSensitivity } from './enums';
import { appUser } from './identity';
import { tenant } from './tenancy';

export const tenantDataKey = pgTable('tenant_data_key', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'restrict' }),
  generation: integer('generation').notNull(),
  status: dataKeyStatus('status').notNull().default('pending'),

  /** DEK encrypted under the KEK. Provider-specific format; never key material. */
  wrappedDek: bytea('wrapped_dek').notNull(),
  wrapProvider: text('wrap_provider').notNull(),
  kekId: text('kek_id').notNull(),
  wrapContext: jsonb('wrap_context').notNull().default({}),
  algorithm: text('algorithm').notNull().default('AES-256-GCM'),

  activatedAt: tstz('activated_at'),
  retiringAt: tstz('retiring_at'),
  retiredAt: tstz('retired_at'),
  destroyedAt: tstz('destroyed_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  rotationReason: text('rotation_reason'),

  /**
   * Database-generated. True when the KEK that wrapped this DEK was readable
   * from the application host — the on-premises master key providers — and
   * false for a KMS or Vault KEK. Generated rather than supplied so a worker
   * cannot mislabel its own key custody. See db/sql/0280_onprem_kek.sql.
   */
  hostHeldKek: boolean('host_held_kek').generatedAlwaysAs(
    sql`wrap_provider = ANY (ARRAY['local-keyfile'::text, 'local-dev'::text])`,
  ),
}, (t) => [
  uniqueIndex('tenant_data_key_generation_uk').on(t.tenantId, t.generation),
  index('tenant_data_key_status_idx').on(t.tenantId, t.status),
]);

export const secret = pgTable('secret', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),

  kind: secretKind('kind').notNull(),
  sensitivity: secretSensitivity('sensitivity').notNull().default('standard'),
  label: text('label').notNull(),
  /** 0 means "no version written yet". */
  currentVersion: integer('current_version').notNull().default(0),

  requiresStepUp: boolean('requires_step_up').notNull().default(false),
  minRoleRank: integer('min_role_rank').notNull().default(40),
  requiresReason: boolean('requires_reason').notNull().default(false),

  rotationIntervalDays: integer('rotation_interval_days'),
  lastRotatedAt: tstz('last_rotated_at'),
  lastAccessedAt: tstz('last_accessed_at'),
  accessCount: bigint('access_count', { mode: 'number' }).notNull().default(0),

  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => appUser.id, { onDelete: 'set null' }),
  deletedAt: tstz('deleted_at'),
}, (t) => [
  index('secret_org_idx').on(t.tenantId, t.organizationId),
]);

/**
 * Ciphertext. Unreadable through this client on purpose — see the file header.
 */
export const secretVersion = pgTable('secret_version', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  secretId: uuid('secret_id').notNull(),
  version: integer('version').notNull(),

  dataKeyId: uuid('data_key_id').notNull(),
  algorithm: text('algorithm').notNull().default('AES-256-GCM'),

  ciphertext: bytea('ciphertext').notNull(),
  /** 96 bits. Unique per data key, enforced by index. */
  nonce: bytea('nonce').notNull(),
  /** 128 bits. */
  authTag: bytea('auth_tag').notNull(),
  /** Binds the ciphertext to tenant|secret|field|version. */
  aad: text('aad').notNull(),

  reuseHmac: bytea('reuse_hmac'),
  strengthScore: smallint('strength_score'),
  plaintextLength: smallint('plaintext_length'),

  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  createdByType: actorType('created_by_type').notNull().default('user'),
  rotationReason: text('rotation_reason'),
}, (t) => [
  uniqueIndex('secret_version_uk').on(t.secretId, t.version),
  uniqueIndex('secret_version_nonce_unique_per_key').on(t.dataKeyId, t.nonce),
]);

export type TenantDataKey = typeof tenantDataKey.$inferSelect;
export type Secret = typeof secret.$inferSelect;

/**
 * The shape helm.reveal_secret() returns. Declared by hand because Drizzle does
 * not generate types for SECURITY DEFINER set-returning functions.
 */
export interface RevealedSecretEnvelope {
  granted: boolean;
  denialReason: string | null;
  auditEventUid: string;
  secretId: string | null;
  version: number | null;
  kind: string | null;
  algorithm: string | null;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  authTag: Buffer | null;
  aad: string | null;
  dataKeyId: string | null;
  wrappedDek: Buffer | null;
  kekId: string | null;
  wrapProvider: string | null;
  wrapContext: Record<string, unknown> | null;
}

export type RevealPurpose = 'view' | 'copy' | 'autofill' | 'export' | 'integration' | 'rotation';

export type RevealDenialReason =
  | 'not_found'
  | 'missing_permission'
  | 'insufficient_role_rank'
  | 'step_up_required'
  | 'reason_required'
  | 'export_not_permitted'
  | 'autofill_not_permitted_for_sensitivity'
  | 'no_such_version'
  | 'key_destroyed';
