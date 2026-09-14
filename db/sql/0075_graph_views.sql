-- =============================================================================
-- 0075_graph_views.sql — bi-directional traversal over the asset graph
--
-- Two kinds of edge feed one graph:
--
--   explicit  — rows in asset_link, asserted by a technician or an integration.
--   intrinsic — relationships already implied by a foreign key, e.g. a
--               certificate's domain_id or a VM's parent_device_id.
--
-- Intrinsic edges are projected rather than duplicated into asset_link. If they
-- were copied, every FK update would need a matching link update and the two
-- would drift; the dependency map would then be confidently wrong, which is
-- worse than being obviously incomplete.
--
-- All views are security_invoker, so the caller's RLS policies apply. A view
-- created the default way runs as its owner and would cheerfully hand one
-- tenant's topology to another.
-- =============================================================================

SET search_path = public, extensions;

-- One row per relationship as authored (source -> target).
CREATE VIEW v_asset_edge_stored
  WITH (security_invoker = true, security_barrier = true) AS
SELECT
  l.id                       AS link_id,
  l.tenant_id,
  l.source_node_id,
  l.target_node_id,
  l.relation,
  l.origin,
  l.confidence,
  l.note
FROM asset_link l

UNION ALL
SELECT NULL::uuid, d.tenant_id, d.id, d.primary_network_id,
       'member_of'::link_relation, 'intrinsic'::link_origin, 100::smallint,
       'primary interface'
FROM device d WHERE d.primary_network_id IS NOT NULL

UNION ALL
SELECT NULL, d.tenant_id, d.id, d.parent_device_id,
       'hosted_on', 'intrinsic', 100, 'virtualisation host'
FROM device d WHERE d.parent_device_id IS NOT NULL

UNION ALL
SELECT NULL, i.tenant_id, i.id, i.network_id,
       'member_of', 'intrinsic', 100, NULL
FROM ip_address i WHERE i.network_id IS NOT NULL

UNION ALL
SELECT NULL, i.tenant_id, i.id, i.assigned_node_id,
       'resolves_to', 'intrinsic', 100, 'address assignment'
FROM ip_address i WHERE i.assigned_node_id IS NOT NULL

UNION ALL
SELECT NULL, c.tenant_id, c.id, c.domain_id,
       'secures', 'intrinsic', 100, NULL
FROM ssl_certificate c WHERE c.domain_id IS NOT NULL

UNION ALL
SELECT NULL, c.tenant_id, c.id, c.installed_on_node_id,
       'secures', 'intrinsic', 100, 'certificate installation'
FROM ssl_certificate c WHERE c.installed_on_node_id IS NOT NULL

UNION ALL
SELECT NULL, a.tenant_id, a.id, a.hosted_on_node_id,
       'hosted_on', 'intrinsic', 100, NULL
FROM application a WHERE a.hosted_on_node_id IS NOT NULL

UNION ALL
SELECT NULL, a.tenant_id, a.id, a.database_node_id,
       'depends_on', 'intrinsic', 100, 'application database'
FROM application a WHERE a.database_node_id IS NOT NULL

UNION ALL
SELECT NULL, a.tenant_id, a.id, a.sso_directory_id,
       'authenticates_to', 'intrinsic', 100, NULL
FROM application a WHERE a.sso_directory_id IS NOT NULL

UNION ALL
SELECT NULL, l.tenant_id, l.id, l.application_id,
       'licenses', 'intrinsic', 100, NULL
FROM license l WHERE l.application_id IS NOT NULL

UNION ALL
SELECT NULL, n.tenant_id, n.id, n.dhcp_server_node_id,
       'depends_on', 'intrinsic', 100, 'DHCP service'
FROM network n WHERE n.dhcp_server_node_id IS NOT NULL

UNION ALL
SELECT NULL, ds.tenant_id, ds.id, ds.sync_server_node_id,
       'hosted_on', 'intrinsic', 100, 'directory sync server'
FROM directory_service ds WHERE ds.sync_server_node_id IS NOT NULL

UNION ALL
SELECT NULL, ic.tenant_id, ic.id, ic.handoff_device_node_id,
       'connects_to', 'intrinsic', 100, 'circuit handoff'
FROM isp_circuit ic WHERE ic.handoff_device_node_id IS NOT NULL

