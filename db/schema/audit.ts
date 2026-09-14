/**
 * The audit log.
 *
 * Declared for READING. Writes go through helm.audit() — `helm_app` holds no
 * INSERT, UPDATE or DELETE privilege on this table, and an immutability trigger
 * rejects modification regardless of role. An `insert(auditLog)` through this
 * client will be refused by the database.
 *
 * The table is RANGE-partitioned by month; Drizzle models it as an ordinary
 * table, which is correct for querying through the parent.
 */
import { bigint, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea, inet, tstz } from './_types';
import { actorType, auditOutcome } from './enums';
import { tenant } from './tenancy';

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).notNull(),
  eventUid: uuid('event_uid').notNull().defaultRandom(),
  occurredAt: tstz('occurred_at').notNull().defaultNow(),
  tenantId: uuid('tenant_id').notNull(),

  actorType: actorType('actor_type').notNull(),
  actorId: uuid('actor_id'),
  /** Denormalised: deleting a user must not erase what they did. */
  actorLabel: text('actor_label').notNull(),
  actorRoleKey: text('actor_role_key'),
  apiTokenId: uuid('api_token_id'),

  action: text('action').notNull(),
  outcome: auditOutcome('outcome').notNull().default('success'),

  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  organizationId: uuid('organization_id'),
  nodeId: uuid('node_id'),

  reason: text('reason'),
  /** Non-sensitive detail only; a trigger rejects secret-bearing keys. */
  metadata: jsonb('metadata').notNull().default({}),

  requestId: text('request_id'),
  sessionId: text('session_id'),
  ip: inet('ip'),
  userAgent: text('user_agent'),

  /** Per-tenant hash chain. */
  chainSeq: bigint('chain_seq', { mode: 'number' }).notNull(),
  prevHash: bytea('prev_hash').notNull(),
  rowHash: bytea('row_hash').notNull(),
}, (t) => [
  index('audit_log_tenant_time_idx').on(t.tenantId, t.occurredAt),
  index('audit_log_entity_idx').on(t.tenantId, t.entityType, t.entityId),
  uniqueIndex('audit_log_chain_idx').on(t.tenantId, t.chainSeq, t.occurredAt),
]);

/**
 * Tip of each tenant's chain. Mirror this to WORM storage: it is one small row
 * per tenant and it commits the entire history, which is what turns
 * tamper-evidence into something an attacker with database access cannot undo.
 */
export const auditChainHead = pgTable('audit_chain_head', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenant.id, { onDelete: 'restrict' }),
  chainSeq: bigint('chain_seq', { mode: 'number' }).notNull().default(0),
  headHash: bytea('head_hash').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  anchoredSeq: bigint('anchored_seq', { mode: 'number' }).notNull().default(0),
  anchoredAt: tstz('anchored_at'),
  anchorRef: text('anchor_ref'),
});

export type AuditLog = typeof auditLog.$inferSelect;
export type AuditChainHead = typeof auditChainHead.$inferSelect;

/** Action strings written by the SQL layer. Extend as call sites are added. */
export const AUDIT_ACTIONS = {
  secretRevealed: 'secret.revealed',
  secretRevealDenied: 'secret.reveal_denied',
  secretCreated: 'secret.created',
  secretRotated: 'secret.rotated',
  secretCopied: 'secret.copied',
  secretWriteDenied: 'secret.write_denied',
} as const;

export interface AuditChainVerification {
  verifiedRows: number;
  firstSeq: number | null;
  lastSeq: number | null;
  isIntact: boolean;
  brokenAtSeq: number | null;
  brokenEventUid: string | null;
  detail: string;
}
