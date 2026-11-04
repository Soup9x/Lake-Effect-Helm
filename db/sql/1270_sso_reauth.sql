-- =============================================================================
-- 1270 — Confirm it is you with your identity provider (sso_reauth)
-- =============================================================================
--
-- Every "type your password again" prompt in Helm — a step-up before a
-- protected credential, leaving Field view for the full site, Update now /
-- Schedule, pairing the browser extension — accepted only the local Helm
-- password. A person invited for single sign-on has none, so each of those was
-- a dead end for them.
--
-- step_up_verification.method has permitted 'sso_reauth' since 0020. This
-- migration gives it a writer and a one-shot reader:
--
--   helm.record_sso_reauth(ticket)   The callback, after the identity provider
--                                    re-authenticated the person (prompt=login)
--                                    and the id_token's subject matched the
--                                    account linked to this session. Writes an
--                                    ordinary step-up row, so a protected reveal
--                                    is satisfied exactly as by the password,
--                                    tagged with the browser's ticket.
--
--   helm.sso_reauth_done(ticket)     The waiting dialog's poll: has it landed?
--
--   helm.consume_sso_reauth(ticket)  The one-shot actions (field upgrade,
--                                    update request, extension pairing). A
--                                    ticket counts once, and only within five
--                                    minutes of the sign-in it records, so one
--                                    Microsoft confirmation cannot be replayed
--                                    into a second pairing or a second update.
--
-- All three read the actor and tenant from the session context, never from an
-- argument: a ticket is useless to anybody but the session that earned it.
-- =============================================================================

SET search_path = public, extensions;

ALTER TABLE step_up_verification ADD COLUMN consumed_at timestamptz;

COMMENT ON COLUMN step_up_verification.consumed_at IS
  'An sso_reauth verification used by a one-shot action (1270). The step-up '
  'window itself is unaffected: a consumed row still satisfies a protected reveal '
  'until expires_at.';

-- The table forces row security and had no UPDATE policy, so the definer
-- below (not a BYPASSRLS role) could not mark a row. The policy admits only the
-- actor's own rows; helm_app loses the UPDATE verb itself, so the function is
-- the only way a row changes — nobody can stretch an expires_at by hand.
CREATE POLICY step_up_rls_update ON step_up_verification FOR UPDATE
  USING (tenant_id = helm.current_tenant_id() AND user_id = helm.current_actor_id())
  WITH CHECK (tenant_id = helm.current_tenant_id() AND user_id = helm.current_actor_id());
REVOKE UPDATE, DELETE ON step_up_verification FROM helm_app;

-- request_id carries 'sso:<ticket>' for these rows; looked up by it.
CREATE UNIQUE INDEX step_up_sso_ticket_uk ON step_up_verification (request_id)
  WHERE method = 'sso_reauth';

CREATE OR REPLACE FUNCTION helm.record_sso_reauth(
  p_ticket      text,
  p_ttl_minutes integer DEFAULT 15,
  p_ip          inet DEFAULT NULL
) RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_actor   uuid := helm.current_actor_id();
  v_expires timestamptz;
BEGIN
  IF helm.current_actor_type() <> 'user' THEN
    RAISE EXCEPTION 'helm: only a person may complete a step-up verification'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_ticket IS NULL OR p_ticket !~ '^[A-Za-z0-9-]{16,64}$' THEN
    RAISE EXCEPTION 'helm: malformed re-authentication ticket'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_expires := now() + make_interval(mins => least(greatest(p_ttl_minutes, 1), 60));

  INSERT INTO step_up_verification (tenant_id, user_id, method, expires_at, ip, request_id)
  VALUES (v_tenant, v_actor, 'sso_reauth', v_expires, p_ip, 'sso:' || p_ticket);

  PERFORM helm.audit('auth.step_up_verified', 'app_user', v_actor,
                     'success'::audit_outcome,
                     NULL, NULL, NULL, jsonb_build_object('method', 'sso_reauth'));

  RETURN v_expires;
END;
$$;

CREATE OR REPLACE FUNCTION helm.sso_reauth_done(p_ticket text)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM step_up_verification
    WHERE method = 'sso_reauth'
      AND request_id = 'sso:' || p_ticket
      AND user_id = helm.current_actor_id()
      AND tenant_id = helm.require_tenant_id()
  );
$$;

CREATE OR REPLACE FUNCTION helm.consume_sso_reauth(p_ticket text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF helm.current_actor_type() <> 'user' THEN
    RETURN false;
  END IF;

  UPDATE step_up_verification
     SET consumed_at = now()
   WHERE method = 'sso_reauth'
     AND request_id = 'sso:' || p_ticket
     AND user_id = helm.current_actor_id()
     AND tenant_id = helm.require_tenant_id()
     AND consumed_at IS NULL
     AND verified_at > now() - interval '5 minutes'
  RETURNING id INTO v_id;

  RETURN v_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION helm.record_sso_reauth(text, integer, inet) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.sso_reauth_done(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.consume_sso_reauth(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.record_sso_reauth(text, integer, inet) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.sso_reauth_done(text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.consume_sso_reauth(text) TO helm_app;
