-- 0760_service_account_tokens.sql — a machine identity somebody can create
--
-- service_account has existed since 0020 and the bearer path has authenticated
-- its tokens since 0270, but the only rows ever written were the built-in
-- worker identities 0290 seeds and the integration tests' raw INSERTs. 0750
-- gave a PERSON a token; automation that outlives a person — a backup script,
-- an RMM pulling credentials, a monitoring probe — should not run as whoever
-- set it up, and until now it had no choice.
--
-- THE RULES, each enforced here rather than in the route:
--
--   1. AN ADMINISTRATOR, FROM A SESSION. user:write is the permission that
--      invites a person (0350); creating an identity that acts in the tenant
--      is the same act. A request authenticated by a token cannot create an
--      account or issue a token — no chain of machine identities.
--
--   2. NOBODY GRANTS ABOVE THEIR OWN RANK. 0350's rule for memberships holds
--      here: the account's role may not outrank its creator, and a token may
--      only be issued or revoked by somebody who outranks or equals the role.
--      The built-in worker roles (system_*) are not grantable at all.
--
--   3. SCOPE STAYS INSIDE THE CREATOR'S. Tenant-wide needs a tenant-wide role
--      and a tenant-wide creator; a list of organisations must each be in the
--      creator's own scope.
--
--   4. A TOKEN NARROWS, AND IT EXPIRES. Scopes are drawn from the role's
--      permissions; `*` is the whole role. Expiry is required and at most a
--      year, as for personal tokens: automation can rotate, and a token with
--      no end is a password nobody rotates.
--
-- The built-in worker identities (is_system) are listed read-only on the
-- settings page already and get no tokens here: they run in-process as the
-- worker role and have no bearer path to need.

