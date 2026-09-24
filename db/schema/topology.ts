/**
 * Per-site network topology (0570, reduced to manual-only by 0580).
 *
 * NOT `assetLink`. That table models reliance — what breaks when this breaks —
 * and canonicalises its edges because direction there is a claim about impact.
 * These two tables model connectivity: what is plugged into what, and where the
 * box sits on the drawing. A firewall depends on an ISP circuit and is cabled
 * to a switch it does not depend on; both statements are true, so they live in
 * different tables and neither reads the other.
 *
 * A person is the only writer. 0570 shipped these tables with UniFi
 * auto-population — a blind index to match devices on, a provenance column and
 * four markers recording which fields a person had edited so a poll would not
 * overwrite them. 0580 removed all of it. If you are about to add a column here
 * so that something can write to this table automatically, read 0580 first: the
 * machinery it deletes is exactly what that needs, and it was deleted on
 * purpose.
 */
import { doublePrecision, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tstz } from './_types';
import { topologyDeviceType } from './enums';
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
   * that follows is what writes coordinates. A synthetic default would throw
   * that distinction away and buy nothing.
   */
  posX: doublePrecision('pos_x'),
  posY: doublePrecision('pos_y'),

  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  index('topology_node_site_idx').on(t.tenantId, t.siteId),
  index('topology_node_asset_idx').on(t.assetNodeId),
]);

/**
 * A line on the diagram.
 *
 * Stored directed, but the direction means only "the order it was drawn": v1
 * renders a plain line either way. A unique index over the unordered pair
 * (declared in 0570, since Drizzle cannot express least/greatest) stops A→B and
 * B→A becoming two lines on top of each other.
 */
export const topologyLink = pgTable('topology_link', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  siteId: uuid('site_id').notNull(),

  fromNodeId: uuid('from_node_id').notNull(),
  toNodeId: uuid('to_node_id').notNull(),

  /** Port or interface, when somebody types one. "Gi1/0/24", "WAN1". */
  label: text('label'),

  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  index('topology_link_site_idx').on(t.tenantId, t.siteId),
  index('topology_link_from_idx').on(t.fromNodeId),
  index('topology_link_to_idx').on(t.toNodeId),
]);
