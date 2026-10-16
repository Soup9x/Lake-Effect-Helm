-- =============================================================================
-- 0780  Attachments on an asset, through the same door as documents
-- =============================================================================
--
-- 0130 gave `attachment` a nullable node_id for exactly this — a diagram on a
-- circuit, a signed PDF on a contract, a photo of the rack — and 0560 built the
-- document tree beside it with the rule "a document never has a node_id"
-- (attachment_document_not_node). Nothing in the application ever wrote a
-- node-anchored row, and both doors 0560 built were cut for documents alone:
-- helm.open_document() and helm.delete_document() each begin with
-- `AND is_document`, so a file attached to an asset could be uploaded and then
-- neither opened nor removed.
--
-- This widens the two doors to attachments that belong to a node. Nothing
-- else changes: the same scope and internal-only checks, the same returned
-- (not raised) refusals, the same audit rows, the same archive rail in front
-- of deletion. An attachment that is neither a document nor on a node — the
-- 0130 shape nothing has written since 0560 — stays out of reach, as before.
--
-- The bodies below are 0560's, verbatim but for the one predicate each.
-- =============================================================================

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
    AND (is_document OR node_id IS NOT NULL)
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
    AND (is_document OR node_id IS NOT NULL)
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
-- Guard: both doors admit a node attachment and still refuse the 0130 shape.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_src text;
BEGIN
  FOR v_src IN
    SELECT pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname IN ('open_document', 'delete_document')
  LOOP
    IF position('(is_document OR node_id IS NOT NULL)' IN v_src) = 0 THEN
      RAISE EXCEPTION '0780: a document door still refuses node attachments';
    END IF;
  END LOOP;
END $$;
