/**
 * Relation vocabulary and edge canonicalisation.
 *
 * THE PROBLEM THIS SOLVES: "the firewall supports the network" and "the network
 * depends on the firewall" are the same fact. So are "A connects_to B" and
 * "B connects_to A". A naive link table happily stores both, and then the
 * dependency map shows a duplicated edge, the impact analysis double-counts,
 * and deleting one leaves the other behind.
 *
 * The usual fix is to check for the inverse before inserting. That is a
 * read-then-write, so two concurrent technicians can still create both halves —
 * and the unique index on (source, target, relation) will not catch it, because
 * the rows genuinely differ.
 *
 * Instead, EVERY edge is stored in a canonical direction: the endpoints are
 * ordered by id, and the relation is flipped to its inverse if that ordering
 * reversed them. Both spellings of the same fact therefore produce byte-identical
 * rows, and the existing unique index rejects the duplicate — structurally, with
 * no race window.
 *
 * Nothing is lost on read: v_asset_edge emits every stored edge in both
 * directions with the relation inverted on the reverse pass, so a caller asking
 * "what does this network depend on" gets the same answer regardless of which
 * way the row happens to be stored.
 */

export type LinkRelation =
  | 'depends_on' | 'supports'
  | 'hosted_on' | 'hosts'
  | 'connects_to'
  | 'member_of' | 'contains'
  | 'secures' | 'secured_by'
  | 'resolves_to' | 'resolved_by'
  | 'authenticates_to' | 'authenticates'
  | 'backs_up' | 'backed_up_by'
  | 'licenses' | 'licensed_by'
  | 'documents' | 'documented_by'
  | 'replaces' | 'replaced_by'
  | 'related_to';

export type LinkOrigin = 'manual' | 'intrinsic' | 'discovered' | 'imported';

/**
 * Must match helm.inverse_relation() exactly.
 *
 * Duplicated between TypeScript and SQL because both layers need it — the
 * database for the bi-directional view, this module for canonicalisation. The
 * duplication is guarded by a test that reads every enum value out of the
 * catalog and compares the two maps; a divergence would silently store edges
 * in a direction the view then inverts differently, which is the sort of bug
 * that only shows up as "the map is missing an arrow".
 */
export const INVERSE_RELATION: Readonly<Record<LinkRelation, LinkRelation>> = Object.freeze({
  depends_on: 'supports',
  supports: 'depends_on',
  hosted_on: 'hosts',
  hosts: 'hosted_on',
  member_of: 'contains',
  contains: 'member_of',
  secures: 'secured_by',
  secured_by: 'secures',
  resolves_to: 'resolved_by',
  resolved_by: 'resolves_to',
  authenticates_to: 'authenticates',
  authenticates: 'authenticates_to',
  backs_up: 'backed_up_by',
  backed_up_by: 'backs_up',
  licenses: 'licensed_by',
  licensed_by: 'licenses',
  documents: 'documented_by',
  documented_by: 'documents',
  replaces: 'replaced_by',
  replaced_by: 'replaces',
  // Symmetric: their own inverse.
  connects_to: 'connects_to',
  related_to: 'related_to',
});

export const ALL_RELATIONS = Object.keys(INVERSE_RELATION) as LinkRelation[];

export function inverseOf(relation: LinkRelation): LinkRelation {
  return INVERSE_RELATION[relation];
}

export function isSymmetric(relation: LinkRelation): boolean {
  return INVERSE_RELATION[relation] === relation;
}

/**
 * Relations that express a dependency, in the direction "A needs B".
 *
 * Impact analysis follows these: if B fails, everything that reaches it through
 * one of these is affected. `related_to` and `documents` deliberately are not
 * here — they are navigational, and treating them as dependencies turns a blast
 * radius query into "everything, eventually".
 */
export const DEPENDENCY_RELATIONS: readonly LinkRelation[] = Object.freeze([
  'depends_on',
  'hosted_on',
  'member_of',
  'secured_by',
  'resolves_to',
  'authenticates_to',
  'licensed_by',
  'backed_up_by',
]);

export interface CanonicalEdge {
  sourceNodeId: string;
  targetNodeId: string;
  relation: LinkRelation;
  /** True when the caller's direction was reversed to reach canonical form. */
  flipped: boolean;
}

/**
 * Put an edge into its canonical stored form.
 *
 * Ordering is by string comparison of the two ids. Any total order works; what
 * matters is that it is deterministic and that both spellings of an edge land
 * on the same one.
 */
export function canonicalise(
  sourceNodeId: string,
  relation: LinkRelation,
  targetNodeId: string,
): CanonicalEdge {
  if (sourceNodeId === targetNodeId) {
    throw new Error('an asset cannot be linked to itself');
  }

  if (sourceNodeId < targetNodeId) {
    return { sourceNodeId, targetNodeId, relation, flipped: false };
  }

  return {
    sourceNodeId: targetNodeId,
    targetNodeId: sourceNodeId,
    relation: inverseOf(relation),
    flipped: true,
  };
}
