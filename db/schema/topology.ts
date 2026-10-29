/**
 * Network diagrams (0570, manual-only since 0580, a record of their own since 0880).
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
import { boolean, doublePrecision, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tstz } from './_types';
import { topologyDeviceType } from './enums';
import { assetNode } from './assets';
import { tenant } from './tenancy';
import { appUser } from './identity';

/**
 * A diagram (0880): a client's, optionally of one location and about one
 * network entry. Its composite foreign keys — (organization_id, tenant_id),
 * (site_id, tenant_id) and (network_id, tenant_id) — are declared in SQL, which
 * is the authority; Drizzle has no syntax for a composite reference.
 */
export const networkDiagram = pgTable('network_diagram', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  siteId: uuid('site_id'),
  networkId: uuid('network_id'),
  name: text('name').notNull(),
  description: text('description'),
  isInternalOnly: boolean('is_internal_only').notNull().default(false),
  /** The size somebody dragged the canvas to ((1190)). A floor: the canvas still
   *  grows to fit a box past the edge. Null is the default size. */
  canvasWidth: integer('canvas_width'),
  canvasHeight: integer('canvas_height'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => appUser.id, { onDelete: 'set null' }),
  archivedAt: tstz('archived_at'),
}, (t) => [
  index('network_diagram_org_idx').on(t.tenantId, t.organizationId),
]);

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
  /** The diagram this box is on (0880). Composite FK (diagram_id, tenant_id)
   *  -> network_diagram, declared in SQL: Drizzle has no syntax for a
   *  composite reference, and db/sql is the authority regardless. */
  diagramId: uuid('diagram_id').notNull(),

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

  /** A palette name ('blue', 'green', …), or null for the default ((1190)). */
  color: text('color'),

  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  index('topology_node_diagram_idx').on(t.tenantId, t.diagramId),
  index('topology_node_asset_idx').on(t.assetNodeId),
]);

/**
 * A line on the diagram.
 *
 * Stored directed, but the direction means only "the order it was drawn"; an
 * arrow ((1190)) is drawn relative to it. A unique index over the unordered pair
 * (declared in 0570, since Drizzle cannot express least/greatest) stops A→B and
 * B→A becoming two lines on top of each other.
 */
export const topologyLink = pgTable('topology_link', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  diagramId: uuid('diagram_id').notNull(),

  fromNodeId: uuid('from_node_id').notNull(),
  toNodeId: uuid('to_node_id').notNull(),

  /** Port or interface, when somebody types one. "Gi1/0/24", "WAN1". */
  label: text('label'),

  /**
   * How the line is drawn ((1190)). `arrow` is relative to from → to, the order
   * it was drawn in; it decorates the one cable, it does not make a second.
   */
  lineStyle: text('line_style').notNull().default('solid'),
  arrow: text('arrow').notNull().default('none'),
  color: text('color'),

  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  index('topology_link_diagram_idx').on(t.tenantId, t.diagramId),
  index('topology_link_from_idx').on(t.fromNodeId),
  index('topology_link_to_idx').on(t.toNodeId),
]);
