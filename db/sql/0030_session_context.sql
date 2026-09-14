-- =============================================================================
-- 0030_session_context.sql — the only supported way to enter a tenant
--
-- helm.set_session_context() is SECURITY DEFINER and resolves role, rank,
-- organisation scope and permission set FROM THE DATABASE. The caller supplies
-- only an identity and request metadata; it cannot assert "I am a super admin"
-- or "my scope is every organisation". That property is what makes GUC-based
-- RLS defensible: the worst an injected `SET helm.role_rank = 100` can do is
-- claim a rank, and every policy that matters also tests helm.has_permission()
-- and, for secrets, goes through the audited SECURITY DEFINER API in 0210.
-- =============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION helm.assert_in_transaction() RETURNS void
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_xact_start timestamptz;
  v_query_start timestamptz;
BEGIN
  SELECT xact_start, query_start INTO v_xact_start, v_query_start
  FROM pg_stat_activity WHERE pid = pg_backend_pid();

  -- In an explicit transaction, BEGIN stamps xact_start strictly before this
  -- statement's query_start. In an implicit single-statement transaction the
  -- two are identical.
  IF v_xact_start IS NULL OR v_xact_start >= v_query_start THEN
    RAISE EXCEPTION 'helm: session context must be established inside an explicit transaction'
      USING ERRCODE = 'invalid_transaction_state',
            HINT = 'SET LOCAL only survives to COMMIT. Outside a transaction the '
                   'context would evaporate after this statement, and under a '
                   'transaction-pooling proxy it could leak to another tenant.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION helm.set_session_context(
  p_tenant_id         uuid,
  p_actor_id          uuid,
  p_actor_type        actor_type DEFAULT 'user',
  p_request_id        text       DEFAULT NULL,
  p_ip                inet       DEFAULT NULL,
  p_user_agent        text       DEFAULT NULL,
  p_api_token_id      uuid       DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_membership     membership%ROWTYPE;
  v_service        service_account%ROWTYPE;
  v_role_key       text;
  v_role_rank      integer;
  v_role_wide      boolean;
  v_scope_all      boolean;
  v_scope          uuid[];
  v_scope_setting  text;
  v_permissions    text[];
  v_token_scopes   text[];
  v_step_up        boolean := false;
  v_require_step_up boolean := true;
  v_actor_label    text;
  v_tenant_status  tenant_status;
