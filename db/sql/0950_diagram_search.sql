-- =============================================================================
-- 0950 — network diagrams are found by search
--
-- A diagram (0880) is found by its name, its description, its location and
-- network, and the labels and addresses of the boxes drawn on it — so "where
-- is the core switch drawn?" is a search, not a hunt through the Diagrams tab.
--
-- A new kind, 'diagram'. The result opens /diagrams/:id.
--
-- VISIBILITY. A diagram's row is client_visible exactly when the diagram is not
-- internal-only, as for a written document. A box that stands for an
-- INTERNAL-ONLY entry contributes nothing to the index: the designer shows such
-- a box to a client user as "Restricted entry", and a search that matched the
-- entry's name would say what the designer will not. So the boxes are
-- re-projected when an entry they stand for is renamed or changes visibility.
-- =============================================================================

SET search_path = public, extensions;

ALTER TABLE search_document DROP CONSTRAINT search_document_kind_known;
ALTER TABLE search_document ADD CONSTRAINT search_document_kind_known CHECK (
  kind IN ('client', 'site', 'credential', 'document', 'asset', 'contact', 'diagram')
);

CREATE OR REPLACE FUNCTION helm.project_network_diagram(p_diagram_id uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_row     network_diagram%ROWTYPE;
  v_site    text;
  v_network text;
  v_labels  text[];
  v_ips     text[];
BEGIN
  SELECT * INTO v_row FROM network_diagram WHERE id = p_diagram_id;
  IF NOT FOUND OR v_row.archived_at IS NOT NULL THEN
    DELETE FROM search_document WHERE entity_type = 'network_diagram' AND entity_id = p_diagram_id;
    RETURN;
  END IF;

  SELECT name INTO v_site FROM site WHERE id = v_row.site_id AND deleted_at IS NULL;
  SELECT name INTO v_network FROM asset_node WHERE id = v_row.network_id;

  -- The boxes, as the designer labels them: an entry's CURRENT name and
  -- address, a drawn box's own. Restricted entries are left out (see above).
  SELECT coalesce(array_agg(coalesce(a.name, t.label)), '{}'),
         coalesce(array_agg(coalesce(host(d.primary_ip), t.ip_address))
                    FILTER (WHERE coalesce(host(d.primary_ip), t.ip_address) IS NOT NULL), '{}')
    INTO v_labels, v_ips
  FROM topology_node t
  LEFT JOIN asset_node a ON a.id = t.asset_node_id
  LEFT JOIN device d ON d.id = a.id
  WHERE t.diagram_id = p_diagram_id
    AND (t.asset_node_id IS NULL OR (a.id IS NOT NULL AND NOT a.is_internal_only));

  INSERT INTO search_document (
    entity_type, entity_id, tenant_id, organization_id, site_id, kind,
    title, subtitle, body, identifiers, is_internal_only, client_visible, updated_at
  )
  VALUES (
    'network_diagram', v_row.id, v_row.tenant_id, v_row.organization_id, v_row.site_id, 'diagram',
    v_row.name,
    coalesce(nullif(concat_ws(' · ', v_site, v_network), ''), 'Network diagram'),
    left(concat_ws(E'\n', v_row.description, array_to_string(v_labels, ', ')), 20000),
    helm.normalise_terms(v_labels || v_ips),
    v_row.is_internal_only, NOT v_row.is_internal_only, now()
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE
  SET organization_id  = EXCLUDED.organization_id,
      site_id          = EXCLUDED.site_id,
      title            = EXCLUDED.title,
      subtitle         = EXCLUDED.subtitle,
      body             = EXCLUDED.body,
      identifiers      = EXCLUDED.identifiers,
      is_internal_only = EXCLUDED.is_internal_only,
      client_visible   = EXCLUDED.client_visible,
      updated_at       = now();
END;
$$;

-- The diagram itself.
CREATE OR REPLACE FUNCTION helm.index_network_diagram() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_document WHERE entity_type = 'network_diagram' AND entity_id = OLD.id;
    RETURN OLD;
  END IF;
  PERFORM helm.project_network_diagram(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER network_diagram_search
  AFTER INSERT OR UPDATE OF name, description, site_id, network_id, is_internal_only, archived_at, organization_id
  OR DELETE ON network_diagram
  FOR EACH ROW EXECUTE FUNCTION helm.index_network_diagram();

-- A box drawn, relabelled, re-pointed or removed changes what its diagram is
-- found by.
CREATE OR REPLACE FUNCTION helm.index_topology_node() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM helm.project_network_diagram(coalesce(NEW.diagram_id, OLD.diagram_id));
  IF TG_OP = 'UPDATE' AND NEW.diagram_id IS DISTINCT FROM OLD.diagram_id THEN
    PERFORM helm.project_network_diagram(OLD.diagram_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER topology_node_search
  AFTER INSERT OR UPDATE OF label, ip_address, asset_node_id, diagram_id OR DELETE ON topology_node
  FOR EACH ROW EXECUTE FUNCTION helm.index_topology_node();

-- An entry a box stands for is renamed, readdressed or made internal-only.
CREATE OR REPLACE FUNCTION helm.reindex_diagrams_of_node() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_diagram uuid;
BEGIN
  FOR v_diagram IN
    SELECT DISTINCT t.diagram_id FROM topology_node t WHERE t.asset_node_id = NEW.id
    UNION
    SELECT d.id FROM network_diagram d WHERE d.network_id = NEW.id
  LOOP
    PERFORM helm.project_network_diagram(v_diagram);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER asset_node_reindex_diagrams
  AFTER UPDATE OF name, is_internal_only ON asset_node
  FOR EACH ROW EXECUTE FUNCTION helm.reindex_diagrams_of_node();

CREATE TRIGGER device_reindex_diagrams
  AFTER UPDATE OF primary_ip ON device
  FOR EACH ROW EXECUTE FUNCTION helm.reindex_diagrams_of_node();

-- A location renamed changes the subtitle of the diagrams of it.
CREATE OR REPLACE FUNCTION helm.reindex_diagrams_of_site() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_diagram uuid;
BEGIN
  FOR v_diagram IN SELECT id FROM network_diagram WHERE site_id = NEW.id LOOP
    PERFORM helm.project_network_diagram(v_diagram);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER site_reindex_diagrams
  AFTER UPDATE OF name, deleted_at ON site
  FOR EACH ROW EXECUTE FUNCTION helm.reindex_diagrams_of_site();

-- Every diagram drawn so far.
SELECT helm.project_network_diagram(id) FROM network_diagram;
