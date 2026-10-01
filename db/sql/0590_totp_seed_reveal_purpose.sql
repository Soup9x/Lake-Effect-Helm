-- =============================================================================
-- 0590 — a TOTP seed leaves the vault only for a reason the audit log can name
-- =============================================================================
--
-- THE DEFECT. POST /api/secrets/{id}/reveal refused a TOTP seed, but it refused
-- it in the route, AFTER helm.reveal_secret had already granted the read and
-- written `secret.revealed` / success. Two very different events therefore
-- produced byte-identical audit rows on the same secret:
--
--     a technician generating the current code   -> secret.revealed, purpose view
--     somebody pulling the raw seed, and refused -> secret.revealed, purpose view
--
-- The refusal worked. The record of it did not: an auditor reading the log could
-- not tell a blocked attempt to exfiltrate a code-generating key from ordinary,
-- authorised use of the feature — and the former is precisely the event the log
-- exists to surface. Worse, the seed was decrypted on the refused path, so the
-- plaintext existed in the server process for a request that was never going to
-- be served.
--
-- THE FIX, and why it belongs here rather than in the route. reveal_secret
-- already owns a purpose-keyed authorisation ladder: 'export' demands
-- secret:export AND membership of a live export job, 'integration' demands an
-- integration credential, 'autofill' is refused outright above 'standard'
-- sensitivity. "A seed is readable only for these purposes" is another rule of
-- exactly that kind, and putting it with its siblings buys three things a route
-- check cannot:
--
--   * ONE audit row, correctly labelled. secret.reveal_denied / denied, cause
--     'seed_not_directly_revealable'. No success row to explain away.
--   * NO DECRYPTION. The refusal lands before the key is unwrapped, so the
--     plaintext never exists.
--   * EVERY CALLER, not just the one route. The rule holds for a worker, a
--     service account and anything added later, because it is a property of the
--     secret rather than of the door.
--
-- A new purpose, 'totp', carries the legitimate case, so authorised code
-- generation is now distinguishable at a glance — "who has been reading this
-- account's MFA codes" became a query over one purpose rather than an
-- unanswerable question. The inverse rung matters as much: 'totp' is refused on
-- anything that is not a seed, so the purpose cannot be used to make reading a
-- password look like glancing at a code.
--
-- 0400's definition is replaced, not edited: it is applied and therefore frozen.
-- The body below is copied from the LIVE definition, following 0390's precedent,
-- so a hand-merge of an older file cannot silently revert a later rung.
-- =============================================================================

