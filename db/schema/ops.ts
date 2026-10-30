/**
 * Operations: the instance's own bookkeeping, not a tenant's.
 *
 * Neither table carries tenant_id; 0820 revokes every role but the owner and
 * the application reaches them through SECURITY DEFINER functions. Mirrored
 * here for the drift check and nothing else — no query layer reads them.
 */
import { bigint, boolean, integer, jsonb, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { tstz } from './_types';
import { appUser } from './identity';

export const backupSetting = pgTable('backup_setting', {
  id: smallint('id').primaryKey().default(1),
  enabled: boolean('enabled').notNull().default(false),
  schedule: text('schedule').notNull().default('0 2 * * *'),
  destinationKind: text('destination_kind').notNull().default('local'),
  localSubdir: text('local_subdir').notNull().default(''),
  s3Bucket: text('s3_bucket'),
  s3Prefix: text('s3_prefix').notNull().default('helm'),
  s3Endpoint: text('s3_endpoint'),
  s3Region: text('s3_region').notNull().default('us-east-1'),
  keepDays: integer('keep_days').notNull().default(30),
  keepCount: integer('keep_count').notNull().default(14),
  includeVolumes: boolean('include_volumes').notNull().default(true),
  verifyWeekday: smallint('verify_weekday').default(0),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => appUser.id, { onDelete: 'set null' }),
});

export const backupRun = pgTable('backup_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  trigger: text('trigger').notNull(),
  status: text('status').notNull().default('requested'),
  requestedAt: tstz('requested_at').notNull().defaultNow(),
  requestedBy: uuid('requested_by').references(() => appUser.id, { onDelete: 'set null' }),
  startedAt: tstz('started_at'),
  finishedAt: tstz('finished_at'),
  destination: text('destination'),
  location: text('location'),
  bytes: bigint('bytes', { mode: 'number' }),
  detail: jsonb('detail').notNull().default({}),
  error: text('error'),
});

// 1210: updates requested from the Updates page, and when the host's updater
// last looked for one. Same arrangement as the two above.
export const helmUpdate = pgTable('helm_update', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: text('status').notNull().default('scheduled'),
  targetCommit: text('target_commit').notNull(),
  scheduledFor: tstz('scheduled_for').notNull().defaultNow(),
  requestedAt: tstz('requested_at').notNull().defaultNow(),
  requestedBy: uuid('requested_by').references(() => appUser.id, { onDelete: 'set null' }),
  cancelledAt: tstz('cancelled_at'),
  cancelledBy: uuid('cancelled_by').references(() => appUser.id, { onDelete: 'set null' }),
  startedAt: tstz('started_at'),
  finishedAt: tstz('finished_at'),
  fromCommit: text('from_commit'),
  toCommit: text('to_commit'),
  stage: text('stage'),
  log: text('log'),
  error: text('error'),
});

export const helmUpdater = pgTable('helm_updater', {
  id: smallint('id').primaryKey().default(1),
  lastSeenAt: tstz('last_seen_at').notNull(),
  host: text('host'),
});

// 1220: every version deployed on this server, written by deploy/setup.sh.
export const helmDeploy = pgTable('helm_deploy', {
  id: uuid('id').primaryKey().defaultRandom(),
  deployedAt: tstz('deployed_at').notNull().defaultNow(),
  commit: text('commit').notNull(),
  previousCommit: text('previous_commit'),
  title: text('title'),
  changes: jsonb('changes').notNull().default([]),
  source: text('source').notNull(),
  updateId: uuid('update_id').references(() => helmUpdate.id, { onDelete: 'set null' }),
  hostUser: text('host_user'),
  host: text('host'),
});
