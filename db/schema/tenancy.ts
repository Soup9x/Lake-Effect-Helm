/**
 * Tenancy: tenant -> organization -> site, plus contacts.
 *
 * Every table here carries `UNIQUE (id, tenant_id)` in SQL so child tables can
 * declare composite foreign keys against it. Drizzle cannot express a composite
 * FK against a non-primary unique key cleanly, so those constraints live only
 * in db/sql — which is why db/sql is the schema authority and this file is the
 * query layer.
 */
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, numeric, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, citext, inetArray, softDelete, textArray, tstz } from './_types';
import { organizationRelationship, organizationStatus, tenantStatus } from './enums';

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
  /**
   * The relationship, not the lifecycle. Independent of `status`; implied by
   * `isMspInternal` but not equivalent to it. See 0600.
   */
  relationship: organizationRelationship('relationship').notNull().default('client'),
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
  /** Static WAN addresses or blocks the location is reached on (0840). */
  publicIps: inetArray('public_ips').notNull().default(sql`'{}'`),
  /** Archived: off the list and out of search, restorable (0940). */
  archivedAt: tstz('archived_at'),
  /** 1150: free-text labels, as an entry's and a contact's. */
  tags: textArray('tags').notNull().default([]),
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
  /** 0850: off the list and out of search, restorable. Distinct from deleted_at. */
  archivedAt: tstz('archived_at'),
  /** 1050: free-text labels, beside the role flags rather than instead of them. */
  tags: textArray('tags').notNull().default([]),
  ...auditColumns,
  ...softDelete,
}, (t) => [
  index('contact_org_idx').on(t.tenantId, t.organizationId),
]);

/** 0790: a contact's addresses, labelled, one primary. contact.email is the projection. */
export const contactEmail = pgTable('contact_email', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  address: citext('address').notNull(),
  label: text('label').notNull().default('work'),
  isPrimary: boolean('is_primary').notNull().default(false),
  position: smallint('position').notNull().default(0),
  createdAt: tstz('created_at').notNull().defaultNow(),
}, (t) => [
  index('contact_email_contact_idx').on(t.tenantId, t.contactId),
]);

/** 0790: a contact's numbers. contact.phone is the primary, contact.mobile the first mobile. */
export const contactPhone = pgTable('contact_phone', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  number: text('number').notNull(),
  extension: text('extension'),
  label: text('label').notNull().default('work'),
  isPrimary: boolean('is_primary').notNull().default(false),
  position: smallint('position').notNull().default(0),
  createdAt: tstz('created_at').notNull().defaultNow(),
}, (t) => [
  index('contact_phone_contact_idx').on(t.tenantId, t.contactId),
]);

export type Tenant = typeof tenant.$inferSelect;
export type Organization = typeof organization.$inferSelect;
export type Site = typeof site.$inferSelect;
export type Contact = typeof contact.$inferSelect;