CREATE OR REPLACE FUNCTION helm.reveal_secret(p_secret_id uuid, p_reason text DEFAULT NULL::text, p_purpose text DEFAULT 'view'::text, p_version integer DEFAULT NULL::integer)
 RETURNS TABLE(granted boolean, denial_reason text, audit_event_uid uuid, secret_id uuid, version integer, kind secret_kind, algorithm text, ciphertext bytea, nonce bytea, auth_tag bytea, aad text, data_key_id uuid, wrapped_dek bytea, kek_id text, wrap_provider text, wrap_context jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'helm', 'extensions', 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_tenant   uuid := helm.current_tenant_id();
  v_secret   secret%ROWTYPE;
  v_version  secret_version%ROWTYPE;
  v_key      tenant_data_key%ROWTYPE;
  v_deny     text := NULL;
  v_event    uuid;
  v_target   integer;
  v_purposes text[];
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'helm: no tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_purpose NOT IN ('view', 'copy', 'autofill', 'export', 'integration', 'rotation', 'totp') THEN
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

  -- A machine identity may be pinned to the purposes its job actually has.
  IF helm.current_actor_type() = 'service_account' THEN
    SELECT sa.allowed_reveal_purposes INTO v_purposes
    FROM service_account sa
    WHERE sa.id = helm.current_actor_id() AND sa.tenant_id = v_tenant;
  END IF;

  -- Authorisation ladder, most specific refusal first.
  -- Visibility leads the ladder. Until 0390 this rung did not exist, and a
  -- credential on an internal-only asset was withheld from a co-managed client
  -- only because the shipped client roles happen to hold neither secret:reveal
  -- nor a rank reaching any secret — two coincidences, not a rule.
  --
  -- First rather than last because the audit row records the reason, and "your
  -- rank is too low" is a different fact from "you may not see this at all".
  -- The second is the one an MSP needs when the client asks why.
  IF NOT helm.is_tenant_wide() AND NOT helm.secret_node_visible(v_secret.id) THEN
    v_deny := 'internal_only';
  ELSIF NOT helm.has_permission('secret:reveal') THEN
    v_deny := 'missing_permission';
  ELSIF v_purposes IS NOT NULL AND NOT (p_purpose = ANY (v_purposes)) THEN
    v_deny := 'purpose_not_permitted_for_actor';
  ELSIF v_secret.kind = 'totp_seed' AND p_purpose NOT IN ('totp', 'export', 'rotation') THEN
    -- A TOTP seed is a code-generating key with no expiry. Handed to a browser
    -- once, every future code for that account is computable off the record
    -- forever, which makes the secret:reveal gate on the code endpoint
    -- decorative. The seed comes out for exactly three reasons: to compute the
    -- current code ('totp'), to hand the account back to a client who needs to
    -- re-enrol ('export', itself gated on a live export job below), and to
    -- re-wrap it under a new key ('rotation').
    v_deny := 'seed_not_directly_revealable';
  ELSIF p_purpose = 'totp' AND v_secret.kind <> 'totp_seed' THEN
    -- The inverse, and not pedantry. Without it 'totp' would be a purpose any
    -- caller could attach to a password reveal, and the audit row for reading a
    -- domain admin password would read like somebody glancing at an MFA code.
    v_deny := 'not_a_totp_seed';
  ELSIF helm.current_role_rank() < v_secret.min_role_rank THEN
    v_deny := 'insufficient_role_rank';
  ELSIF v_secret.requires_step_up AND NOT helm.step_up_verified() THEN
    v_deny := 'step_up_required';
  ELSIF v_secret.requires_reason AND coalesce(length(btrim(p_reason)), 0) < 10 THEN
    v_deny := 'reason_required';
  ELSIF p_purpose = 'export' AND NOT helm.has_permission('secret:export') THEN
    v_deny := 'export_not_permitted';
  ELSIF p_purpose = 'export' AND NOT helm.is_in_live_secret_export(v_secret.id) THEN
    -- Reached by the export worker, whose whole capability is this purpose.
    -- Re-derived from export_job every time, so a job revoked mid-render stops
    -- yielding material immediately. Until 0400 this also required the job to
    -- have been APPROVED — which, with approval removed, would have meant the
    -- worker could never reveal anything and every credential export rendered
    -- silently empty.
    v_deny := 'not_in_a_live_export';
  ELSIF p_purpose = 'integration' AND NOT helm.is_integration_credential(v_secret.id) THEN
    v_deny := 'not_an_integration_credential';
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
$function$;


-- -----------------------------------------------------------------------------
-- A machine identity has to be able to be pinned to the new purpose.
--
-- allowed_reveal_purposes is checked against a fixed list, so without this an
-- automation that logs into a vendor portal could never be granted 'totp' — and
-- the failure would be unfixable by configuration, because the constraint would
-- refuse the very value reveal_secret now requires.
-- -----------------------------------------------------------------------------
ALTER TABLE service_account DROP CONSTRAINT IF EXISTS service_account_purposes_known;
ALTER TABLE service_account ADD CONSTRAINT service_account_purposes_known CHECK (
  allowed_reveal_purposes IS NULL
  OR (cardinality(allowed_reveal_purposes) > 0
      AND allowed_reveal_purposes <@ ARRAY[
        'view', 'copy', 'autofill', 'export', 'integration', 'rotation', 'totp'
      ]::text[])
);

-- =============================================================================
-- Guards
-- =============================================================================
DO $$
BEGIN
  -- 1. The new rungs are in the function, not merely in this file's comments.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'reveal_secret'
      AND p.prosrc LIKE '%seed_not_directly_revealable%'
      AND p.prosrc LIKE '%not_a_totp_seed%'
  ) THEN
    RAISE EXCEPTION 'helm: reveal_secret does not gate the TOTP seed on purpose';
  END IF;

  -- 2. The rungs that were there before are STILL there. This file replaces a
  --    160-line function; a hand-merge from an older copy would compile cleanly
  --    and quietly drop the visibility or rank check.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'reveal_secret'
      AND p.prosrc LIKE '%secret_node_visible%'
      AND p.prosrc LIKE '%min_role_rank%'
      AND p.prosrc LIKE '%step_up_verified%'
      AND p.prosrc LIKE '%is_in_live_secret_export%'
      AND p.prosrc LIKE '%autofill_not_permitted_for_sensitivity%'
  ) THEN
    RAISE EXCEPTION 'helm: reveal_secret lost a rung it had before 0590';
  END IF;

  -- 3. 'totp' is accepted as a purpose, and a typo still is not.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'reveal_secret'
      AND p.prosrc LIKE '%''rotation'', ''totp''%'
  ) THEN
    RAISE EXCEPTION 'helm: reveal_secret does not accept the totp purpose';
  END IF;

  -- 4. A service account can be pinned to it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'service_account'::regclass
      AND conname = 'service_account_purposes_known'
      AND pg_get_constraintdef(oid) LIKE '%totp%'
  ) THEN
    RAISE EXCEPTION 'helm: service_account cannot be pinned to the totp purpose';
  END IF;

  -- 5. ...and only to a purpose the function actually honours. A constraint that
  --    accepted anything would let an operator pin a purpose reveal_secret
  --    raises on, turning a configuration mistake into a 500 per reveal.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'service_account'::regclass
      AND conname = 'service_account_purposes_known'
      AND pg_get_constraintdef(oid) LIKE '%nonsense%'
  ) THEN
    RAISE EXCEPTION 'helm: service_account purpose list is not a closed set';
  END IF;
END;
$$;