UNION ALL
SELECT NULL, dm.tenant_id, dm.id, dm.registrar_credential_id,
       'depends_on', 'intrinsic', 100, 'registrar account'
FROM domain dm WHERE dm.registrar_credential_id IS NOT NULL;

COMMENT ON VIEW v_asset_edge_stored IS
  'Directed edges exactly as authored: asset_link rows plus edges projected from '
  'foreign keys. Not for direct traversal — use v_asset_edge.';

-- -----------------------------------------------------------------------------
-- v_asset_edge — the bi-directional surface. Every stored edge appears twice,
-- once in each direction, with the relation inverted on the reverse pass.
-- -----------------------------------------------------------------------------
CREATE VIEW v_asset_edge
  WITH (security_invoker = true, security_barrier = true) AS
SELECT
  e.link_id,
  e.tenant_id,
  e.source_node_id AS from_node_id,
  e.target_node_id AS to_node_id,
  e.relation,
  'forward'::text  AS direction,
  e.origin,
  e.confidence,
  e.note
FROM v_asset_edge_stored e
UNION ALL
SELECT
  e.link_id,
  e.tenant_id,
  e.target_node_id,
  e.source_node_id,
  helm.inverse_relation(e.relation),
  'reverse'::text,
  e.origin,
  e.confidence,
  e.note
FROM v_asset_edge_stored e;

COMMENT ON VIEW v_asset_edge IS
  'Bi-directional edge list. Storing one row per relationship and inverting on '
  'read keeps writes single-statement and makes a half-deleted relationship '
  'impossible.';

-- Convenience: edges with both endpoints resolved to display names.
CREATE VIEW v_asset_edge_labelled
  WITH (security_invoker = true, security_barrier = true) AS
SELECT
  e.*,
  src.name      AS from_name,
  src.node_type AS from_type,
  dst.name      AS to_name,
  dst.node_type AS to_type,
  dst.criticality AS to_criticality
FROM v_asset_edge e
JOIN asset_node src ON src.id = e.from_node_id
JOIN asset_node dst ON dst.id = e.to_node_id;

-- -----------------------------------------------------------------------------
-- helm.asset_graph_walk — bounded breadth-first traversal.
--
-- Deliberately NOT security definer: the walk runs under the caller's RLS, so a
-- co-managed client user tracing a dependency simply cannot step onto a node
-- outside their organisation scope. The traversal stops at the isolation
-- boundary instead of leaking its existence.
--
-- `p_relations` filters which edge kinds to follow, which is what separates a
-- useful blast-radius query ("what depends on this firewall") from a hairball.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.asset_graph_walk(
  p_root_node_id uuid,
  p_max_depth    integer DEFAULT 3,
  p_relations    link_relation[] DEFAULT NULL,
  p_max_nodes    integer DEFAULT 500
) RETURNS TABLE (
  node_id     uuid,
  node_type   node_type,
  name        text,
  depth       integer,
  path        uuid[],
  via_relation link_relation,
  parent_node_id uuid,
  criticality smallint
)
  LANGUAGE sql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  WITH RECURSIVE walk AS (
    SELECT
      n.id                       AS node_id,
      0                          AS depth,
      ARRAY[n.id]                AS path,
      NULL::link_relation        AS via_relation,
      NULL::uuid                 AS parent_node_id
    FROM asset_node n
    WHERE n.id = p_root_node_id

    UNION ALL

    SELECT
      e.to_node_id,
      w.depth + 1,
      w.path || e.to_node_id,
      e.relation,
      w.node_id
    FROM walk w
    JOIN v_asset_edge e ON e.from_node_id = w.node_id
    WHERE w.depth < p_max_depth
      AND (p_relations IS NULL OR e.relation = ANY (p_relations))
      -- Cycle guard. MSP topologies are full of them (a domain controller that
      -- both hosts and authenticates the thing that manages it).
      AND NOT (e.to_node_id = ANY (w.path))
  )
  SELECT
    w.node_id,
    n.node_type,
    n.name,
    w.depth,
    w.path,
    w.via_relation,
    w.parent_node_id,
    n.criticality
  FROM walk w
  JOIN asset_node n ON n.id = w.node_id
  ORDER BY w.depth, n.name
  LIMIT p_max_nodes;
$$;

GRANT EXECUTE ON FUNCTION helm.asset_graph_walk(uuid, integer, link_relation[], integer)
  TO helm_app, helm_auditor;
