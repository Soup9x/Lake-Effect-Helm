-- =============================================================================
-- 0860 — a network diagram belongs to a network entry, not to a location
--
-- 0570 scoped a diagram to a SITE: one drawing per building, opened from a
-- small button in the client overview's site table that few people found. The
-- diagram is about a network — a VLAN, a subnet, the office LAN — and the
-- Network entry is where somebody goes to read about one. So each Network entry
-- now has its own diagram, shown on its page.
--
-- topology_node and topology_link trade site_id for network_id, a reference to
-- the asset_node of type 'network' that owns the drawing. RLS is re-scoped
-- through asset_node the same way it was scoped through site, so a drawing is
-- visible exactly when its network entry is — internal-only networks included.
--
-- EXISTING DRAWINGS MOVE, they are not dropped. Each site with a drawing hands
-- it to that site's first network entry by name; a site with none gets one,
-- named "<site> network", to hold it. Nothing is lost and every box keeps its
-- position and its lines.
--
-- TWO NEW RULES, each a trigger because each is cross-table:
--   a diagram's owner must actually be a network entry; and
--   a box that stands for an entry (asset_node_id) must stand for one of the
--   same client — a configuration from another client on this diagram would
--   be a leak of its name and address the first time the diagram is opened.
-- =============================================================================

SET search_path = public, extensions;

ALTER TABLE topology_node ADD COLUMN network_id uuid;
ALTER TABLE topology_link ADD COLUMN network_id uuid;

DO $move$
DECLARE
  r     record;
  v_net uuid;
BEGIN
  FOR r IN
    SELECT DISTINCT s.id, s.tenant_id, s.organization_id, s.name
    FROM site s
    WHERE EXISTS (SELECT 1 FROM topology_node t WHERE t.site_id = s.id)
       OR EXISTS (SELECT 1 FROM topology_link l WHERE l.site_id = s.id)
  LOOP
    v_net := NULL;
    SELECT n.id INTO v_net
    FROM asset_node n
    WHERE n.node_type = 'network' AND n.site_id = r.id AND n.archived_at IS NULL
    ORDER BY lower(n.name), n.id
    LIMIT 1;

    IF v_net IS NULL THEN
      INSERT INTO asset_node (tenant_id, organization_id, site_id, node_type, name, notes)
      VALUES (r.tenant_id, r.organization_id, r.id, 'network', left(r.name, 180) || ' network',
              'Created by migration 0860 to hold this location''s network diagram.')
      RETURNING id INTO v_net;
      INSERT INTO network (id, tenant_id, kind) VALUES (v_net, r.tenant_id, 'subnet');
    END IF;

    UPDATE topology_node SET network_id = v_net WHERE site_id = r.id;
    UPDATE topology_link SET network_id = v_net WHERE site_id = r.id;
  END LOOP;
END
$move$;

-- The old scoping goes: its trigger (which names site_id), its policies, and
-- the column with its foreign key and index.
DROP TRIGGER IF EXISTS topology_link_endpoints ON topology_link;
DROP POLICY IF EXISTS topology_node_rls_select ON topology_node;
DROP POLICY IF EXISTS topology_node_rls_insert ON topology_node;
DROP POLICY IF EXISTS topology_node_rls_update ON topology_node;
DROP POLICY IF EXISTS topology_node_rls_delete ON topology_node;
DROP POLICY IF EXISTS topology_link_rls_select ON topology_link;
DROP POLICY IF EXISTS topology_link_rls_insert ON topology_link;
DROP POLICY IF EXISTS topology_link_rls_update ON topology_link;
DROP POLICY IF EXISTS topology_link_rls_delete ON topology_link;
ALTER TABLE topology_node DROP COLUMN site_id;
ALTER TABLE topology_link DROP COLUMN site_id;

ALTER TABLE topology_node
  ALTER COLUMN network_id SET NOT NULL,
  ADD CONSTRAINT topology_node_network_fk FOREIGN KEY (network_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE;
ALTER TABLE topology_link
  ALTER COLUMN network_id SET NOT NULL,
  ADD CONSTRAINT topology_link_network_fk FOREIGN KEY (network_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE;

CREATE INDEX topology_node_network_idx ON topology_node (tenant_id, network_id);
CREATE INDEX topology_link_network_idx ON topology_link (tenant_id, network_id);

COMMENT ON COLUMN topology_node.network_id IS
  'The network entry (asset_node of type network) whose diagram this box is on.';
COMMENT ON TABLE topology_node IS
  'A box on a network entry''s diagram, drawn by a person. Distinct from '
  'asset_link: this is physical or logical connectivity, not reliance.';
COMMENT ON TABLE topology_link IS
  'A line on a network entry''s diagram, drawn by a person: physical or logical '
  'connectivity. NOT asset_link, which models reliance and impact.';

-- -----------------------------------------------------------------------------
-- A box belongs to a network entry, and stands only for the same client's
-- entries.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.topology_node_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_type node_type;
  v_org  uuid;
BEGIN
  SELECT n.node_type, n.organization_id INTO v_type, v_org
  FROM asset_node n WHERE n.id = NEW.network_id AND n.tenant_id = NEW.tenant_id;

  IF v_type IS DISTINCT FROM 'network' THEN
    RAISE EXCEPTION 'helm: a network diagram belongs to a network entry'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.asset_node_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM asset_node a
    WHERE a.id = NEW.asset_node_id AND a.organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'helm: a box can only stand for an entry of the same client'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER topology_node_scope
  BEFORE INSERT OR UPDATE OF network_id, asset_node_id ON topology_node
  FOR EACH ROW EXECUTE FUNCTION helm.topology_node_guard();

-- A line joins two boxes on its own diagram: 0570's guard, by network.
CREATE OR REPLACE FUNCTION helm.topology_link_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_mismatch integer;
BEGIN
  SELECT count(*) INTO v_mismatch
  FROM topology_node n
  WHERE n.id IN (NEW.from_node_id, NEW.to_node_id)
    AND (n.network_id <> NEW.network_id OR n.tenant_id <> NEW.tenant_id);

  IF v_mismatch > 0 THEN
    RAISE EXCEPTION 'helm: a topology link must join two nodes on its own diagram'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER topology_link_endpoints
  BEFORE INSERT OR UPDATE OF from_node_id, to_node_id, network_id ON topology_link
  FOR EACH ROW EXECUTE FUNCTION helm.topology_link_guard();

-- Visible exactly when the network entry is; drawn at rank 40, as before.
SELECT helm.apply_child_rls('topology_node', 'asset_node', 'network_id', 40);
SELECT helm.apply_child_rls('topology_link', 'asset_node', 'network_id', 40);
