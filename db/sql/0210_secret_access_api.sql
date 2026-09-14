-- =============================================================================
-- 0210_secret_access_api.sql — the only path to ciphertext
--
-- secret_version has RLS on and no SELECT policy (0200), so no role can read it
-- directly. These SECURITY DEFINER functions are the sole doorway, and each one
-- writes its audit row in the SAME TRANSACTION as the read. There is no ordering
-- in which material is returned and the audit event is not recorded: either both
-- commit or neither does.
--
-- This is the difference between "the application logs secret access" and "the
-- database cannot hand out a secret without logging it". The first is a code
-- review promise; the second survives a new developer writing a raw query.
--
-- NOTE ON DENIALS: PostgreSQL has no autonomous transactions, so raising an
-- exception on refusal would roll back the audit row recording the refusal —
-- and a denied access attempt is precisely what an investigation needs. These
-- functions therefore RETURN a refusal (granted = false) rather than raising,
-- leaving the audit insert committed. The application turns that into an HTTP
-- 403.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- helm.reveal_secret — returns the envelope plus the wrapped DEK.
--
-- Postgres hands back an opaque blob and the identity of the key needed to open
-- it; the application asks KMS to unwrap the DEK and performs AES-256-GCM
-- decryption in process. The database never holds plaintext or an unwrapped key.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.reveal_secret(
  p_secret_id uuid,
  p_reason    text  DEFAULT NULL,
  p_purpose   text  DEFAULT 'view',
  p_version   integer DEFAULT NULL
) RETURNS TABLE (
  granted        boolean,
  denial_reason  text,
  audit_event_uid uuid,
  secret_id      uuid,
  version        integer,
  kind           secret_kind,
  algorithm      text,
  ciphertext     bytea,
  nonce          bytea,
  auth_tag       bytea,
  aad            text,
  data_key_id    uuid,
  wrapped_dek    bytea,
  kek_id         text,
  wrap_provider  text,
  wrap_context   jsonb
)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant   uuid := helm.current_tenant_id();
  v_secret   secret%ROWTYPE;
  v_version  secret_version%ROWTYPE;
  v_key      tenant_data_key%ROWTYPE;
  v_deny     text := NULL;
  v_event    uuid;
  v_target   integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'helm: no tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_purpose NOT IN ('view', 'copy', 'autofill', 'export', 'integration', 'rotation') THEN
    RAISE EXCEPTION 'helm: unknown reveal purpose %', p_purpose
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_secret FROM secret
  WHERE id = p_secret_id AND tenant_id = v_tenant AND deleted_at IS NULL;

  -- Unknown and out-of-scope are the same answer on purpose: probing for secret
  -- ids must not distinguish "no such secret" from "not yours".
  IF NOT FOUND OR NOT helm.org_in_scope(v_secret.organization_id) THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', p_secret_id, 'denied',
                          NULL, NULL, p_reason,
                          jsonb_build_object('purpose', p_purpose, 'cause', 'not_found_or_out_of_scope'));
    RETURN QUERY SELECT false, 'not_found', v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  -- Authorisation ladder, most specific refusal first.
  IF NOT helm.has_permission('secret:reveal') THEN
    v_deny := 'missing_permission';
  ELSIF helm.current_role_rank() < v_secret.min_role_rank THEN
    v_deny := 'insufficient_role_rank';
  ELSIF v_secret.requires_step_up AND NOT helm.step_up_verified() THEN
    v_deny := 'step_up_required';
  ELSIF v_secret.requires_reason AND coalesce(length(btrim(p_reason)), 0) < 10 THEN
    v_deny := 'reason_required';
  ELSIF p_purpose = 'export' AND NOT helm.has_permission('secret:export') THEN
    v_deny := 'export_not_permitted';
  ELSIF p_purpose = 'autofill' AND v_secret.sensitivity <> 'standard' THEN
    -- Elevated and critical credentials are never auto-filled into a browser.
    -- A domain admin password belongs in a deliberate, observed copy action.
    v_deny := 'autofill_not_permitted_for_sensitivity';
  END IF;

  IF v_deny IS NOT NULL THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', v_secret.id, 'denied',
                          v_secret.organization_id, v_secret.id, p_reason,
                          jsonb_build_object(
                            'purpose', p_purpose,
                            'cause', v_deny,
                            'sensitivity', v_secret.sensitivity,
                            'required_rank', v_secret.min_role_rank,
                            'actor_rank', helm.current_role_rank()));
    RETURN QUERY SELECT false, v_deny, v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  v_target := coalesce(p_version, v_secret.current_version);

  SELECT * INTO v_version FROM secret_version sv
  WHERE sv.secret_id = v_secret.id AND sv.version = v_target;

  IF NOT FOUND THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', v_secret.id, 'error',
                          v_secret.organization_id, v_secret.id, p_reason,
                          jsonb_build_object('purpose', p_purpose, 'cause', 'no_such_version',
                                             'requested_version', v_target));
    RETURN QUERY SELECT false, 'no_such_version', v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_key FROM tenant_data_key WHERE id = v_version.data_key_id;

  IF v_key.status = 'destroyed' THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', v_secret.id, 'error',
                          v_secret.organization_id, v_secret.id, p_reason,
                          jsonb_build_object('purpose', p_purpose, 'cause', 'key_destroyed',
                                             'data_key_id', v_key.id));
    RETURN QUERY SELECT false, 'key_destroyed', v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  -- Granted. The audit row and the material leave together.
  v_event := helm.audit(
    'secret.revealed', 'secret', v_secret.id, 'success',
    v_secret.organization_id, v_secret.id, p_reason,
    jsonb_build_object(
      'purpose',      p_purpose,
      'version',      v_version.version,
      'kind',         v_secret.kind,
      'sensitivity',  v_secret.sensitivity,
      'label',        v_secret.label,
      'data_key_id',  v_key.id,
      'step_up',      helm.step_up_verified()));

  UPDATE secret
  SET last_accessed_at = now(), access_count = access_count + 1
  WHERE id = v_secret.id;

  RETURN QUERY SELECT
    true, NULL::text, v_event,
    v_secret.id, v_version.version, v_secret.kind, v_version.algorithm,
    v_version.ciphertext, v_version.nonce, v_version.auth_tag, v_version.aad,
    v_key.id, v_key.wrapped_dek, v_key.kek_id, v_key.wrap_provider, v_key.wrap_context;
