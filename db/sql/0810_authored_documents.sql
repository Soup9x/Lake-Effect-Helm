-- =============================================================================
-- 0810  Documents you write, in the same tree as the files you upload
-- =============================================================================
--
-- 0560 built a client's document tree for FILES: a PDF from the vendor, a
-- network diagram, a scanned contract. What a technician writes themselves —
-- the onboarding runbook, how the phone system is set up, the notes from the
-- site visit — had nowhere to go but a notes box on an asset or a Word file
-- uploaded into the tree, where nobody can search inside it.
--
-- A document_page is a written document: a title, a body the editor keeps as
-- JSON, and the body's plain text for search. It lives in the same folders as
-- the files, inherits internal-only from its folder the same way, and shows
-- up in the same listings. Files can be attached to a page (attachment.page_id,
-- the third anchor after a node and a folder), which is how an image gets
-- into one.
--
-- NOT ENCRYPTED AT REST, and said plainly: a page's body is stored as the
-- notes on an asset are, in the row, readable by the database roles that may
-- read the row. The files attached to it are encrypted as every attachment is.
-- A page is documentation; a credential belongs in the vault, where the page
-- can link to it.
-- =============================================================================

CREATE TABLE document_page (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,
  folder_id        uuid,
  title            text NOT NULL,
  body             jsonb NOT NULL DEFAULT '{"type":"doc","content":[]}'::jsonb,
  body_text        text NOT NULL DEFAULT '',
  is_internal_only boolean NOT NULL DEFAULT false,
  version          integer NOT NULL DEFAULT 1,

  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  archived_at      timestamptz,
  deleted_at       timestamptz,

  CONSTRAINT document_page_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT document_page_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  -- The folder must be the same client's: the three-column key says so.
  CONSTRAINT document_page_folder_fk FOREIGN KEY (folder_id, tenant_id, organization_id)
    REFERENCES document_folder (id, tenant_id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT document_page_title_ck CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT document_page_body_ck CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT document_page_body_size_ck CHECK (pg_column_size(body) <= 4 * 1024 * 1024)
);
CREATE INDEX document_page_org_idx ON document_page (tenant_id, organization_id) WHERE deleted_at IS NULL;
CREATE INDEX document_page_folder_idx ON document_page (tenant_id, folder_id) WHERE deleted_at IS NULL;
-- One title per folder, as one filename per folder (0560).
CREATE UNIQUE INDEX document_page_title_uk
  ON document_page (organization_id, coalesce(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(title))
  WHERE deleted_at IS NULL;

COMMENT ON TABLE document_page IS
  'A written document in a client''s document tree (0810). body is the editor''s '
  'JSON; body_text is its plain text, for search. Files attach via attachment.page_id.';

CREATE TRIGGER document_page_touch BEFORE UPDATE ON document_page
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- Inheritance on the way in, as attachment_folder_guard does for files.
CREATE OR REPLACE FUNCTION helm.document_page_folder_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_folder document_folder%ROWTYPE;
BEGIN
  IF NEW.folder_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_folder FROM document_folder WHERE id = NEW.folder_id;
  IF FOUND AND v_folder.is_internal_only THEN
    NEW.is_internal_only := true;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_page_folder_guard
  BEFORE INSERT OR UPDATE OF folder_id, is_internal_only ON document_page
  FOR EACH ROW EXECUTE FUNCTION helm.document_page_folder_guard();

-- -----------------------------------------------------------------------------
-- Attachments on a page: the third anchor.
-- -----------------------------------------------------------------------------
ALTER TABLE attachment ADD COLUMN IF NOT EXISTS page_id uuid;
ALTER TABLE attachment
  ADD CONSTRAINT attachment_page_fk FOREIGN KEY (page_id, tenant_id)
    REFERENCES document_page (id, tenant_id) ON DELETE CASCADE,
  ADD CONSTRAINT attachment_document_not_page CHECK (NOT is_document OR page_id IS NULL),
  ADD CONSTRAINT attachment_one_anchor CHECK (node_id IS NULL OR page_id IS NULL);
CREATE INDEX attachment_page_idx ON attachment (tenant_id, page_id) WHERE page_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Search. The whole body, at the weight prose gets; the title and the folder
-- path as identifiers, as a file's name and path are.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.project_document_page(p_page_id uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_row  document_page%ROWTYPE;
  v_path text[];
BEGIN
  SELECT * INTO v_row FROM document_page WHERE id = p_page_id;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL OR v_row.archived_at IS NOT NULL THEN
    DELETE FROM search_document WHERE entity_type = 'document_page' AND entity_id = p_page_id;
    RETURN;
  END IF;

  v_path := helm.document_folder_path(v_row.folder_id);

  INSERT INTO search_document (
    entity_type, entity_id, tenant_id, organization_id, kind,
    title, subtitle, body, identifiers, is_internal_only, client_visible, updated_at
  )
  VALUES (
    'document_page', v_row.id, v_row.tenant_id, v_row.organization_id, 'document',
    v_row.title,
    CASE WHEN array_length(v_path, 1) > 0 THEN array_to_string(v_path, ' / ') ELSE 'Documents' END,
    left(v_row.body_text, 20000),
    helm.normalise_terms(ARRAY[v_row.title] || v_path),
    v_row.is_internal_only, NOT v_row.is_internal_only, now()
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE
  SET organization_id  = EXCLUDED.organization_id,
      title            = EXCLUDED.title,
      subtitle         = EXCLUDED.subtitle,
      body             = EXCLUDED.body,
      identifiers      = EXCLUDED.identifiers,
      is_internal_only = EXCLUDED.is_internal_only,
      client_visible   = EXCLUDED.client_visible,
      updated_at       = now();
END;
$$;

CREATE OR REPLACE FUNCTION helm.index_document_page() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_document WHERE entity_type = 'document_page' AND entity_id = OLD.id;
    RETURN OLD;
  END IF;
  PERFORM helm.project_document_page(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_page_search
  AFTER INSERT OR UPDATE OF title, body_text, is_internal_only, deleted_at, archived_at, folder_id
  OR DELETE ON document_page
  FOR EACH ROW EXECUTE FUNCTION helm.index_document_page();

-- A folder rename or move changes every page's path beneath it too.
CREATE OR REPLACE FUNCTION helm.document_folder_reindex_pages() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_page uuid;
BEGIN
  FOR v_page IN
    WITH RECURSIVE subtree AS (
      SELECT NEW.id AS id
      UNION ALL
      SELECT c.id FROM document_folder c JOIN subtree s ON c.parent_id = s.id
    )
    SELECT p.id FROM document_page p JOIN subtree s ON p.folder_id = s.id WHERE p.deleted_at IS NULL
  LOOP
    PERFORM helm.project_document_page(v_page);
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER document_folder_reindex_pages
  AFTER UPDATE OF name, parent_id ON document_folder
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.parent_id IS DISTINCT FROM NEW.parent_id)
  EXECUTE FUNCTION helm.document_folder_reindex_pages();

-- A folder with a page in it is not empty. 0560's body, with pages counted.
CREATE OR REPLACE FUNCTION helm.document_folder_before_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_folders integer;
  v_files   integer;
  v_pages   integer;
BEGIN
  SELECT count(*) INTO v_folders FROM document_folder WHERE parent_id = OLD.id;
  SELECT count(*) INTO v_files FROM attachment WHERE folder_id = OLD.id AND deleted_at IS NULL;
  SELECT count(*) INTO v_pages FROM document_page WHERE folder_id = OLD.id AND deleted_at IS NULL;

  IF v_folders > 0 OR v_files > 0 OR v_pages > 0 THEN
    RAISE EXCEPTION
      'helm: % is not empty (% subfolder(s), % document(s)); move or delete its contents first',
      OLD.name, v_folders, v_files + v_pages
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  PERFORM helm.audit(
    'document_folder.deleted', 'document_folder', OLD.id, 'success',
    OLD.organization_id, NULL, NULL,
    jsonb_build_object('name', OLD.name, 'path', helm.document_folder_path(OLD.id)));

  RETURN OLD;
END;
$$;

-- -----------------------------------------------------------------------------
-- Permanent deletion: archive-first and asset:delete, as a file's. Returns
-- the storage keys of the page's attachments so the caller can unlink the
-- bytes after the transaction commits; the rows go with the page by cascade.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.delete_document_page(p_page_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_page document_page%ROWTYPE;
  v_keys text[];
BEGIN
  SELECT * INTO v_page FROM document_page
  WHERE id = p_page_id AND tenant_id = helm.require_tenant_id() AND deleted_at IS NULL;

  IF NOT FOUND
     OR NOT helm.org_in_scope(v_page.organization_id)
     OR NOT helm.internal_visible(v_page.is_internal_only) THEN
    RETURN jsonb_build_object('deleted', false, 'reason', 'not_found');
  END IF;
  IF NOT helm.has_permission('asset:delete') THEN
    RETURN jsonb_build_object('deleted', false, 'reason', 'forbidden',
      'audit_event_uid', helm.audit('document_page.delete_denied', 'document_page', p_page_id, 'denied',
        v_page.organization_id, NULL, 'asset:delete required', '{}'::jsonb));
  END IF;
  IF v_page.archived_at IS NULL THEN
    RETURN jsonb_build_object('deleted', false, 'reason', 'not_archived',
      'message', 'archive this document first — permanent deletion is only available from the archive');
  END IF;

  SELECT coalesce(array_agg(a.storage_key), '{}') INTO v_keys
  FROM attachment a WHERE a.page_id = p_page_id;

  PERFORM helm.audit(
    'document_page.deleted', 'document_page', p_page_id, 'success',
    v_page.organization_id, NULL, NULL,
    jsonb_build_object('title', v_page.title, 'path', helm.document_folder_path(v_page.folder_id),
                       'attachments', coalesce(array_length(v_keys, 1), 0)));

  DELETE FROM document_page WHERE id = p_page_id;
  RETURN jsonb_build_object('deleted', true, 'storage_keys', to_jsonb(v_keys));
END;
$$;
REVOKE ALL ON FUNCTION helm.delete_document_page(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.delete_document_page(uuid) TO helm_app;

-- -----------------------------------------------------------------------------
-- The two attachment doors, opened to the third anchor. 0780's bodies with
-- the predicate widened once more.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.open_document(p_attachment_id uuid)
  RETURNS TABLE (
    ok               boolean,
    deny_reason      text,
    attachment_id    uuid,
    organization_id  uuid,
    filename         text,
    content_type     text,
    byte_size        bigint,
    storage_key      text,
    data_key_id      uuid,
    encryption_nonce bytea,
    content_sha256   bytea,
    audit_event_uid  uuid
  )
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_doc attachment%ROWTYPE;
  v_uid uuid;
BEGIN
  SELECT * INTO v_doc FROM attachment
  WHERE id = p_attachment_id
    AND tenant_id = helm.require_tenant_id()
    AND (is_document OR node_id IS NOT NULL OR page_id IS NOT NULL)
    AND deleted_at IS NULL;

  -- Every clause RLS would have applied, applied by hand because this function
  -- is not subject to it. Out of scope, internal-only to a client actor, or
  -- simply absent all answer the same way: there is no such document. A
  -- distinguishable "exists but you may not" tells a client which folders the
  -- MSP keeps from them.
  IF NOT FOUND
     OR NOT helm.org_in_scope(v_doc.organization_id)
     OR NOT helm.internal_visible(v_doc.is_internal_only)
     OR NOT helm.has_permission('asset:read') THEN
    -- RETURNED, NOT RAISED, and that is the whole reason this reads oddly.
    -- helm.audit() writes a row; RAISE would roll it back, taking the record of
    -- the refusal with it. A denied attempt on a client's files is precisely
    -- what an investigation needs, so the refusal comes back as data the way
    -- helm.reveal_secret() has done since 0210.
    v_uid := helm.audit(
      'document.download_denied', 'attachment', p_attachment_id, 'denied',
      CASE WHEN v_doc.id IS NOT NULL THEN v_doc.organization_id END, NULL,
      'not visible to this actor', '{}'::jsonb);
    RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::text, NULL::bigint, NULL::text, NULL::uuid, NULL::bytea,
                        NULL::bytea, v_uid;
    RETURN;
  END IF;

  v_uid := helm.audit(
    'document.downloaded', 'attachment', v_doc.id, 'success',
    v_doc.organization_id, NULL, NULL,
    jsonb_build_object(
      'filename', v_doc.filename,
      'path', helm.document_folder_path(v_doc.folder_id),
      'byte_size', v_doc.byte_size,
      'is_internal_only', v_doc.is_internal_only,
      'archived', v_doc.archived_at IS NOT NULL));

  RETURN QUERY SELECT
    true, NULL::text,
    v_doc.id, v_doc.organization_id, v_doc.filename, v_doc.content_type,
    v_doc.byte_size, v_doc.storage_key, v_doc.data_key_id, v_doc.encryption_nonce,
    v_doc.content_sha256, v_uid;
END;
$$;

CREATE OR REPLACE FUNCTION helm.delete_document(p_attachment_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_doc attachment%ROWTYPE;
BEGIN
  SELECT * INTO v_doc FROM attachment
  WHERE id = p_attachment_id
    AND tenant_id = helm.require_tenant_id()
    AND (is_document OR node_id IS NOT NULL OR page_id IS NOT NULL)
    AND deleted_at IS NULL;

  -- Every refusal below RETURNS rather than RAISES, for the reason spelled out
  -- in helm.open_document(): an audit row written and then raised past is an
  -- audit row that never existed. The caller reads `deleted` and reports the
  -- reason; db/tests/security.sql asserts both the refusal and its trail.
  IF NOT FOUND
     OR NOT helm.org_in_scope(v_doc.organization_id)
     OR NOT helm.internal_visible(v_doc.is_internal_only) THEN
    RETURN jsonb_build_object(
      'deleted', false, 'reason', 'not_found',
      'audit_event_uid', helm.audit(
        'document.delete_denied', 'attachment', p_attachment_id, 'denied',
        CASE WHEN v_doc.id IS NOT NULL THEN v_doc.organization_id END, NULL,
        'not visible to this actor', '{}'::jsonb));
  END IF;

  IF NOT helm.has_permission('asset:delete') THEN
    RETURN jsonb_build_object(
      'deleted', false, 'reason', 'forbidden',
      'message', 'asset:delete is required to delete a document',
      'audit_event_uid', helm.audit(
        'document.delete_denied', 'attachment', v_doc.id, 'denied',
        v_doc.organization_id, NULL, 'asset:delete not held',
        jsonb_build_object('filename', v_doc.filename)));
  END IF;

  IF v_doc.archived_at IS NULL THEN
    RETURN jsonb_build_object(
      'deleted', false, 'reason', 'not_archived',
      'message', format('%s must be archived before it can be deleted', v_doc.filename),
      'audit_event_uid', helm.audit(
        'document.delete_denied', 'attachment', v_doc.id, 'denied',
        v_doc.organization_id, NULL, 'not archived',
        jsonb_build_object('filename', v_doc.filename)));
  END IF;

  -- Before the row goes, so the trail carries what was destroyed. audit_log has
  -- no foreign key into attachment — checked in the guards below — so this
  -- survives the deletion.
  PERFORM helm.audit(
    'document.deleted', 'attachment', v_doc.id, 'success',
    v_doc.organization_id, NULL, NULL,
    jsonb_build_object(
      'filename', v_doc.filename,
      'path', helm.document_folder_path(v_doc.folder_id),
      'byte_size', v_doc.byte_size,
      'content_sha256', encode(v_doc.content_sha256, 'hex'),
      'is_internal_only', v_doc.is_internal_only));

  DELETE FROM attachment WHERE id = v_doc.id;

  RETURN jsonb_build_object('deleted', true, 'storage_key', v_doc.storage_key);
END;
$$;

-- -----------------------------------------------------------------------------
-- RLS and grants: as a document, flag declared.
-- -----------------------------------------------------------------------------
SELECT helm.apply_tenant_rls('document_page', true, 40, 'is_internal_only');
GRANT SELECT, INSERT, UPDATE, DELETE ON document_page TO helm_app;
GRANT SELECT ON document_page TO helm_auditor;

DO $$
DECLARE v_src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_page') THEN
    RAISE EXCEPTION '0810: document_page has no RLS policy';
  END IF;
  FOR v_src IN
    SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname IN ('open_document', 'delete_document')
  LOOP
    IF position('page_id IS NOT NULL' IN v_src) = 0 THEN
      RAISE EXCEPTION '0810: a document door still refuses page attachments';
    END IF;
  END LOOP;
END $$;
