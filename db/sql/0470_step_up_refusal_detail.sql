-- =============================================================================
-- 0470 — a step-up refusal on the WRITE path says so in a way code can read
--
-- helm.write_secret_version() refuses to write material for a `critical`
-- secret unless the session has stepped up. That refusal is correct and stays
-- exactly as it was. What it could not do was TELL anybody what would fix it.
--
-- It raised a bare insufficient_privilege, which the API layer maps to a flat
-- 403 `forbidden` — the same answer a technician gets when their role is simply
-- too low. The read path has carried a distinct `step_up_required` since 0210
-- (helm.reveal_secret() returns a denial_reason column), so the reveal button
-- could prompt for a re-authentication while the create and rotate forms could
-- only say "no". Measured before changing anything:
--
--   POST /api/secrets  (sensitivity: critical)
--     → 403 {"code":"forbidden","message":"step-up verification required ..."}
--
-- A client cannot act on that without matching on the message text, which is
-- not a contract. So the raise gains a DETAIL, which postgres.js surfaces as
-- error.detail and the handler keys off structurally.
--
-- ERRCODE IS UNCHANGED, deliberately. insufficient_privilege is still correct
-- and every existing caller keeps mapping it to 403; DETAIL is additive, so a
-- reader that does not know about it behaves exactly as before. A new SQLSTATE
-- would have been a breaking change to every catch site for a refinement.
--
-- The message also loses the word "rotate": this gate fires on CREATION as
-- well, and saying "to rotate a critical secret" to somebody who was creating
-- one sent them looking for a rotation they had not attempted.
--
-- WHAT THIS DOES NOT CHANGE. The gate itself, its audit row, its cause
-- ('step_up_required', already in the metadata since 0210), and which
-- operations it covers. Note for the reader who expects otherwise: this gate
-- keys on sensitivity = 'critical', NOT on requires_step_up. A secret flagged
-- requires_step_up but left at 'standard' sensitivity cannot be READ without a
-- step-up and can be ROTATED without one. That asymmetry predates this file and
-- is left alone here; see docs/architecture/01-security-model.md §4.4.
--
-- The body below is the live pg_get_functiondef() output with one edit applied
-- mechanically. Retyping a SECURITY DEFINER function by hand is how a gate goes
-- missing in the copy.
-- =============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION helm.write_secret_version(p_secret_id uuid, p_data_key_id uuid, p_ciphertext bytea, p_nonce bytea, p_auth_tag bytea, p_aad text, p_reuse_hmac bytea DEFAULT NULL::bytea, p_strength_score smallint DEFAULT NULL::smallint, p_plaintext_length smallint DEFAULT NULL::smallint, p_rotation_reason text DEFAULT NULL::text)
 RETURNS TABLE(version integer, audit_event_uid uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'helm', 'extensions', 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_tenant     uuid := helm.require_tenant_id();
  v_secret     secret%ROWTYPE;
  v_next       integer;
  v_key_status data_key_status;
  v_event      uuid;
BEGIN
  SELECT * INTO v_secret FROM secret
  WHERE id = p_secret_id AND tenant_id = v_tenant AND deleted_at IS NULL;

  IF NOT FOUND OR NOT helm.org_in_scope(v_secret.organization_id) THEN
    PERFORM helm.audit('secret.write_denied', 'secret', p_secret_id, 'denied',
                       NULL, NULL, NULL, jsonb_build_object('cause', 'not_found_or_out_of_scope'));
    RAISE EXCEPTION 'helm: secret % not found', p_secret_id USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT helm.has_permission('secret:write') THEN
    PERFORM helm.audit('secret.write_denied', 'secret', p_secret_id, 'denied',
                       v_secret.organization_id, p_secret_id, NULL,
                       jsonb_build_object('cause', 'missing_permission'));
    RAISE EXCEPTION 'helm: secret:write is required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF helm.current_role_rank() < v_secret.min_role_rank THEN
    PERFORM helm.audit('secret.write_denied', 'secret', p_secret_id, 'denied',
                       v_secret.organization_id, p_secret_id, NULL,
                       jsonb_build_object('cause', 'insufficient_role_rank'));
    RAISE EXCEPTION 'helm: role rank % is below the % required by this secret',
      helm.current_role_rank(), v_secret.min_role_rank
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_secret.sensitivity = 'critical' AND NOT helm.step_up_verified() THEN
    PERFORM helm.audit('secret.write_denied', 'secret', p_secret_id, 'denied',
                       v_secret.organization_id, p_secret_id, NULL,
                       jsonb_build_object('cause', 'step_up_required'));
    RAISE EXCEPTION 'helm: step-up verification required to write a critical secret'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL  = 'step_up_required';
  END IF;

  SELECT status INTO v_key_status FROM tenant_data_key
  WHERE id = p_data_key_id AND tenant_id = v_tenant;

  IF v_key_status IS NULL THEN
    RAISE EXCEPTION 'helm: data key % does not belong to tenant %', p_data_key_id, v_tenant
      USING ERRCODE = 'foreign_key_violation';
  END IF;

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
      -- Denormalised so v_secret_metadata needs no read on secret_version.
      current_strength_score     = p_strength_score,
      current_plaintext_length   = p_plaintext_length,
      current_version_created_at = now(),
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
$function$

;

-- =============================================================================
-- Guards
-- =============================================================================
DO $step_up_detail_guard$
DECLARE
  v_def text := (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'helm' AND p.proname = 'write_secret_version');
BEGIN
  -- 1. THE DETAIL IS THERE. The whole point of the file; without it the API
  --    falls back to a flat 403 and the forms stop prompting, silently.
  IF v_def !~ 'DETAIL\s*=\s*''step_up_required''' THEN
    RAISE EXCEPTION 'helm: write_secret_version no longer carries the step_up_required DETAIL';
  END IF;

  -- 2. THE GATE ITSELF SURVIVED THE REWRITE. A CREATE OR REPLACE that rebuilds
  --    a SECURITY DEFINER function from a transformed copy is exactly where a
  --    check gets dropped, and the loss would be silent: critical secrets would
  --    simply start writing.
  IF v_def !~ 'sensitivity = ''critical'' AND NOT helm\.step_up_verified\(\)' THEN
    RAISE EXCEPTION 'helm: write_secret_version lost its critical step-up gate';
  END IF;

  -- 3. AND SO DID THE TWO ABOVE IT, for the same reason.
  IF v_def !~ 'has_permission\(''secret:write''\)' THEN
    RAISE EXCEPTION 'helm: write_secret_version lost its secret:write check';
  END IF;
  IF v_def !~ 'current_role_rank\(\) < v_secret\.min_role_rank' THEN
    RAISE EXCEPTION 'helm: write_secret_version lost its role rank check';
  END IF;

  -- 4. STILL SECURITY DEFINER, still search_path-pinned. Either loss turns a
  --    gate into a suggestion.
  IF NOT (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'helm' AND p.proname = 'write_secret_version') THEN
    RAISE EXCEPTION 'helm: write_secret_version is no longer SECURITY DEFINER';
  END IF;
  IF v_def !~ 'SET search_path' THEN
    RAISE EXCEPTION 'helm: write_secret_version lost its pinned search_path';
  END IF;
END;
$step_up_detail_guard$;