END;
$$;

COMMENT ON FUNCTION helm.reveal_secret(uuid, text, text, integer) IS
  'The only route to secret ciphertext. Writes the audit event in the same '
  'transaction, so material and its access record are atomically inseparable.';

-- -----------------------------------------------------------------------------
-- helm.write_secret_version — create or rotate.
--
-- Also SECURITY DEFINER, for three reasons: writes are audited on the same
-- terms as reads; the version number is allocated under a row lock so two
-- concurrent rotations cannot collide; and current_version is advanced in the
-- same transaction so a secret can never point at a version that is not there.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.write_secret_version(
  p_secret_id       uuid,
  p_data_key_id     uuid,
  p_ciphertext      bytea,
  p_nonce           bytea,
  p_auth_tag        bytea,
  p_aad             text,
  p_reuse_hmac      bytea    DEFAULT NULL,
  p_strength_score  smallint DEFAULT NULL,
  p_plaintext_length smallint DEFAULT NULL,
  p_rotation_reason text     DEFAULT NULL
) RETURNS TABLE (
  version         integer,
  audit_event_uid uuid
)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant     uuid := helm.require_tenant_id();
  v_secret     secret%ROWTYPE;
  v_next       integer;
  v_key_status data_key_status;
  v_event      uuid;
BEGIN
  -- FOR UPDATE serialises concurrent rotations of the same secret; without it
  -- two writers can compute the same "next" version and one insert fails on the
  -- unique constraint after the caller has already burned a nonce.
  SELECT * INTO v_secret FROM secret
  WHERE id = p_secret_id AND tenant_id = v_tenant AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND OR NOT helm.org_in_scope(v_secret.organization_id) THEN
    RAISE EXCEPTION 'helm: secret % not found in scope', p_secret_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT helm.has_permission('secret:write') THEN
    PERFORM helm.audit('secret.write_denied', 'secret', p_secret_id, 'denied',
                       v_secret.organization_id, p_secret_id, NULL,
                       jsonb_build_object('cause', 'missing_permission'));
    RAISE EXCEPTION 'helm: secret:write permission required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_secret.sensitivity = 'critical' AND NOT helm.step_up_verified() THEN
    PERFORM helm.audit('secret.write_denied', 'secret', p_secret_id, 'denied',
                       v_secret.organization_id, p_secret_id, NULL,
                       jsonb_build_object('cause', 'step_up_required'));
    RAISE EXCEPTION 'helm: step-up verification required to rotate a critical secret'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT status INTO v_key_status FROM tenant_data_key
  WHERE id = p_data_key_id AND tenant_id = v_tenant;

  IF v_key_status IS NULL THEN
    RAISE EXCEPTION 'helm: data key % does not belong to tenant %', p_data_key_id, v_tenant
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- New material is always written under the tenant's current active key. A
  -- retiring key can still decrypt history but must not accumulate more of it,
  -- otherwise rotation never finishes.
  IF v_key_status <> 'active' THEN
    RAISE EXCEPTION 'helm: data key % is % and cannot encrypt new material',
      p_data_key_id, v_key_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_next := v_secret.current_version + 1;

  INSERT INTO secret_version (
    tenant_id, secret_id, version, data_key_id, algorithm,
    ciphertext, nonce, auth_tag, aad,
    reuse_hmac, strength_score, plaintext_length,
    created_by, created_by_type, rotation_reason
  )
  VALUES (
    v_tenant, v_secret.id, v_next, p_data_key_id, 'AES-256-GCM',
    p_ciphertext, p_nonce, p_auth_tag, p_aad,
    p_reuse_hmac, p_strength_score, p_plaintext_length,
    helm.current_actor_id(), helm.current_actor_type()::actor_type, p_rotation_reason
  );

  UPDATE secret
  SET current_version  = v_next,
      last_rotated_at  = CASE WHEN v_next > 1 THEN now() ELSE last_rotated_at END,
      updated_by       = helm.current_actor_id(),
      updated_at       = now()
  WHERE id = v_secret.id;

  v_event := helm.audit(
    CASE WHEN v_next = 1 THEN 'secret.created' ELSE 'secret.rotated' END,
    'secret', v_secret.id, 'success',
    v_secret.organization_id, v_secret.id, p_rotation_reason,
    jsonb_build_object(
      'version', v_next,
      'kind', v_secret.kind,
      'sensitivity', v_secret.sensitivity,
      'data_key_id', p_data_key_id,
      'strength_score', p_strength_score));

  RETURN QUERY SELECT v_next, v_event;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.record_secret_copy — clipboard copies are reads too.
