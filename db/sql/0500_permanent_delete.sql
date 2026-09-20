-- =============================================================================
-- 0500 — permanent deletion of a client or a credential, archive first
--
-- Everything in Helm has been recoverable until now: archived_at hides a row,
-- deleted_at retires it, and nothing removes it. That is the right default for
-- documentation, and it is not sufficient — a client that left two years ago is
-- a liability an MSP is sometimes contractually required to be rid of.
--
-- THE SAFETY RAIL IS ARCHIVE-FIRST. A row must already carry archived_at before
-- it can be deleted, so permanent removal is never one click from a live record.
-- It is enforced here rather than in a route: a rule that only exists in the
-- interface is one a script, a future endpoint or a psql session walks past.
--
-- WHICH PERMISSION, confirmed against the catalogue rather than assumed:
--
--   archiving            asset:write        held by tier1..3, super_admin AND
--                                           client_admin (a co-managed customer)
--   deleting a client    organization:delete msp_only, super_admin ALONE
--   deleting a credential secret:delete      msp_only, tier3 and super_admin
--
-- Both already existed and both already sit strictly above archiving, which is
-- what the brief asked for. Nothing new was minted, and in particular no
-- client-side role can reach either: msp_only is enforced on role_permission by
-- 0020 and, since 0480, on membership_permission too.
--
-- THE AUDIT TRAIL SURVIVES THE ROW. audit_log carries organization_id and
-- node_id as plain uuids with NO foreign key — checked, not assumed — so
-- deleting a client destroys its documentation and leaves every record of what
-- was done to it intact, hash-chained, in a table nothing here can write to
-- twice. That is the property that makes permanent deletion defensible at all.
--
-- ORDER OF DEMOLITION, and it is not arbitrary. secret.organization_id is ON
-- DELETE RESTRICT — deliberately, since 0060: encrypted material is not
-- something a cascade should be able to take out as a side effect. So a client
-- cannot simply be DELETEd; the material has to be removed explicitly, in an
-- order that satisfies every other RESTRICT pointing at it:
--
--   credential.secret_id          RESTRICT   credentials go before secrets
--   flexible_asset_secret.secret_id RESTRICT  (cascades from asset_node)
--   secret_version.secret_id      RESTRICT   versions go before secrets
--   unifi_site_mapping.api_key_secret_id RESTRICT
--
-- Everything else reaching organization is ON DELETE CASCADE and is left to do
-- its job.
-- =============================================================================
SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- helm.delete_organization — a client and everything documented under it.
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

  -- Out of scope reads as "no such client", exactly as a reveal does: whether a
  -- client exists in another organisation's scope is not something a refusal
  -- should confirm.
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

  -- The rail. Archived means somebody already decided this client is finished
  -- and lived with that decision for a while.
  IF v_org.archived_at IS NULL THEN
    RAISE EXCEPTION 'helm: % must be archived before it can be deleted', v_org.name
      USING ERRCODE = 'check_violation',
            DETAIL  = 'archive_first';
  END IF;

  -- Counted BEFORE the delete, because afterwards there is nothing to count and
  -- the audit row is the only remaining description of what was destroyed.
  SELECT jsonb_build_object(
    'assets',      (SELECT count(*) FROM asset_node WHERE organization_id = p_organization_id),
    'secrets',     (SELECT count(*) FROM secret     WHERE organization_id = p_organization_id),
    'sites',       (SELECT count(*) FROM site       WHERE organization_id = p_organization_id),
    'contacts',    (SELECT count(*) FROM contact    WHERE organization_id = p_organization_id),
    'notes',       (SELECT count(*) FROM note       WHERE organization_id = p_organization_id),
    'attachments', (SELECT count(*) FROM attachment WHERE organization_id = p_organization_id)
  ) INTO v_counts;

  -- Written before the row is gone. helm.audit() resolves nothing by foreign
  -- key, so the event outlives everything it names.
  PERFORM helm.audit('organization.deleted', 'organization', p_organization_id,
                     'success'::audit_outcome, p_organization_id, NULL, NULL,
                     v_counts || jsonb_build_object('name', v_org.name, 'slug', v_org.slug));

  -- 1. Asset nodes first. This cascades to every subtype — credential, device,
  --    network, certificate, licence, flexible record — and to
  --    flexible_asset_secret, which is one of the RESTRICTs on `secret`.
  DELETE FROM asset_node WHERE organization_id = p_organization_id;

  -- 2. The integration mappings, which hold an api_key_secret_id under RESTRICT.
  DELETE FROM unifi_site_mapping WHERE organization_id = p_organization_id;

  -- 3. Versions, then the secrets themselves. Nothing points at them now.
  DELETE FROM secret_version
   WHERE secret_id IN (SELECT id FROM secret WHERE organization_id = p_organization_id);
  DELETE FROM secret WHERE organization_id = p_organization_id;

  -- 4. The client. Sites, contacts, notes, attachments, expirations, favourites,
  --    recent views, search documents and the rest go with it on CASCADE.
  DELETE FROM organization WHERE id = p_organization_id;

  RETURN v_counts;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.delete_credential — one documented account and its material.
