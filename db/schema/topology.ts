/**
 * Per-site network topology (0570).
 *
 * NOT `assetLink`. That table models reliance — what breaks when this breaks —
 * and canonicalises its edges because direction there is a claim about impact.
 * These two tables model connectivity: what is plugged into what, and where the
 * box sits on the drawing. A firewall depends on an ISP circuit and is cabled
 * to a switch it does not depend on; both statements are true, so they live in
 * different tables and neither reads the other.
 *
 * The non-destructive contract with the UniFi sync is enforced in SQL, not
 * here: `helm.upsert_topology_node` has an exhaustive update list that omits
 * pos_x, pos_y and every customisation marker, and 0570 asserts that it still
 * omits them. See that migration before changing anything in this file.
 */
import { boolean, doublePrecision, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea, tstz } from './_types';
import { topologyDeviceType, topologySource } from './enums';
import { assetNode } from './assets';
import { tenant } from './tenancy';

/**
 * A box on the diagram.
 *
 * `label`, `ipAddress` and `subnet` are plain text rather than inet/cidr on
 * purpose: they are what the drawing SAYS, not what the device IS. The asset
 * record holds the authoritative values, and a subnet slot reading
 * "10.0.20.0/24 — VLAN 20 (voice)" is a legitimate annotation that a cidr
 * column would reject at the driver.
 */
export const topologyNode = pgTable('topology_node', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  /** Composite FK (site_id, tenant_id) -> site, declared in 0570: Drizzle has no
   *  syntax for a composite reference, and db/sql is the authority regardless. */
  siteId: uuid('site_id').notNull(),

  /**
   * The real asset, when there is one. Null is ordinary, not a gap: an ISP
   * handoff, a patch panel or a label-only annotation has no asset record and
   * never will.
   */
  assetNodeId: uuid('asset_node_id').references(() => assetNode.id, { onDelete: 'set null' }),

  label: text('label').notNull(),
  ipAddress: text('ip_address'),
  subnet: text('subnet'),
  deviceType: topologyDeviceType('device_type').notNull().default('generic'),

  /**
   * Null means never placed. The canvas lays those out on first load; the drag
   * that follows is what writes coordinates. A synthetic default would make
   * "did a person position this?" unanswerable, and that question is the whole
   * reason the sync can be re-run safely.
   */
  posX: doublePrecision('pos_x'),
  posY: doublePrecision('pos_y'),

  source: topologySource('source').notNull().default('manual'),

  /** The same blind index `network_assets` is keyed by, so the sync matches a
   *  device the way the rest of the integration does. */
  macBlindIndex: bytea('mac_blind_index'),

  /**
   * Customisation markers.
   *
   * `network_assets` protects `custom_name` by keeping it in a column the poll
   * never writes — which works there because the user's name and the
   * controller's are different fields. Here they are the same field, so the
   * protection has to be a marker the upsert consults. Set by the edit path,
   * never by the sync.
   */
  labelCustomised: boolean('label_customised').notNull().default(false),
  deviceTypeCustomised: boolean('device_type_customised').notNull().default(false),
  ipAddressCustomised: boolean('ip_address_customised').notNull().default(false),
  subnetCustomised: boolean('subnet_customised').notNull().default(false),

  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  index('topology_node_site_idx').on(t.tenantId, t.siteId),
  index('topology_node_asset_idx').on(t.assetNodeId),
  uniqueIndex('topology_node_device_uk').on(t.tenantId, t.siteId, t.macBlindIndex),
]);

/**
 * A line on the diagram.
 *
 * Stored directed (from = downstream, to = its uplink) because that is what the
 * telemetry reports, rendered as a plain line because v1 draws straight lines.
 * A unique index over the unordered pair stops A→B and B→A becoming two lines
 * drawn on top of each other.
 */
export const topologyLink = pgTable('topology_link', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  siteId: uuid('site_id').notNull(),

  fromNodeId: uuid('from_node_id').notNull(),
  toNodeId: uuid('to_node_id').notNull(),

  /** Port or interface, when anything knows it. "Gi1/0/24", "WAN1". */
  label: text('label'),
  source: topologySource('source').notNull().default('manual'),

  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  index('topology_link_site_idx').on(t.tenantId, t.siteId),
  index('topology_link_from_idx').on(t.fromNodeId),
  index('topology_link_to_idx').on(t.toNodeId),
]);