BEGIN
  PERFORM helm.assert_in_transaction();

  SELECT status INTO v_tenant_status FROM tenant WHERE id = p_tenant_id;
  IF v_tenant_status IS NULL THEN
    RAISE EXCEPTION 'helm: unknown tenant %', p_tenant_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_tenant_status <> 'active' THEN
    RAISE EXCEPTION 'helm: tenant % is %', p_tenant_id, v_tenant_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_actor_type = 'user' THEN
    SELECT m.* INTO v_membership
    FROM membership m
    JOIN app_user u ON u.id = m.user_id
    WHERE m.tenant_id = p_tenant_id
      AND m.user_id = p_actor_id
      AND m.status = 'active'
      AND m.revoked_at IS NULL
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND u.disabled_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'helm: user % has no active membership in tenant %',
        p_actor_id, p_tenant_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    v_role_key        := v_membership.role_key;
    v_scope_all       := v_membership.org_scope_all;
    v_scope           := v_membership.org_scope;
    v_require_step_up := v_membership.require_step_up;

    SELECT coalesce(array_agg(DISTINCT perm), '{}')
      INTO v_permissions
    FROM (
      SELECT rp.permission_key AS perm
      FROM role_permission rp
      WHERE rp.role_key = v_role_key
      UNION
      SELECT mp.permission_key
      FROM membership_permission mp
      WHERE mp.membership_id = v_membership.id
        AND mp.granted
        AND (mp.expires_at IS NULL OR mp.expires_at > now())
      EXCEPT
      SELECT mp.permission_key
      FROM membership_permission mp
      WHERE mp.membership_id = v_membership.id
        AND NOT mp.granted
        AND (mp.expires_at IS NULL OR mp.expires_at > now())
    ) resolved;

    SELECT coalesce(u.name, u.email::text) INTO v_actor_label
    FROM app_user u WHERE u.id = p_actor_id;

    SELECT EXISTS (
      SELECT 1 FROM step_up_verification s
      WHERE s.user_id = p_actor_id
        AND s.tenant_id = p_tenant_id
        AND s.expires_at > now()
    ) INTO v_step_up;

  ELSIF p_actor_type = 'service_account' THEN
    SELECT s.* INTO v_service
    FROM service_account s
    WHERE s.id = p_actor_id
      AND s.tenant_id = p_tenant_id
      AND s.disabled_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'helm: unknown or disabled service account % in tenant %',
        p_actor_id, p_tenant_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    v_role_key  := v_service.role_key;
    v_scope_all := v_service.org_scope_all;
    v_scope     := v_service.org_scope;
    v_actor_label := v_service.name;
    -- Machine accounts cannot perform an interactive step-up, so they never
    -- satisfy it. Secrets that require step-up are unreachable to automation
    -- by construction.
    v_step_up := false;

    SELECT coalesce(array_agg(rp.permission_key), '{}')
      INTO v_permissions
    FROM role_permission rp WHERE rp.role_key = v_role_key;

    -- A token may only narrow what its service account can already do.
    IF p_api_token_id IS NOT NULL THEN
      SELECT t.scopes INTO v_token_scopes
      FROM api_token t
      WHERE t.id = p_api_token_id
        AND t.tenant_id = p_tenant_id
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now());

      IF NOT FOUND THEN
        RAISE EXCEPTION 'helm: api token % is unknown, revoked or expired', p_api_token_id
          USING ERRCODE = 'insufficient_privilege';
      END IF;

      IF NOT ('*' = ANY (v_token_scopes)) THEN
        SELECT coalesce(array_agg(p), '{}') INTO v_permissions
        FROM unnest(v_permissions) AS p
        WHERE p = ANY (v_token_scopes);
      END IF;
    END IF;

  ELSE
    RAISE EXCEPTION 'helm: actor type % cannot open a session context', p_actor_type
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT r.rank, r.is_tenant_wide INTO v_role_rank, v_role_wide
  FROM app_role r WHERE r.key = v_role_key;

  -- A client-side role can never hold a tenant-wide scope, whatever the
  -- membership row claims. Belt and braces against a bad admin UI write.
  IF v_scope_all AND NOT v_role_wide THEN
    RAISE EXCEPTION 'helm: role % is client-scoped and may not hold tenant-wide scope', v_role_key
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_scope_setting := CASE
    WHEN v_scope_all THEN '*'
    ELSE array_to_string(v_scope, ',')
  END;

  PERFORM set_config('helm.tenant_id',   p_tenant_id::text, true);
  PERFORM set_config('helm.actor_id',    p_actor_id::text, true);
  PERFORM set_config('helm.actor_type',  p_actor_type::text, true);
  PERFORM set_config('helm.actor_label', coalesce(v_actor_label, ''), true);
  PERFORM set_config('helm.role_key',    v_role_key, true);
  PERFORM set_config('helm.role_rank',   v_role_rank::text, true);
  PERFORM set_config('helm.org_scope',   v_scope_setting, true);
  PERFORM set_config('helm.permissions', array_to_string(v_permissions, ','), true);
  PERFORM set_config('helm.step_up_verified', CASE WHEN v_step_up THEN 'on' ELSE 'off' END, true);
  PERFORM set_config('helm.request_id',  coalesce(p_request_id, ''), true);
  PERFORM set_config('helm.ip',          coalesce(p_ip::text, ''), true);
  PERFORM set_config('helm.user_agent',  coalesce(p_user_agent, ''), true);
  PERFORM set_config('helm.api_token_id', coalesce(p_api_token_id::text, ''), true);

  RETURN jsonb_build_object(
    'tenant_id',   p_tenant_id,
    'actor_id',    p_actor_id,
    'actor_type',  p_actor_type,
    'actor_label', v_actor_label,
    'role_key',    v_role_key,
    'role_rank',   v_role_rank,
    'org_scope',   v_scope_setting,
    'permissions', to_jsonb(v_permissions),
    'step_up_verified', v_step_up,
    'require_step_up',  v_require_step_up
  );
END;
$$;

COMMENT ON FUNCTION helm.set_session_context(uuid, uuid, actor_type, text, inet, text, uuid) IS
  'Opens a tenant-scoped transaction. Authority is derived from membership / '
  'service_account rows, never from caller-supplied claims.';

-- Pool hygiene: called on connection release so a recycled backend cannot carry
-- one tenant''s context into another tenant''s request if a BEGIN is ever missed.
CREATE OR REPLACE FUNCTION helm.clear_session_context() RETURNS void
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_key text;
BEGIN
  FOREACH v_key IN ARRAY ARRAY[
    'helm.tenant_id', 'helm.actor_id', 'helm.actor_type', 'helm.actor_label',
    'helm.role_key', 'helm.role_rank', 'helm.org_scope', 'helm.permissions',
    'helm.step_up_verified', 'helm.request_id', 'helm.ip', 'helm.user_agent',
    'helm.api_token_id'
  ] LOOP
    PERFORM set_config(v_key, '', false);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION helm.set_session_context(uuid, uuid, actor_type, text, inet, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.set_session_context(uuid, uuid, actor_type, text, inet, text, uuid)
  TO helm_app, helm_auditor;
GRANT EXECUTE ON FUNCTION helm.clear_session_context() TO helm_app, helm_auditor;
GRANT EXECUTE ON FUNCTION helm.assert_in_transaction() TO helm_app, helm_auditor;
