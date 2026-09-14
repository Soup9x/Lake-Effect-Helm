/**
 * The relationship engine.
 *
 * Reads go through v_asset_edge, which presents every stored edge in both
 * directions. Writes go through canonicalise() (see relations.ts), so the same
 * fact spelled either way produces one row.
 *
 * Everything here runs under the caller's RLS. That is load-bearing for the
 * graph specifically: asset_link's policy requires BOTH endpoints to be in
 * scope, so a co-managed client tracing a dependency cannot discover that
 * another organisation's asset exists by finding an edge that dead-ends.
 */
import type { HelmTx } from '../db/client';
import { withTenant } from '../db/client';
import type { ActorRef } from '../secrets/service';
import {
  canonicalise,
  DEPENDENCY_RELATIONS,
  inverseOf,
  type LinkOrigin,
  type LinkRelation,
} from './relations';

export interface LinkInput {
  sourceNodeId: string;
  relation: LinkRelation;
  targetNodeId: string;
  note?: string;
  origin?: LinkOrigin;
  /** 1-100. Manual links are 100; discovery should report its real confidence. */
  confidence?: number;
}

export interface AssetEdge {
  linkId: string | null;
  fromNodeId: string;
  toNodeId: string;
  relation: LinkRelation;
  direction: 'forward' | 'reverse';
  origin: LinkOrigin;
  confidence: number;
  note: string | null;
}

export interface LabelledEdge extends AssetEdge {
  fromName: string;
  fromType: string;
  toName: string;
  toType: string;
  toCriticality: number;
}

export interface GraphNode {
  nodeId: string;
  nodeType: string;
  name: string;
  depth: number;
  path: string[];
  /**
   * Every relation joining the parent to this node. An array because a pair can
   * legitimately be connected more than one way — a firewall is both `member_of`
   * a VLAN and `secures` it — and collapsing that to a single value is what used
   * to duplicate the whole subtree beneath it.
   */
  viaRelations: LinkRelation[];
  parentNodeId: string | null;
  criticality: number;
}

export interface LinkResult {
  linkId: string;
  created: boolean;
  /** True when the edge was stored in the opposite direction to the request. */
  canonicalised: boolean;
}

interface RawEdge {
  link_id: string | null;
  from_node_id: string;
  to_node_id: string;
  relation: LinkRelation;
  direction: 'forward' | 'reverse';
  origin: LinkOrigin;
  confidence: number;
  note: string | null;
}

interface RawLabelledEdge extends RawEdge {
  from_name: string;
  from_type: string;
  to_name: string;
  to_type: string;
  to_criticality: number;
}

interface RawWalkRow {
  node_id: string;
  node_type: string;
  name: string;
  depth: number;
  path: string[];
  via_relations: LinkRelation[] | null;
  parent_node_id: string | null;
  criticality: number;
}

const toEdge = (r: RawEdge): AssetEdge => ({
  linkId: r.link_id,
  fromNodeId: r.from_node_id,
  toNodeId: r.to_node_id,
  relation: r.relation,
  direction: r.direction,
  origin: r.origin,
  confidence: r.confidence,
  note: r.note,
});

export class LinkEngine {
  /**
   * Assert a relationship.
   *
   * Idempotent in both directions: linking "firewall secures network" twice, or
   * once each way round, yields the same single row. The return value says
   * whether anything was actually created, so a bulk importer can report
   * honestly instead of claiming to have added edges that already existed.
   */
  async link(actor: ActorRef, input: LinkInput): Promise<LinkResult> {
    return withTenant(actor, async (tx) => this.linkInTx(tx, actor, input));
  }