--
-- A technician who reveals a password on screen and one who copies it to the
-- clipboard have both taken the secret out of the system. The UI calls this for
-- the copy so the audit trail reflects it, rather than showing a single reveal
-- and no indication the value left the browser.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_secret_copy(
  p_secret_id uuid,
  p_field     text DEFAULT 'password'
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_secret secret%ROWTYPE;
BEGIN
  SELECT * INTO v_secret FROM secret
  WHERE id = p_secret_id AND tenant_id = helm.require_tenant_id();

  IF NOT FOUND OR NOT helm.org_in_scope(v_secret.organization_id) THEN
    RAISE EXCEPTION 'helm: secret % not found in scope', p_secret_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN helm.audit('secret.copied', 'secret', v_secret.id, 'success',
                    v_secret.organization_id, v_secret.id, NULL,
                    jsonb_build_object('field', p_field, 'kind', v_secret.kind));
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.resolve_autofill_candidates — the browser extension's lookup.
--
-- Matching happens here, against normalised hosts, with no wildcard semantics.
-- The extension supplies the browser-reported host and the registrable domain
-- (eTLD+1, computed from the Public Suffix List on the server side before this
-- call); it never supplies a pattern.
--
-- Returns METADATA ONLY. The extension then calls reveal_secret for the one
-- credential the technician picks, which is the moment that gets audited — so
-- merely visiting a page never counts as accessing a credential.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.resolve_autofill_candidates(
  p_host               citext,
  p_registrable_domain citext
) RETURNS TABLE (
  credential_id    uuid,
  organization_id  uuid,
  organization_name text,
  label            text,
  username         text,
  credential_type  credential_type,
  match_type       domain_match_type,
  require_confirmation boolean,
  sensitivity      secret_sensitivity,
  has_totp         boolean
)
  LANGUAGE sql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT DISTINCT ON (c.id)
    c.id,
    n.organization_id,
    o.name,
    n.name,
    c.username,
    c.credential_type,
    cd.match_type,
    cd.require_confirmation,
    coalesce(s.sensitivity, 'standard'::secret_sensitivity),
    c.totp_secret_id IS NOT NULL
  FROM credential_domain cd
  JOIN credential c  ON c.id = cd.credential_id
  JOIN asset_node n  ON n.id = c.id
  JOIN organization o ON o.id = n.organization_id
  LEFT JOIN secret s ON s.id = c.secret_id
  WHERE cd.allow_autofill
    AND n.archived_at IS NULL
    AND (
      (cd.match_type = 'exact_host'         AND cd.host = p_host)
      -- Subtree matches are anchored to a trailing-dot boundary, so
      -- "example.com" matches "mail.example.com" but never
      -- "example.com.attacker.tld".
      OR (cd.match_type = 'registrable_domain' AND cd.host = p_registrable_domain)
      OR (cd.match_type = 'subdomain_of'
          AND (p_host = cd.host OR p_host LIKE ('%.' || cd.host)))
    )
    -- Elevated and critical credentials are excluded here as well as in
    -- reveal_secret: they must not even be offered in a browser popup.
    AND coalesce(s.sensitivity, 'standard') = 'standard'
  ORDER BY c.id,
           CASE cd.match_type
             WHEN 'exact_host' THEN 1
             WHEN 'registrable_domain' THEN 2
             ELSE 3
           END;
$$;

-- -----------------------------------------------------------------------------
-- helm.find_reused_secrets — password reuse across clients.
--
-- Uses the blind index, never plaintext. Returns groups, not values.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.find_reused_secrets()
  RETURNS TABLE (
    reuse_hmac    bytea,
    occurrence_count bigint,
    secret_ids    uuid[],
    organization_ids uuid[]
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT
    sv.reuse_hmac,
    count(DISTINCT sv.secret_id),
    array_agg(DISTINCT sv.secret_id),
    array_agg(DISTINCT s.organization_id)
  FROM secret_version sv
  JOIN secret s ON s.id = sv.secret_id
  WHERE sv.tenant_id = helm.current_tenant_id()
    AND sv.reuse_hmac IS NOT NULL
    AND sv.version = s.current_version
    AND s.deleted_at IS NULL
    AND helm.has_permission('secret:audit')
    AND helm.is_tenant_wide()
  GROUP BY sv.reuse_hmac
  HAVING count(DISTINCT sv.secret_id) > 1;
$$;

REVOKE ALL ON FUNCTION helm.reveal_secret(uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.write_secret_version(uuid, uuid, bytea, bytea, bytea, text, bytea, smallint, smallint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_secret_copy(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.find_reused_secrets() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.reveal_secret(uuid, text, text, integer) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.write_secret_version(uuid, uuid, bytea, bytea, bytea, text, bytea, smallint, smallint, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.record_secret_copy(uuid, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.resolve_autofill_candidates(citext, citext) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.find_reused_secrets() TO helm_app, helm_auditor;
