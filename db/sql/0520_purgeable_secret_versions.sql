-- =============================================================================
-- 0520 — secret_version becomes deletable by the purge path, and by nothing else
--
-- 0500 added permanent deletion and immediately hit the wall that ought to be
-- there:
--
--   ERROR: helm: DELETE on secret_version is not permitted; this table is
--          append-only
--
-- secret_version carries helm.deny_mutation(), which refuses UPDATE and DELETE
-- outright. That is correct for every ordinary path — credential history is not
-- something a technician edits — and it makes deleting a client impossible,
-- because a client's secrets cannot go while their versions remain
-- (secret_version.secret_id is ON DELETE RESTRICT).
--
-- WHAT THIS FILE DOES NOT TOUCH. helm.deny_mutation() is shared with audit_log,
-- sop_version and flexible_asset_type_version. It is left byte-for-byte alone,
-- and audit_log keeps pointing at it. The immutability of the audit trail is
-- the entire reason permanent deletion is defensible at all — a client's
-- documentation can be destroyed precisely because the record of what was done
-- to it cannot be. Weakening the shared function to solve a secret_version
-- problem would have quietly put that within reach.
--
-- So secret_version gets its own trigger function with one narrow exemption,
-- and the other three tables are unaffected.
--
-- THE EXEMPTION HAS TWO LOCKS, and needs both:
--
--   1. helm.purging must be 'on'. Set with SET LOCAL inside the delete
--      functions, so it cannot outlive the transaction that set it.
--
--   2. The caller must own the table. helm_app does not; the delete functions
--      are SECURITY DEFINER and owned by the role that does, so current_user is
--      the owner inside them and helm_app everywhere else.
--
-- One alone would be a hole. helm_app can call set_config() itself — nothing
-- stops it — so the GUC by itself would let the request role delete credential
-- history directly. Ownership by itself would let any future SECURITY DEFINER
-- function do it by accident. Together they mean: only code that was written to
-- purge, running as the owner, inside one transaction.
-- =============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION helm.deny_mutation_unless_purging() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('helm.purging', true) = 'on'
     AND pg_has_role(current_user,
                     (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID),
                     'USAGE')
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'helm: % on % is not permitted; this table is append-only',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Write a new row instead. Correcting history is not a supported operation.';
END;
$$;

DROP TRIGGER IF EXISTS secret_version_append_only ON secret_version;
CREATE TRIGGER secret_version_append_only
  BEFORE UPDATE OR DELETE ON secret_version
  FOR EACH ROW EXECUTE FUNCTION helm.deny_mutation_unless_purging();

