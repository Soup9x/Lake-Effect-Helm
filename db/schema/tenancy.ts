/**
 * Tenancy: tenant -> organization -> site, plus contacts.
 *
 * Every table here carries `UNIQUE (id, tenant_id)` in SQL so child tables can
 * declare composite foreign keys against it. Drizzle cannot express a composite
 * FK against a non-primary unique key cleanly, so those constraints live only
 * in db/sql — which is why db/sql is the schema authority and this file is the
 * query layer.
 */
import { boolean, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, citext, softDelete, textArray, tstz } from './_types';
import { organizationStatus, tenantStatus } from './enums';

export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: citext('slug').notNull().unique(),
  name: text('name').notNull(),
  status: tenantStatus('status').notNull().default('active'),
  primaryDomain: citext('primary_domain'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const organization = pgTable('organization', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'restrict' }),
  slug: citext('slug').notNull(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  status: organizationStatus('status').notNull().default('active'),
  isMspInternal: boolean('is_msp_internal').notNull().default(false),

  industry: text('industry'),
  employeeCount: integer('employee_count'),
  timezone: text('timezone').notNull().default('America/New_York'),
  website: text('website'),
  logoUrl: text('logo_url'),
  quickNotes: text('quick_notes'),
  /** Informal context, bounded at 4000 characters in SQL. */
  notes: text('notes'),
  /** Free-form labels, same shape and meaning as asset_node.tags. */
  tags: textArray('tags').notNull().default([]),

  accountManagerId: uuid('account_manager_id'),
  primaryContactId: uuid('primary_contact_id'),

  psaCompanyId: text('psa_company_id'),
  rmmOrganizationId: text('rmm_organization_id'),

  onboardedAt: tstz('onboarded_at'),
  offboardedAt: tstz('offboarded_at'),
  /**
   * Hidden from default views, fully readable, restorable. Deliberately NOT
   * `deletedAt`: a deleted client is on its way out of the system, an archived
   * one is a client the MSP no longer works with every day.
   */
  archivedAt: tstz('archived_at'),
  ...auditColumns,
  ...softDelete,
}, (t) => [
  uniqueIndex('organization_slug_uk').on(t.tenantId, t.slug),
  index('organization_tenant_status_idx').on(t.tenantId, t.status),
]);

export const site = pgTable('site', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),

  name: text('name').notNull(),
  code: text('code'),
  isPrimary: boolean('is_primary').notNull().default(false),

  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  region: text('region'),
  postalCode: text('postal_code'),
  country: text('country').notNull().default('US'),
  latitude: numeric('latitude', { precision: 9, scale: 6 }),
  longitude: numeric('longitude', { precision: 9, scale: 6 }),
  timezone: text('timezone'),

  mainPhone: text('main_phone'),
  afterHoursPhone: text('after_hours_phone'),
  accessNotes: text('access_notes'),
  physicalSecurity: text('physical_security'),
  /** Informal context. `accessNotes` is how to get in; this is everything else. */
  notes: text('notes'),
  ...auditColumns,
  ...softDelete,
}, (t) => [
  index('site_tenant_org_idx').on(t.tenantId, t.organizationId),
]);

export const contact = pgTable('contact', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  siteId: uuid('site_id'),

  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  title: text('title'),
  email: citext('email'),
  phone: text('phone'),
  mobile: text('mobile'),
  extension: text('extension'),

  isPrimary: boolean('is_primary').notNull().default(false),
  isTechnical: boolean('is_technical').notNull().default(false),
  isBilling: boolean('is_billing').notNull().default(false),
  isEmergency: boolean('is_emergency').notNull().default(false),
  isAuthorised: boolean('is_authorised').notNull().default(false),

  notes: text('notes'),
  appUserId: uuid('app_user_id'),
  psaContactId: text('psa_contact_id'),
  ...auditColumns,
  ...softDelete,
}, (t) => [
  index('contact_org_idx').on(t.tenantId, t.organizationId),
]);

export type Tenant = typeof tenant.$inferSelect;
export type Organization = typeof organization.$inferSelect;
export type Site = typeof site.$inferSelect;
export type Contact = typeof contact.$inferSelect;
