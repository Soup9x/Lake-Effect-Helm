/**
 * Per-user workspace state: favourites, recently viewed, dashboard layout.
 *
 * Everything here belongs to ONE PERSON inside ONE TENANT. The tables carry
 * `user_id` in their primary key and in every RLS policy, which is what
 * separates colleagues rather than merely tenants — see 0370. Queries written
 * against these tables must never filter by tenant alone and assume the policy
 * will do the rest: the policy does, but a reader of the query cannot tell.
 *
 * The composite foreign keys — (organization_id, tenant_id) against
 * organization, (node_id, tenant_id) against asset_node — live only in db/sql,
 * for the same reason as everywhere else in this layer.
 */
import { index, jsonb, pgTable, primaryKey, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tstz } from './_types';
import { appUser } from './identity';
import { tenant } from './tenancy';

export const userFavorite = pgTable('user_favorite', {
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.userId, t.organizationId] }),
  index('user_favorite_user_idx').on(t.tenantId, t.userId, t.createdAt),
]);

/**
 * Exactly one of `organizationId` and `nodeId` is set on any row — a CHECK in
 * SQL, because Drizzle has no way to say it. Two nullable references rather
 * than a polymorphic (type, id) pair so the database removes the row when the
 * thing it names is deleted.
 */
export const userRecentView = pgTable('user_recent_view', {
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id'),
  nodeId: uuid('node_id'),
  viewedAt: tstz('viewed_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('user_recent_view_org_uk').on(t.tenantId, t.userId, t.organizationId),
  uniqueIndex('user_recent_view_node_uk').on(t.tenantId, t.userId, t.nodeId),
  index('user_recent_view_recent_idx').on(t.tenantId, t.userId, t.viewedAt),
]);

/**
 * `widgets` is an ordered array of widget keys. The database refuses an unknown
 * key, a duplicate and anything that is not an array — helm.dashboard_layout_valid()
 * in 0370 — so a layout that renders nothing cannot be written in the first
 * place. WIDGET_KEYS in src/lib/dashboard/widgets.ts is the interface's copy of
 * the same list.
 */
export const userDashboard = pgTable('user_dashboard', {
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  widgets: jsonb('widgets').notNull().$type<string[]>(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.userId] }),
]);

export type UserFavorite = typeof userFavorite.$inferSelect;
export type UserRecentView = typeof userRecentView.$inferSelect;
export type UserDashboard = typeof userDashboard.$inferSelect;
