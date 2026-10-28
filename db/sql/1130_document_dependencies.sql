-- =============================================================================
-- 1130  A written document's dependencies
-- =============================================================================
--
-- A runbook is about things: the server it installs onto, the credential it
-- signs in with, the contact who approves it, the site it happens at, another
-- runbook it assumes was done first. 0810 gave a page a body and attachments
-- and nowhere to say any of that except in prose, where nothing can follow it
-- and nothing on the other end knows it is mentioned.
--
-- A document_page_link is one of those statements: this page depends on that
-- record. The target is one of five kinds, each a real foreign key with
-- ON DELETE CASCADE, so a link can never point at something that is gone. A
-- polymorphic (type, id) pair would have been one column shorter and would
-- have let the database hold a link to nothing.
--
-- NOT the asset graph. A page is not an asset_node, and making it one to reuse
-- asset_link would put every runbook on the impact map. The asset page reads
-- this table to list the documents that depend on it; the graph is untouched.
--
-- Same client only, as an asset link is: the guard below checks the target's
-- organisation against the page's, under the caller's RLS, so a target the
-- caller cannot see is refused exactly as one that does not exist.
-- =============================================================================

CREATE TABLE document_page_link (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  organization_id   uuid NOT NULL,
  page_id           uuid NOT NULL,

  target_node_id    uuid,
  target_page_id    uuid,
  target_contact_id uuid,
  target_site_id    uuid,
  target_diagram_id uuid,

  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT document_page_link_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT document_page_link_page_fk FOREIGN KEY (page_id, tenant_id)
    REFERENCES document_page (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT document_page_link_node_fk FOREIGN KEY (target_node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT document_page_link_target_page_fk FOREIGN KEY (target_page_id, tenant_id)
    REFERENCES document_page (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT document_page_link_contact_fk FOREIGN KEY (target_contact_id, tenant_id)
    REFERENCES contact (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT document_page_link_site_fk FOREIGN KEY (target_site_id, tenant_id)
    REFERENCES site (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT document_page_link_diagram_fk FOREIGN KEY (target_diagram_id, tenant_id)
    REFERENCES network_diagram (id, tenant_id) ON DELETE CASCADE,

  CONSTRAINT document_page_link_one_target CHECK (
    num_nonnulls(target_node_id, target_page_id, target_contact_id, target_site_id, target_diagram_id) = 1),
  CONSTRAINT document_page_link_no_self CHECK (target_page_id IS DISTINCT FROM page_id),
  CONSTRAINT document_page_link_note_ck CHECK (note IS NULL OR length(note) <= 1000),
  -- One link per page and target. NULLS NOT DISTINCT because four of the five
  -- target columns are always NULL, and plain UNIQUE would treat every row as
  -- different from every other.
  CONSTRAINT document_page_link_uk UNIQUE NULLS NOT DISTINCT
    (page_id, target_node_id, target_page_id, target_contact_id, target_site_id, target_diagram_id)
);
CREATE INDEX document_page_link_page_idx ON document_page_link (tenant_id, page_id);
CREATE INDEX document_page_link_node_idx ON document_page_link (target_node_id) WHERE target_node_id IS NOT NULL;
CREATE INDEX document_page_link_target_page_idx ON document_page_link (target_page_id) WHERE target_page_id IS NOT NULL;
CREATE INDEX document_page_link_contact_idx ON document_page_link (target_contact_id) WHERE target_contact_id IS NOT NULL;
CREATE INDEX document_page_link_site_idx ON document_page_link (target_site_id) WHERE target_site_id IS NOT NULL;
CREATE INDEX document_page_link_diagram_idx ON document_page_link (target_diagram_id) WHERE target_diagram_id IS NOT NULL;

COMMENT ON TABLE document_page_link IS
  'A written document''s dependencies (1130): the asset, document, contact, site or '
  'diagram a page relies on. Exactly one target column is set; same client only.';

-- The page decides the organisation, and the target must belong to it. SECURITY
-- INVOKER on purpose: the lookups run under the caller's RLS, so a target the
-- caller may not see reads as absent and is refused as absent.
CREATE OR REPLACE FUNCTION helm.document_page_link_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_page_org   uuid;
  v_target_org uuid;
BEGIN
  SELECT organization_id INTO v_page_org FROM document_page
  WHERE id = NEW.page_id AND deleted_at IS NULL;
  IF v_page_org IS NULL THEN
    RAISE EXCEPTION 'helm: no such document' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.organization_id := v_page_org;

  IF NEW.target_node_id IS NOT NULL THEN
    SELECT organization_id INTO v_target_org FROM asset_node WHERE id = NEW.target_node_id;
  ELSIF NEW.target_page_id IS NOT NULL THEN
    SELECT organization_id INTO v_target_org FROM document_page WHERE id = NEW.target_page_id AND deleted_at IS NULL;
  ELSIF NEW.target_contact_id IS NOT NULL THEN
    SELECT organization_id INTO v_target_org FROM contact WHERE id = NEW.target_contact_id;
  ELSIF NEW.target_site_id IS NOT NULL THEN
    SELECT organization_id INTO v_target_org FROM site WHERE id = NEW.target_site_id;
  ELSIF NEW.target_diagram_id IS NOT NULL THEN
    SELECT organization_id INTO v_target_org FROM network_diagram WHERE id = NEW.target_diagram_id;
  END IF;

  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'helm: no such record to link to' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_target_org <> v_page_org THEN
    RAISE EXCEPTION 'helm: a document can only depend on records of the same client'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_page_link_guard
  BEFORE INSERT OR UPDATE ON document_page_link
  FOR EACH ROW EXECUTE FUNCTION helm.document_page_link_guard();

SELECT helm.apply_tenant_rls('document_page_link', true, 40, NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON document_page_link TO helm_app;
GRANT SELECT ON document_page_link TO helm_auditor;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_page_link') THEN
    RAISE EXCEPTION '1130: document_page_link has no RLS policy';
  END IF;
END $$;
