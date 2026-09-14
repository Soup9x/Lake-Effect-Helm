-- =============================================================================
-- 0250_graph_walk_fix.sql — one row per reachable node
--
-- BUG THIS FIXES: helm.asset_graph_walk() expanded the frontier once per EDGE,
-- not once per NODE. Two assets joined by more than one relation — which is
-- normal, a firewall is both `member_of` a VLAN (intrinsic, from
-- device.primary_network_id) and `secures` it (explicit) — therefore entered
-- the frontier twice, and every node downstream of them was duplicated too.
--
-- The effect compounds with depth: a graph with a handful of parallel edges
-- returns the same server four or eight times. For a rendered dependency map
-- that is visual noise; for impactOf() it is a double-counted blast radius,
-- which is a number someone might actually make a maintenance-window decision
-- on.
--
-- Two changes:
--
--   1. Parallel relations between the same pair are collapsed into a single
--      edge carrying an ARRAY of relations. Nothing is lost — the caller sees
--      "reached via {member_of, secures}" instead of two identical rows — and
--      the frontier stops multiplying.
--
--   2. The result is DISTINCT ON (node_id), keeping the shortest path. A node
--      reachable by several routes is one node; "how far is it and how do I get
--      there" wants the shortest, not all of them.
--
-- The cycle guard (a node may not reappear in its own path) is unchanged, and
-- still does the job it always did: it stops infinite recursion. It cannot stop
-- this duplication, because these paths were all genuinely acyclic.
-- =============================================================================

SET search_path = public, extensions;

-- The return type changes, so CREATE OR REPLACE is not enough.
DROP FUNCTION IF EXISTS helm.asset_graph_walk(uuid, integer, link_relation[], integer);

CREATE FUNCTION helm.asset_graph_walk(
  p_root_node_id uuid,
  p_max_depth    integer DEFAULT 3,
  p_relations    link_relation[] DEFAULT NULL,
  p_max_nodes    integer DEFAULT 500
) RETURNS TABLE (
  node_id        uuid,
  node_type      node_type,
  name           text,
  depth          integer,
  path           uuid[],
  -- Every relation joining the parent to this node, not just one of them.
  via_relations  link_relation[],
  parent_node_id uuid,
  criticality    smallint
)
  LANGUAGE sql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  WITH RECURSIVE
  -- Collapse parallel relations first. Filtering by p_relations happens here,
  -- before the collapse, so a filtered walk still sees only what it asked for.
  edge AS MATERIALIZED (
    SELECT
      e.from_node_id,
      e.to_node_id,
      array_agg(DISTINCT e.relation ORDER BY e.relation) AS relations
    FROM v_asset_edge e
    WHERE p_relations IS NULL OR e.relation = ANY (p_relations)
    GROUP BY e.from_node_id, e.to_node_id
  ),
  walk AS (
    SELECT
      n.id                        AS node_id,
      0                           AS depth,
      ARRAY[n.id]                 AS path,
      NULL::link_relation[]       AS via_relations,
      NULL::uuid                  AS parent_node_id
    FROM asset_node n
    WHERE n.id = p_root_node_id

    UNION ALL

    SELECT
      e.to_node_id,
      w.depth + 1,
      w.path || e.to_node_id,
      e.relations,
      w.node_id
    FROM walk w
    JOIN edge e ON e.from_node_id = w.node_id
    WHERE w.depth < p_max_depth
      -- Cycle guard. MSP topologies are full of cycles: a domain controller
      -- that both hosts and authenticates the thing that manages it.
      AND NOT (e.to_node_id = ANY (w.path))
  ),
  -- One row per node: the shortest route wins, ties broken deterministically so
  -- repeated calls return the same answer.
  shortest AS (
    SELECT DISTINCT ON (w.node_id) w.*
    FROM walk w
    ORDER BY w.node_id, w.depth, w.path
  )
  SELECT
    s.node_id,
    n.node_type,
    n.name,
    s.depth,
    s.path,
    s.via_relations,
    s.parent_node_id,
    n.criticality
  FROM shortest s
  JOIN asset_node n ON n.id = s.node_id
  ORDER BY s.depth, n.criticality DESC, n.name
  LIMIT p_max_nodes;
$$;

GRANT EXECUTE ON FUNCTION helm.asset_graph_walk(uuid, integer, link_relation[], integer)
  TO helm_app, helm_auditor;

-- -----------------------------------------------------------------------------
-- Regression guard: walking a graph with parallel edges must not duplicate.
--
-- Built and torn down inside this migration so it runs on every deployment
-- rather than only where the test suite does.
-- -----------------------------------------------------------------------------
DO $regression$
DECLARE
  v_tenant  uuid := gen_random_uuid();
  v_org     uuid := gen_random_uuid();
  v_a       uuid := gen_random_uuid();
  v_b       uuid := gen_random_uuid();
  v_c       uuid := gen_random_uuid();
  v_rows    bigint;
  v_distinct bigint;
BEGIN
  INSERT INTO tenant (id, slug, name)
    VALUES (v_tenant, 'zz-walk-regression', 'walk regression');
  INSERT INTO organization (id, tenant_id, slug, name)
    VALUES (v_org, v_tenant, 'zz-org', 'walk regression org');

  INSERT INTO asset_node (id, tenant_id, organization_id, node_type, name) VALUES
    (v_a, v_tenant, v_org, 'device',  'walk-a'),
    (v_b, v_tenant, v_org, 'network', 'walk-b'),
    (v_c, v_tenant, v_org, 'device',  'walk-c');

  -- Two parallel relations between a and b, then b to c.
  INSERT INTO asset_link (tenant_id, source_node_id, target_node_id, relation) VALUES
    (v_tenant, v_a, v_b, 'secures'),
    (v_tenant, v_a, v_b, 'member_of'),
    (v_tenant, v_b, v_c, 'connects_to');

  PERFORM set_config('helm.tenant_id', v_tenant::text, true);
  PERFORM set_config('helm.org_scope', '*', true);

  SELECT count(*), count(DISTINCT node_id)
    INTO v_rows, v_distinct
  FROM helm.asset_graph_walk(v_a, 3);

  IF v_rows <> v_distinct THEN
    RAISE EXCEPTION
      'helm: asset_graph_walk returned % rows for % distinct nodes; parallel '
      'relations are still multiplying the frontier', v_rows, v_distinct;
  END IF;

  IF v_distinct <> 3 THEN
    RAISE EXCEPTION 'helm: asset_graph_walk reached % nodes, expected 3', v_distinct;
  END IF;

  -- Both relations must survive the collapse.
  IF NOT EXISTS (
    SELECT 1 FROM helm.asset_graph_walk(v_a, 3)
    WHERE node_id = v_b
      AND via_relations @> ARRAY['secures', 'member_of']::link_relation[]
  ) THEN
    RAISE EXCEPTION 'helm: collapsing parallel edges lost a relation';
  END IF;

  DELETE FROM asset_link WHERE tenant_id = v_tenant;
  DELETE FROM asset_node WHERE tenant_id = v_tenant;
  DELETE FROM organization WHERE tenant_id = v_tenant;
  DELETE FROM tenant WHERE id = v_tenant;

  PERFORM set_config('helm.tenant_id', '', true);
  PERFORM set_config('helm.org_scope', '', true);
END
$regression$;