  async linkInTx(tx: HelmTx, actor: ActorRef, input: LinkInput): Promise<LinkResult> {
    const canonical = canonicalise(input.sourceNodeId, input.relation, input.targetNodeId);

    // ON CONFLICT on the (source, target, relation) unique index. Because both
    // spellings canonicalise to identical values, this catches the inverse
    // duplicate too — without a read-then-write race.
    const [inserted] = await tx<{ id: string }[]>`
      INSERT INTO asset_link (
        tenant_id, source_node_id, target_node_id, relation, origin, note, confidence, created_by
      )
      VALUES (
        ${actor.tenantId}::uuid,
        ${canonical.sourceNodeId}::uuid,
        ${canonical.targetNodeId}::uuid,
        ${canonical.relation}::link_relation,
        ${input.origin ?? 'manual'}::link_origin,
        ${input.note ?? null},
        ${input.confidence ?? 100},
        ${actor.actorId}::uuid
      )
      ON CONFLICT (source_node_id, target_node_id, relation) DO NOTHING
      RETURNING id
    `;

    if (inserted) {
      await tx`
        SELECT helm.audit(
          'asset.linked', 'asset_link', ${inserted.id}::uuid, 'success',
          NULL, ${canonical.sourceNodeId}::uuid, NULL,
          ${tx.json({
            relation: canonical.relation,
            target_node_id: canonical.targetNodeId,
            origin: input.origin ?? 'manual',
          })}::jsonb
        )
      `;
      return { linkId: inserted.id, created: true, canonicalised: canonical.flipped };
    }

    // Already present. Return the existing row so callers get a usable id.
    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM asset_link
      WHERE source_node_id = ${canonical.sourceNodeId}::uuid
        AND target_node_id = ${canonical.targetNodeId}::uuid
        AND relation = ${canonical.relation}::link_relation
    `;

    if (!existing) {
      // DO NOTHING fired but the row is not visible: the only way that happens
      // is an RLS policy hiding a row this actor may not see. Report it as an
      // authorisation problem rather than a mysterious null.
      throw new Error(
        'link already exists but is not visible in this scope; ' +
          'both endpoints must be within your organisation scope',
      );
    }

    return { linkId: existing.id, created: false, canonicalised: canonical.flipped };
  }

  /**
   * Remove a relationship, given either direction.
   *
   * Callers naturally say "unlink these in the direction I see them", which may
   * be the reverse of how the row is stored. Canonicalising first means they do
   * not have to know or care.
   */
  async unlink(
    actor: ActorRef,
    sourceNodeId: string,
    relation: LinkRelation,
    targetNodeId: string,
  ): Promise<boolean> {
    return withTenant(actor, async (tx) => {
      const canonical = canonicalise(sourceNodeId, relation, targetNodeId);

      const deleted = await tx<{ id: string }[]>`
        DELETE FROM asset_link
        WHERE source_node_id = ${canonical.sourceNodeId}::uuid
          AND target_node_id = ${canonical.targetNodeId}::uuid
          AND relation = ${canonical.relation}::link_relation
        RETURNING id
      `;

      const row = deleted[0];
      if (!row) return false;

      await tx`
        SELECT helm.audit(
          'asset.unlinked', 'asset_link', ${row.id}::uuid, 'success',
          NULL, ${canonical.sourceNodeId}::uuid, NULL,
          ${tx.json({ relation: canonical.relation, target_node_id: canonical.targetNodeId })}::jsonb
        )
      `;
      return true;
    });
  }

  /**
   * Everything one hop from a node, in both directions.
   *
   * Includes intrinsic edges projected from foreign keys — a certificate's
   * domain shows up here without anyone ever having created an asset_link row.
   */
  async neighbours(
    actor: ActorRef,
    nodeId: string,
    options: { relations?: LinkRelation[]; limit?: number } = {},
  ): Promise<LabelledEdge[]> {
    return withTenant(actor, async (tx) => {
      const rows = await tx<RawLabelledEdge[]>`
        SELECT * FROM v_asset_edge_labelled
        WHERE from_node_id = ${nodeId}::uuid
          ${
            options.relations?.length
              ? tx`AND relation = ANY (${options.relations}::link_relation[])`
              : tx``
          }
        ORDER BY to_criticality DESC, to_name
        LIMIT ${Math.min(options.limit ?? 200, 1000)}
      `;

      return rows.map((r) => ({
        ...toEdge(r),
        fromName: r.from_name,
        fromType: r.from_type,
        toName: r.to_name,
        toType: r.to_type,
        toCriticality: r.to_criticality,
      }));
    });
  }

  /** Raw bi-directional edges without the name join. Cheaper for bulk export. */
  async edges(actor: ActorRef, nodeId: string): Promise<AssetEdge[]> {
    return withTenant(actor, async (tx) => {
      const rows = await tx<RawEdge[]>`
        SELECT * FROM v_asset_edge WHERE from_node_id = ${nodeId}::uuid
      `;
      return rows.map(toEdge);
    });
  }

  /**
   * Bounded breadth-first traversal.
   *
   * Runs under the caller's RLS, so the walk stops at the isolation boundary
   * rather than revealing that a node exists beyond it.
   */
  async walk(
    actor: ActorRef,
    rootNodeId: string,
    options: { maxDepth?: number; relations?: LinkRelation[]; maxNodes?: number } = {},
  ): Promise<GraphNode[]> {
    return withTenant(actor, async (tx) => {
      const rows = await tx<RawWalkRow[]>`
        SELECT * FROM helm.asset_graph_walk(
          ${rootNodeId}::uuid,
          ${options.maxDepth ?? 3},
          ${options.relations ?? null}::link_relation[],
          ${options.maxNodes ?? 500}
        )
      `;
      return rows.map((r) => ({
        nodeId: r.node_id,
        nodeType: r.node_type,
        name: r.name,
        depth: r.depth,
        path: r.path,
        viaRelations: r.via_relations ?? [],
        parentNodeId: r.parent_node_id,
        criticality: r.criticality,
      }));
    });
  }

  /**
   * What this asset needs to function.
   *
   * Follows dependency relations outward: the firewall this server sits behind,
   * the directory it authenticates against, the certificate securing it.
   */
  async dependenciesOf(
    actor: ActorRef,
    nodeId: string,
    maxDepth = 3,
  ): Promise<GraphNode[]> {
    return this.walk(actor, nodeId, {
      maxDepth,
      relations: [...DEPENDENCY_RELATIONS],
    });
  }

  /**
   * What breaks if this asset fails — the blast radius.
   *
   * The inverse of dependenciesOf: follow the dependency relations backwards,
   * which in bi-directional terms means following their inverses. This is the
   * query a technician actually runs before rebooting a domain controller.
   *
   * Results exclude the root and are ordered by criticality, so the answer opens
   * with what matters rather than with whatever sorted first.
   */
  async impactOf(actor: ActorRef, nodeId: string, maxDepth = 3): Promise<GraphNode[]> {
    const inverses = DEPENDENCY_RELATIONS.map(inverseOf);
    const reached = await this.walk(actor, nodeId, { maxDepth, relations: inverses });

    return reached
      .filter((n) => n.nodeId !== nodeId)
      .sort((a, b) => b.criticality - a.criticality || a.depth - b.depth);
  }
}
