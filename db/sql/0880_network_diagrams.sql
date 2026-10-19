-- =============================================================================
-- 0880 — a network diagram is a record of its own, in its own sidebar tab
--
-- 0860 hung each drawing off a Network entry. That made a drawing that spans
-- several networks — the office LAN, the voice VLAN and the guest Wi-Fi on one
-- page, which is how most people draw a building — impossible to place, and it
-- put the diagram at the bottom of a page about one subnet. So a diagram is now
-- a row of its own, network_diagram, listed under the client's "Diagrams" tab.
--
-- A diagram belongs to a CLIENT. It may also say which location it is of and
-- which network entry it is mainly about; both are optional, both are only
-- labels for finding it, and both let go (SET NULL) when that location or entry
-- goes. Neither decides who may see it: the client does, through the same RLS
-- every client record uses, plus is_internal_only for "not for the customer".
--
-- topology_node and topology_link trade network_id for diagram_id, scoped
-- through network_diagram the way they were scoped through asset_node.
--
-- EXISTING DRAWINGS MOVE, they are not dropped. Each network entry with a
-- drawing becomes a diagram of the same name, of that entry, at that entry's
-- location, and every box keeps its position and its lines.
-- =============================================================================

SET search_path = public, extensions;

CREATE TABLE network_diagram (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,
  site_id          uuid,
  network_id       uuid,
  name             text NOT NULL,
  description      text,
  is_internal_only boolean NOT NULL DEFAULT false,

  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  archived_at      timestamptz,

  CONSTRAINT network_diagram_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT network_diagram_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  -- Column lists on SET NULL: a composite key would otherwise null tenant_id
  -- with it, which the NOT NULL refuses and the delete fails (0510, 0660).
  CONSTRAINT network_diagram_site_fk FOREIGN KEY (site_id, tenant_id)
    REFERENCES site (id, tenant_id) ON DELETE SET NULL (site_id),
  CONSTRAINT network_diagram_network_fk FOREIGN KEY (network_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE SET NULL (network_id),
  CONSTRAINT network_diagram_name_ck CHECK (length(name) BETWEEN 1 AND 200),
  CONSTRAINT network_diagram_description_ck CHECK (description IS NULL OR length(description) <= 4000)
);
CREATE INDEX network_diagram_org_idx ON network_diagram (tenant_id, organization_id);
CREATE INDEX network_diagram_site_idx ON network_diagram (site_id) WHERE site_id IS NOT NULL;
CREATE INDEX network_diagram_network_idx ON network_diagram (network_id) WHERE network_id IS NOT NULL;

COMMENT ON TABLE network_diagram IS
  'A drawing of a client''s network (0880): boxes in topology_node, lines in '
  'topology_link. site_id and network_id are optional labels for finding it.';

CREATE TRIGGER network_diagram_touch BEFORE UPDATE ON network_diagram
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- The location and the network it names are the same client's, and the
-- network is a network entry.
CREATE OR REPLACE FUNCTION helm.network_diagram_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM site s
    WHERE s.id = NEW.site_id AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'helm: a diagram''s location must be the same client''s'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.network_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM asset_node n
    WHERE n.id = NEW.network_id AND n.organization_id = NEW.organization_id
      AND n.node_type = 'network'
  ) THEN
    RAISE EXCEPTION 'helm: a diagram''s network must be one of the same client''s network entries'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER network_diagram_scope
  BEFORE INSERT OR UPDATE OF organization_id, site_id, network_id ON network_diagram
  FOR EACH ROW EXECUTE FUNCTION helm.network_diagram_guard();

SELECT helm.apply_tenant_rls('network_diagram', true, 40, 'is_internal_only');
GRANT SELECT, INSERT, UPDATE, DELETE ON network_diagram TO helm_app;
GRANT SELECT ON network_diagram TO helm_auditor;

-- -----------------------------------------------------------------------------
-- Boxes and lines move to their diagram.
-- -----------------------------------------------------------------------------
ALTER TABLE topology_node ADD COLUMN diagram_id uuid;
ALTER TABLE topology_link ADD COLUMN diagram_id uuid;

DO $move$
DECLARE
  r     record;
  v_dia uuid;
BEGIN
  FOR r IN
    SELECT n.id, n.tenant_id, n.organization_id, n.site_id, n.name, n.is_internal_only
    FROM asset_node n
    WHERE EXISTS (SELECT 1 FROM topology_node t WHERE t.network_id = n.id)
       OR EXISTS (SELECT 1 FROM topology_link l WHERE l.network_id = n.id)
  LOOP
    INSERT INTO network_diagram (tenant_id, organization_id, site_id, network_id, name, is_internal_only)
    VALUES (r.tenant_id, r.organization_id, r.site_id, r.id, left(r.name, 200), r.is_internal_only)
    RETURNING id INTO v_dia;

    UPDATE topology_node SET diagram_id = v_dia WHERE network_id = r.id;
    UPDATE topology_link SET diagram_id = v_dia WHERE network_id = r.id;
  END LOOP;