-- -----------------------------------------------------------------------------
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
      USING ERRCODE = 'check_violation',
            DETAIL  = 'archive_first';
  END IF;

  SELECT * INTO v_cred FROM credential WHERE id = p_node_id;
  v_secrets := ARRAY(SELECT s FROM unnest(ARRAY[v_cred.secret_id, v_cred.totp_secret_id]) s
                      WHERE s IS NOT NULL);

  PERFORM helm.audit('credential.deleted', 'asset_node', p_node_id,
                     'success'::audit_outcome, v_node.organization_id, p_node_id, NULL,
                     jsonb_build_object('name', v_node.name,
                                        'secret_count', coalesce(array_length(v_secrets, 1), 0)));

  -- The node, which cascades the credential row and releases the RESTRICT on
  -- secret_id.
  DELETE FROM asset_node WHERE id = p_node_id;

  /*
   * The material, but ONLY if nothing else documents it. A secret can be
   * referenced by more than one credential — that is the whole premise of
   * helm.secret_node_visible()'s bool_or — and deleting the last credential
   * pointing at a shared password must not take the password away from the
   * other one.
   *
   * ssl_certificate and license reference secrets with ON DELETE SET NULL, so
   * they do not block the delete and would be left holding a dangling
   * reference; they are counted here so they do not.
   */
  IF array_length(v_secrets, 1) > 0 THEN
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
  END IF;

  RETURN jsonb_build_object('name', v_node.name, 'secrets_removed', v_removed);
END;
$$;

REVOKE ALL ON FUNCTION helm.delete_organization(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.delete_credential(uuid)   FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.delete_organization(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.delete_credential(uuid)   TO helm_app;

COMMENT ON FUNCTION helm.delete_organization(uuid) IS
  'Permanently deletes an ARCHIVED client and everything documented under it. '
  'Requires organization:delete. The audit trail survives.';
COMMENT ON FUNCTION helm.delete_credential(uuid) IS
  'Permanently deletes an ARCHIVED credential and any secret nothing else '
  'references. Requires secret:delete. The audit trail survives.';

-- =============================================================================
-- Guards
-- =============================================================================
DO $delete_guard$
DECLARE
  v_org  text := (SELECT pg_get_functiondef('helm.delete_organization(uuid)'::regprocedure));
  v_cred text := (SELECT pg_get_functiondef('helm.delete_credential(uuid)'::regprocedure));
BEGIN
  -- 1. THE AUDIT TRAIL IS NOT REACHABLE BY A CASCADE. The entire case for
  --    permanent deletion rests on this, and it is one ALTER TABLE away from
  --    being false.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE contype = 'f' AND conrelid = 'audit_log'::regclass
      AND confrelid IN ('organization'::regclass, 'asset_node'::regclass, 'secret'::regclass)
  ) THEN
    RAISE EXCEPTION
      'helm: audit_log now has a foreign key into a deletable table; deleting a client would erase its own record';
  END IF;

  -- 2. BOTH RAILS ARE IN PLACE. Losing either turns a deliberate, two-step
  --    removal into one click on a live client.
  IF v_org !~ 'archived_at IS NULL' OR v_cred !~ 'archived_at IS NULL' THEN
    RAISE EXCEPTION 'helm: a delete function no longer requires the row to be archived first';
  END IF;
  IF v_org !~ 'organization:delete' THEN
    RAISE EXCEPTION 'helm: delete_organization no longer checks organization:delete';
  END IF;
  IF v_cred !~ 'secret:delete' THEN
    RAISE EXCEPTION 'helm: delete_credential no longer checks secret:delete';
  END IF;

  -- 3. BOTH PERMISSIONS STAY MSP-ONLY, so no co-managed customer can be granted
  --    the ability to destroy documentation by any route.
  IF EXISTS (SELECT 1 FROM permission
              WHERE key IN ('organization:delete', 'secret:delete') AND NOT msp_only) THEN
    RAISE EXCEPTION 'helm: a deletion permission is no longer msp_only';
  END IF;

  -- 4. ENCRYPTED MATERIAL STILL CANNOT BE TAKEN OUT BY A SIDE EFFECT. If this
  --    ever became CASCADE, deleting a client would silently destroy secrets
  --    without the explicit, ordered removal above.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.contype = 'f' AND t.relname = 'secret'
      AND c.confrelid = 'organization'::regclass AND c.confdeltype = 'r'
  ) THEN
    RAISE EXCEPTION 'helm: secret.organization_id is no longer ON DELETE RESTRICT';
  END IF;
END;
$delete_guard$;