-- -----------------------------------------------------------------------------
-- The two delete functions, reissued with the flag raised around their purge.
-- Only the SET LOCAL pair is added; the rest is 0500 unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.delete_organization(p_organization_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_org     organization%ROWTYPE;
  v_counts  jsonb;
BEGIN
  SELECT * INTO v_org FROM organization
  WHERE id = p_organization_id AND tenant_id = v_tenant;

  IF NOT FOUND OR NOT helm.org_in_scope(p_organization_id) THEN
    RAISE EXCEPTION 'helm: client % not found', p_organization_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT helm.has_permission('organization:delete') THEN
    PERFORM helm.audit('organization.delete_denied', 'organization', p_organization_id,
                       'denied'::audit_outcome, p_organization_id, NULL, NULL,
                       jsonb_build_object('cause', 'missing_permission'));
    RAISE EXCEPTION 'helm: organization:delete is required to delete a client'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_org.archived_at IS NULL THEN
    RAISE EXCEPTION 'helm: % must be archived before it can be deleted', v_org.name
      USING ERRCODE = 'check_violation', DETAIL = 'archive_first';
  END IF;

  SELECT jsonb_build_object(
    'assets',      (SELECT count(*) FROM asset_node WHERE organization_id = p_organization_id),
    'secrets',     (SELECT count(*) FROM secret     WHERE organization_id = p_organization_id),
    'sites',       (SELECT count(*) FROM site       WHERE organization_id = p_organization_id),
    'contacts',    (SELECT count(*) FROM contact    WHERE organization_id = p_organization_id),
    'notes',       (SELECT count(*) FROM note       WHERE organization_id = p_organization_id),
    'attachments', (SELECT count(*) FROM attachment WHERE organization_id = p_organization_id)
  ) INTO v_counts;

  PERFORM helm.audit('organization.deleted', 'organization', p_organization_id,
                     'success'::audit_outcome, p_organization_id, NULL, NULL,
                     v_counts || jsonb_build_object('name', v_org.name, 'slug', v_org.slug));

  DELETE FROM asset_node WHERE organization_id = p_organization_id;
  DELETE FROM unifi_site_mapping WHERE organization_id = p_organization_id;

  -- Transaction-local, and lowered again immediately: the window in which
  -- credential history can be removed is exactly these two statements.
  PERFORM set_config('helm.purging', 'on', true);
  DELETE FROM secret_version
   WHERE secret_id IN (SELECT id FROM secret WHERE organization_id = p_organization_id);
  DELETE FROM secret WHERE organization_id = p_organization_id;
  PERFORM set_config('helm.purging', 'off', true);

  DELETE FROM organization WHERE id = p_organization_id;

  RETURN v_counts;
END;
$$;

CREATE OR REPLACE FUNCTION helm.delete_credential(p_node_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_node    asset_node%ROWTYPE;
  v_cred    credential%ROWTYPE;
  v_secrets uuid[];
  v_removed integer := 0;
BEGIN
  SELECT * INTO v_node FROM asset_node
  WHERE id = p_node_id AND tenant_id = v_tenant AND node_type = 'credential';

  IF NOT FOUND OR NOT helm.org_in_scope(v_node.organization_id) THEN
    RAISE EXCEPTION 'helm: credential % not found', p_node_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT helm.has_permission('secret:delete') THEN
    PERFORM helm.audit('credential.delete_denied', 'asset_node', p_node_id,
                       'denied'::audit_outcome, v_node.organization_id, p_node_id, NULL,
                       jsonb_build_object('cause', 'missing_permission'));
    RAISE EXCEPTION 'helm: secret:delete is required to delete a credential'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_node.archived_at IS NULL THEN
    RAISE EXCEPTION 'helm: % must be archived before it can be deleted', v_node.name
      USING ERRCODE = 'check_violation', DETAIL = 'archive_first';
  END IF;

  SELECT * INTO v_cred FROM credential WHERE id = p_node_id;
  v_secrets := ARRAY(SELECT s FROM unnest(ARRAY[v_cred.secret_id, v_cred.totp_secret_id]) s
                      WHERE s IS NOT NULL);

  PERFORM helm.audit('credential.deleted', 'asset_node', p_node_id,
                     'success'::audit_outcome, v_node.organization_id, p_node_id, NULL,
                     jsonb_build_object('name', v_node.name,
                                        'secret_count', coalesce(array_length(v_secrets, 1), 0)));

  DELETE FROM asset_node WHERE id = p_node_id;

  IF array_length(v_secrets, 1) > 0 THEN
    PERFORM set_config('helm.purging', 'on', true);

    -- Only material nothing else documents. A secret can be referenced by more
    -- than one credential — that is the premise of secret_node_visible()'s
    -- bool_or — and deleting the last credential pointing at a shared password
    -- must not take it from the other one.
    DELETE FROM secret_version
     WHERE secret_id = ANY (v_secrets)
       AND NOT EXISTS (SELECT 1 FROM credential c
                        WHERE c.secret_id = secret_version.secret_id
                           OR c.totp_secret_id = secret_version.secret_id)
       AND NOT EXISTS (SELECT 1 FROM flexible_asset_secret f
                        WHERE f.secret_id = secret_version.secret_id)
       AND NOT EXISTS (SELECT 1 FROM ssl_certificate x
                        WHERE x.private_key_secret_id = secret_version.secret_id)
       AND NOT EXISTS (SELECT 1 FROM license l
                        WHERE l.license_key_secret_id = secret_version.secret_id)
       AND NOT EXISTS (SELECT 1 FROM unifi_site_mapping u
                        WHERE u.api_key_secret_id = secret_version.secret_id);

    WITH gone AS (
      DELETE FROM secret
       WHERE id = ANY (v_secrets)
         AND NOT EXISTS (SELECT 1 FROM secret_version v WHERE v.secret_id = secret.id)
         AND NOT EXISTS (SELECT 1 FROM credential c
                          WHERE c.secret_id = secret.id OR c.totp_secret_id = secret.id)
         AND NOT EXISTS (SELECT 1 FROM flexible_asset_secret f WHERE f.secret_id = secret.id)
         AND NOT EXISTS (SELECT 1 FROM ssl_certificate x WHERE x.private_key_secret_id = secret.id)
         AND NOT EXISTS (SELECT 1 FROM license l WHERE l.license_key_secret_id = secret.id)
         AND NOT EXISTS (SELECT 1 FROM unifi_site_mapping u WHERE u.api_key_secret_id = secret.id)
      RETURNING 1)
    SELECT count(*) INTO v_removed FROM gone;

    PERFORM set_config('helm.purging', 'off', true);
  END IF;

  RETURN jsonb_build_object('name', v_node.name, 'secrets_removed', v_removed);
END;
$$;

-- =============================================================================
-- Guards
-- =============================================================================
DO $purge_guard$
DECLARE
  v_fn text := (SELECT pg_get_functiondef('helm.deny_mutation_unless_purging()'::regprocedure));
BEGIN
  -- 1. THE AUDIT LOG IS UNTOUCHED. Every audit_log partition must still point
  --    at the ORIGINAL deny_mutation(), which has no exemption of any kind.
  --    This is the assertion that keeps permanent deletion defensible.
  IF EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal
      AND c.relname LIKE 'audit_log%'
      AND t.tgname = 'audit_log_immutable'
      AND t.tgfoid <> 'helm.deny_mutation()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'helm: an audit_log trigger no longer uses the unexempted deny_mutation()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relname = 'audit_log' AND t.tgname = 'audit_log_immutable'
  ) THEN
    RAISE EXCEPTION 'helm: the audit_log immutability trigger is missing';
  END IF;

  -- 2. AND SO ARE THE OTHER APPEND-ONLY TABLES. Only secret_version was meant
  --    to become purgeable.
  IF EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal
      AND t.tgfoid = 'helm.deny_mutation_unless_purging()'::regprocedure
      AND c.relname <> 'secret_version'
  ) THEN
    RAISE EXCEPTION 'helm: the purge exemption has spread beyond secret_version';
  END IF;

  -- 3. BOTH LOCKS ARE PRESENT. Either alone is a hole: the GUC without the
  --    ownership test lets helm_app set it and delete credential history
  --    directly, and ownership without the GUC lets any future SECURITY
  --    DEFINER function do it by accident.
  IF v_fn !~ 'helm\.purging' THEN
    RAISE EXCEPTION 'helm: the purge exemption no longer requires the helm.purging flag';
  END IF;
  IF v_fn !~ 'pg_has_role' THEN
    RAISE EXCEPTION 'helm: the purge exemption no longer requires table ownership';
  END IF;

  -- 4. UPDATE IS STILL REFUSED OUTRIGHT. The exemption is for removal, never
  --    for rewriting a version in place.
  IF v_fn !~ 'TG_OP = ''DELETE''' THEN
    RAISE EXCEPTION 'helm: the purge exemption is not limited to DELETE';
  END IF;
END;
$purge_guard$;