END
$move$;

-- 0860's scoping goes: its triggers, its policies, and the column with its
-- foreign key and index.
DROP TRIGGER IF EXISTS topology_node_scope ON topology_node;
DROP TRIGGER IF EXISTS topology_link_endpoints ON topology_link;
DROP POLICY IF EXISTS topology_node_rls_select ON topology_node;
DROP POLICY IF EXISTS topology_node_rls_insert ON topology_node;
DROP POLICY IF EXISTS topology_node_rls_update ON topology_node;
DROP POLICY IF EXISTS topology_node_rls_delete ON topology_node;
DROP POLICY IF EXISTS topology_link_rls_select ON topology_link;
DROP POLICY IF EXISTS topology_link_rls_insert ON topology_link;
DROP POLICY IF EXISTS topology_link_rls_update ON topology_link;
DROP POLICY IF EXISTS topology_link_rls_delete ON topology_link;
ALTER TABLE topology_node DROP COLUMN network_id;
ALTER TABLE topology_link DROP COLUMN network_id;

ALTER TABLE topology_node
  ALTER COLUMN diagram_id SET NOT NULL,
  ADD CONSTRAINT topology_node_diagram_fk FOREIGN KEY (diagram_id, tenant_id)
    REFERENCES network_diagram (id, tenant_id) ON DELETE CASCADE;
ALTER TABLE topology_link
  ALTER COLUMN diagram_id SET NOT NULL,
  ADD CONSTRAINT topology_link_diagram_fk FOREIGN KEY (diagram_id, tenant_id)
    REFERENCES network_diagram (id, tenant_id) ON DELETE CASCADE;

CREATE INDEX topology_node_diagram_idx ON topology_node (tenant_id, diagram_id);
CREATE INDEX topology_link_diagram_idx ON topology_link (tenant_id, diagram_id);

COMMENT ON COLUMN topology_node.diagram_id IS 'The diagram (network_diagram) this box is on.';
COMMENT ON TABLE topology_node IS
  'A box on a network diagram, drawn by a person. Distinct from asset_link: '
  'this is physical or logical connectivity, not reliance.';
COMMENT ON TABLE topology_link IS
  'A line on a network diagram, drawn by a person: physical or logical '
  'connectivity. NOT asset_link, which models reliance and impact.';

-- A box stands only for an entry of the diagram's own client.
CREATE OR REPLACE FUNCTION helm.topology_node_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT d.organization_id INTO v_org
  FROM network_diagram d WHERE d.id = NEW.diagram_id AND d.tenant_id = NEW.tenant_id;

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
  BEFORE INSERT OR UPDATE OF diagram_id, asset_node_id ON topology_node
  FOR EACH ROW EXECUTE FUNCTION helm.topology_node_guard();

-- A line joins two boxes on its own diagram.
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
    AND (n.diagram_id <> NEW.diagram_id OR n.tenant_id <> NEW.tenant_id);

  IF v_mismatch > 0 THEN
    RAISE EXCEPTION 'helm: a topology link must join two nodes on its own diagram'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER topology_link_endpoints
  BEFORE INSERT OR UPDATE OF from_node_id, to_node_id, diagram_id ON topology_link
  FOR EACH ROW EXECUTE FUNCTION helm.topology_link_guard();

-- Visible exactly when the diagram is; drawn at rank 40, as before.
SELECT helm.apply_child_rls('topology_node', 'network_diagram', 'diagram_id', 40);
SELECT helm.apply_child_rls('topology_link', 'network_diagram', 'diagram_id', 40);

-- -----------------------------------------------------------------------------
-- The sidebar learns the slug (0620's list, plus 'diagrams').
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.sidebar_layout_valid(p_categories jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_categories) <> 'array' THEN false
    WHEN jsonb_array_length(p_categories) > 20 THEN false
    ELSE NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(p_categories) AS c(slug)
           WHERE c.slug NOT IN (
             'configurations', 'contacts', 'diagrams', 'documents', 'domains',
             'locations', 'networks', 'passwords', 'ssl',
             'applications', 'directories', 'circuits', 'contracts',
             'licenses', 'vendors', 'sops', 'ip-addresses'
           )
         )
         AND (SELECT count(DISTINCT c.slug)
                FROM jsonb_array_elements_text(p_categories) AS c(slug))
             = jsonb_array_length(p_categories)
  END;
$$;

DO $$
BEGIN
  IF NOT helm.sidebar_layout_valid('["diagrams"]'::jsonb) THEN
    RAISE EXCEPTION '0880: sidebar_layout_valid() refuses diagrams';
  END IF;
  IF helm.sidebar_layout_valid('["not_a_category"]'::jsonb) THEN
    RAISE EXCEPTION '0880: sidebar_layout_valid() accepts unknown slugs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'network_diagram') THEN
    RAISE EXCEPTION '0880: network_diagram has no RLS policy';
  END IF;
END
$$;