-- -----------------------------------------------------------------------------
-- List
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.service_accounts()
  RETURNS TABLE (
    id              uuid,
    name            text,
    description     text,
    role_key        text,
    role_name       text,
    role_rank       integer,
    org_scope_all   boolean,
    org_scope       uuid[],
    org_names       text[],
    disabled_at     timestamptz,
    created_at      timestamptz,
    created_by_name text,
    live_tokens     integer,
    last_used_at    timestamptz
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.has_permission('user:read') THEN
    RAISE EXCEPTION 'helm: user:read is required to list service accounts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT sa.id, sa.name, sa.description, sa.role_key, r.name, r.rank,
         sa.org_scope_all, sa.org_scope,
         (SELECT array_agg(o.name ORDER BY o.name)
            FROM organization o WHERE o.id = ANY (sa.org_scope)),
         sa.disabled_at, sa.created_at,
         coalesce(u.name, u.email::text),
         (SELECT count(*)::integer FROM api_token t
           WHERE t.service_account_id = sa.id AND t.revoked_at IS NULL
             AND (t.expires_at IS NULL OR t.expires_at > now())),
         (SELECT max(t.last_used_at) FROM api_token t WHERE t.service_account_id = sa.id)
  FROM service_account sa
  JOIN app_role r ON r.key = sa.role_key
  LEFT JOIN app_user u ON u.id = sa.created_by
  WHERE sa.tenant_id = v_tenant
    AND NOT sa.is_system
  ORDER BY sa.disabled_at IS NOT NULL, sa.name;
END;
$$;

-- -----------------------------------------------------------------------------
-- Roles the current actor may give a service account, with each one's
-- permissions: the scope menu a token is narrowed from.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.grantable_service_roles()
  RETURNS TABLE (
    key            text,
    name           text,
    rank           integer,
    is_tenant_wide boolean,
    permissions    text[]
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT r.key, r.name, r.rank, r.is_tenant_wide,
         coalesce((SELECT array_agg(rp.permission_key ORDER BY rp.permission_key)
                     FROM role_permission rp WHERE rp.role_key = r.key), '{}')
  FROM app_role r
  WHERE r.key NOT LIKE 'system\_%'
    AND r.rank <= helm.current_role_rank()
    -- A client-scoped actor may only create client-scoped identities.
    AND (helm.is_tenant_wide() OR NOT r.is_tenant_wide)
  ORDER BY r.rank DESC, r.name;
$$;

-- -----------------------------------------------------------------------------
-- Create
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.create_service_account(
  p_name          text,
  p_description   text,
  p_role_key      text,
  p_org_scope_all boolean,
  p_org_scope     uuid[],
  p_purposes      text[] DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
  v_name   text := btrim(coalesce(p_name, ''));
  v_role   app_role%ROWTYPE;
  v_org    uuid;
  v_id     uuid;
BEGIN
  IF v_actor IS NULL OR helm.current_actor_type() <> 'user' THEN
    RAISE EXCEPTION 'helm: only a signed-in person can create a service account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF nullif(current_setting('helm.api_token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'helm: a service account cannot be created by a request that authenticated with a token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT helm.has_permission('user:write') THEN
    RAISE EXCEPTION 'helm: user:write is required to create a service account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_name = '' OR length(v_name) > 80 THEN
    RAISE EXCEPTION 'helm: a service account needs a name of at most 80 characters';
  END IF;

  SELECT * INTO v_role FROM app_role r WHERE r.key = p_role_key;
  IF NOT FOUND OR p_role_key LIKE 'system\_%' THEN
    RAISE EXCEPTION 'helm: % is not a role a service account can hold', coalesce(p_role_key, '(none)');
  END IF;
  -- Rule 2.
  IF v_role.rank > helm.current_role_rank() THEN
    RAISE EXCEPTION 'helm: % outranks you, so you cannot give it to a service account', v_role.name
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Rule 3.
  IF p_org_scope_all THEN
    IF NOT v_role.is_tenant_wide THEN
      RAISE EXCEPTION 'helm: % is a client-scoped role and cannot hold tenant-wide scope', v_role.name;
    END IF;
    IF NOT helm.is_tenant_wide() THEN
      RAISE EXCEPTION 'helm: only a tenant-wide actor can create a tenant-wide service account'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF p_org_scope IS NULL OR cardinality(p_org_scope) = 0 THEN
      RAISE EXCEPTION 'helm: give the service account tenant-wide scope or at least one organisation';
    END IF;
    FOREACH v_org IN ARRAY p_org_scope LOOP
      IF NOT helm.org_in_scope(v_org) THEN
        RAISE EXCEPTION 'helm: organisation % is outside your own scope', v_org
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END LOOP;
  END IF;

  INSERT INTO service_account (
    tenant_id, name, description, role_key, org_scope_all, org_scope,
    allowed_reveal_purposes, created_by
  ) VALUES (
    v_tenant, v_name, nullif(btrim(coalesce(p_description, '')), ''), p_role_key,
    p_org_scope_all, CASE WHEN p_org_scope_all THEN NULL ELSE p_org_scope END,
    p_purposes, v_actor
  )
  RETURNING id INTO v_id;

  PERFORM helm.audit(
    'service_account.created', 'service_account', v_id, 'success', NULL, NULL, NULL,
    jsonb_build_object(
      'name', v_name, 'role', p_role_key,
      'orgScopeAll', p_org_scope_all, 'orgScope', to_jsonb(p_org_scope)
    )
  );
  RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- Disable / enable
--
-- Disabling is immediate for every token the account holds:
-- helm.authenticate_api_token() reports subject_disabled and the request path
-- refuses. Deleting is not offered — the audit log names the account, and a
-- name that resolves to nothing is a hole in the record.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_service_account_disabled(p_id uuid, p_disabled boolean)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_sa     service_account%ROWTYPE;
  v_rank   integer;
BEGIN
  IF NOT helm.has_permission('user:write') THEN
    RAISE EXCEPTION 'helm: user:write is required to change a service account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_sa FROM service_account s WHERE s.id = p_id AND s.tenant_id = v_tenant;
  IF NOT FOUND OR v_sa.is_system THEN
    RETURN false;
  END IF;

  SELECT r.rank INTO v_rank FROM app_role r WHERE r.key = v_sa.role_key;
  IF v_rank > helm.current_role_rank() THEN
    RAISE EXCEPTION 'helm: % holds a role that outranks you', v_sa.name
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE service_account
  SET disabled_at = CASE WHEN p_disabled THEN coalesce(disabled_at, now()) END,
      updated_at = now()
  WHERE id = p_id;

  PERFORM helm.audit(
    CASE WHEN p_disabled THEN 'service_account.disabled' ELSE 'service_account.enabled' END,
    'service_account', p_id, 'success', NULL, NULL, NULL,
    jsonb_build_object('name', v_sa.name)
  );
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- Issue a token
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.issue_service_account_token(
  p_service_account_id uuid,
  p_name          text,
  p_token_prefix  text,
  p_token_hash    bytea,
  p_scopes        text[],
  p_expires_at    timestamptz,
  p_ip_allowlist  inet[] DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
  v_name   text := btrim(coalesce(p_name, ''));
  v_sa     service_account%ROWTYPE;
  v_rank   integer;
  v_scope  text;
  v_live   integer;
  v_id     uuid;
BEGIN
  IF v_actor IS NULL OR helm.current_actor_type() <> 'user' THEN
    RAISE EXCEPTION 'helm: only a signed-in person can issue a service account token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF nullif(current_setting('helm.api_token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'helm: a token cannot be issued by a request that authenticated with a token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT helm.has_permission('user:write') THEN
    RAISE EXCEPTION 'helm: user:write is required to issue a service account token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_sa
  FROM service_account s WHERE s.id = p_service_account_id AND s.tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: no such service account' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_sa.is_system THEN
    RAISE EXCEPTION 'helm: % is a built-in worker identity and does not use tokens', v_sa.name;
  END IF;
  IF v_sa.disabled_at IS NOT NULL THEN
    RAISE EXCEPTION 'helm: % is disabled; enable it before issuing a token', v_sa.name;
  END IF;

  SELECT r.rank INTO v_rank FROM app_role r WHERE r.key = v_sa.role_key;
  IF v_rank > helm.current_role_rank() THEN
    RAISE EXCEPTION 'helm: % holds a role that outranks you', v_sa.name
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_name = '' OR length(v_name) > 80 THEN
    RAISE EXCEPTION 'helm: a token needs a name of at most 80 characters';
  END IF;
  IF p_scopes IS NULL OR cardinality(p_scopes) = 0 THEN
    RAISE EXCEPTION 'helm: a token needs at least one scope';
  END IF;
  -- Rule 4: the role's own permissions are the ceiling.
  FOREACH v_scope IN ARRAY p_scopes LOOP
    IF v_scope <> '*' AND NOT EXISTS (
      SELECT 1 FROM role_permission rp
      WHERE rp.role_key = v_sa.role_key AND rp.permission_key = v_scope
    ) THEN
      RAISE EXCEPTION 'helm: % is not a permission of the % role, so a token cannot carry it',
        v_scope, v_sa.role_key;
    END IF;
  END LOOP;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'helm: a token must expire, at a time in the future';
  END IF;
  IF p_expires_at > now() + interval '366 days' THEN
    RAISE EXCEPTION 'helm: a token may live at most a year';
  END IF;

  SELECT count(*) INTO v_live
  FROM api_token t
  WHERE t.service_account_id = v_sa.id
    AND t.revoked_at IS NULL
    AND (t.expires_at IS NULL OR t.expires_at > now());
  IF v_live >= 20 THEN
    RAISE EXCEPTION 'helm: % already holds 20 live tokens; revoke one before issuing another', v_sa.name;
  END IF;

  INSERT INTO api_token (
    tenant_id, token_type, service_account_id, name, token_prefix, token_hash,
    scopes, ip_allowlist, expires_at, created_by
  ) VALUES (
    v_tenant, 'service_account', v_sa.id, v_name, p_token_prefix, p_token_hash,
    p_scopes, CASE WHEN cardinality(p_ip_allowlist) > 0 THEN p_ip_allowlist END,
    p_expires_at, v_actor
  )
  RETURNING id INTO v_id;

  PERFORM helm.audit(
    'api_token.issued', 'api_token', v_id, 'success', NULL, NULL, NULL,
    jsonb_build_object(
      'name', v_name, 'prefix', p_token_prefix, 'scopes', to_jsonb(p_scopes),
      'expiresAt', p_expires_at,
      'ipAllowlist', to_jsonb(p_ip_allowlist),
      'subject', jsonb_build_object('type', 'service_account', 'id', v_sa.id, 'name', v_sa.name)
    )
  );
  RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- List an account's tokens
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.service_account_tokens(p_service_account_id uuid)
  RETURNS TABLE (
    id             uuid,
    name           text,
    token_prefix   text,
    scopes         text[],
    ip_allowlist   inet[],
    expires_at     timestamptz,
    revoked_at     timestamptz,
    revoked_reason text,
    last_used_at   timestamptz,
    last_used_ip   inet,
    use_count      bigint,
    created_at     timestamptz,
    created_by_name text
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.has_permission('user:read') THEN
    RAISE EXCEPTION 'helm: user:read is required to list service account tokens'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT t.id, t.name, t.token_prefix, t.scopes, t.ip_allowlist, t.expires_at,
         t.revoked_at, t.revoked_reason, t.last_used_at, t.last_used_ip, t.use_count,
         t.created_at, coalesce(u.name, u.email::text)
  FROM api_token t
  LEFT JOIN app_user u ON u.id = t.created_by
  WHERE t.service_account_id = p_service_account_id
    AND t.tenant_id = v_tenant
    AND coalesce(t.revoked_at, now()) > now() - interval '30 days'
    AND coalesce(t.expires_at, now()) > now() - interval '30 days'
  ORDER BY (t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())) DESC,
           t.created_at DESC;
END;
$$;

-- -----------------------------------------------------------------------------
-- Revoke
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.revoke_service_account_token(p_token_id uuid, p_reason text DEFAULT NULL)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_rank   integer;
  v_rows   integer;
BEGIN
  IF NOT helm.has_permission('user:write') THEN
    RAISE EXCEPTION 'helm: user:write is required to revoke a service account token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT r.rank INTO v_rank
  FROM api_token t
  JOIN service_account sa ON sa.id = t.service_account_id
  JOIN app_role r ON r.key = sa.role_key
  WHERE t.id = p_token_id AND t.tenant_id = v_tenant AND t.token_type = 'service_account';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_rank > helm.current_role_rank() THEN
    RAISE EXCEPTION 'helm: that token belongs to an account whose role outranks you'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE api_token t
  SET revoked_at = now(),
      revoked_reason = coalesce(nullif(btrim(p_reason), ''), 'revoked by an administrator')
  WHERE t.id = p_token_id AND t.revoked_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows > 0 THEN
    PERFORM helm.audit('api_token.revoked', 'api_token', p_token_id, 'success');
  END IF;
  RETURN v_rows > 0;
END;
$$;

-- -----------------------------------------------------------------------------
-- Grants. All inside a tenant context, so the application role; the
-- pre-context boundary in 0270 is untouched and its guard still counts three.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION helm.service_accounts() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.grantable_service_roles() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.create_service_account(text, text, text, boolean, uuid[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_service_account_disabled(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.issue_service_account_token(uuid, text, text, bytea, text[], timestamptz, inet[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.service_account_tokens(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.revoke_service_account_token(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.service_accounts() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.grantable_service_roles() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.create_service_account(text, text, text, boolean, uuid[], text[]) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_service_account_disabled(uuid, boolean) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.issue_service_account_token(uuid, text, text, bytea, text[], timestamptz, inet[]) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.service_account_tokens(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.revoke_service_account_token(uuid, text) TO helm_app;
