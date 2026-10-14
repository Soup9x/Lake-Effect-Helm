/**
 * Per-user workspace state: favourites, recently viewed, dashboard and sidebar
 * layouts.
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

/**
 * `categories` is an ordered array of ORG_CATEGORIES slugs: the drawer's primary
 * list, with everything else falling through to "More".
 * helm.sidebar_layout_valid() in 0620 refuses an unknown slug, a duplicate and
 * anything that is not an array, so a layout that renders nothing cannot be
 * written. src/lib/nav/sidebar-layout.ts is the interface's side of that
 * mirror — and it reads the registry rather than restating the list, so there
 * are two copies and not three.
 *
 * A MISSING ROW and an EMPTY array mean different things: the first is somebody
 * who has never customised, and falls through to tenantSidebarDefault; the
 * second is somebody who wants nothing but "More".
 */
export const userSidebar = pgTable('user_sidebar', {
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  categories: jsonb('categories').notNull().$type<string[]>(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.userId] }),
]);

/**
 * NOT per-user, and the odd one out in this file for that reason.
 *
 * It lives here because it is the other half of userSidebar's resolution chain
 * and a reader of one needs the other, but its RLS is not the personal set: it
 * is readable by everyone in the tenant — the drawer renders from it for
 * client-side roles too — and writable only with tenant:write. See 0620 for
 * why the generic tenant-scoped policy set would have been wrong here.
 */
export const tenantSidebarDefault = pgTable('tenant_sidebar_default', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenant.id, { onDelete: 'cascade' }),
  categories: jsonb('categories').notNull().$type<string[]>(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => appUser.id, { onDelete: 'set null' }),
});

export type UserFavorite = typeof userFavorite.$inferSelect;
export type UserRecentView = typeof userRecentView.$inferSelect;
export type UserDashboard = typeof userDashboard.$inferSelect;
export type UserSidebar = typeof userSidebar.$inferSelect;
export type TenantSidebarDefault = typeof tenantSidebarDefault.$inferSelect;
