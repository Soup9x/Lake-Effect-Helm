-- 0750_personal_api_tokens.sql — a token somebody can actually issue
--
-- api_token has existed since 0020, helm.authenticate_api_token() since 0270,
-- and the request path has verified bearer tokens, applied scope narrowing and
-- IP allow-lists for as long. What never existed was a way to CREATE one from
-- the product: no route, no screen, no function. The only rows ever written
-- were the integration tests' raw INSERTs. The consumers the design named — a
-- generic RMM/PSA sync and a browser extension — were removed or never built,
-- so the bearer path was complete and unreachable.
--
-- This is the smallest honest version of the feature: a PERSONAL token, bound
-- to the person who issued it, carrying a subset of what they can already do.
-- Service-account tokens, which need an administrator screen for service
-- accounts first, are not here.
--
-- THREE RULES, each enforced here rather than in the route, because the route
-- is one caller and the next one would have to remember them:
--
--   1. ONLY A PERSON, FROM A SESSION. A request that authenticated with a token
--      cannot mint another: that would turn a leaked 30-day token into an
--      unbounded chain of them. helm.api_token_id is set in the session context
--      exactly when a token authenticated the request.
--
--   2. A TOKEN NARROWS, IT NEVER WIDENS. Every scope must be a permission the
--      issuer holds right now, checked against the context the database
--      resolved — not against a list the route sent. `*` means "everything my
--      role allows", which set_session_context() already honours.
--
--   3. IT EXPIRES. At most a year, no exception: a personal token with no end
--      is a password that never rotates, and the person who issued it will have
--      forgotten it exists long before anybody finds it in a shell history.
--
-- Twenty live tokens per person per tenant is a cap on carelessness, not a
-- quota. Revocation is immediate: 0030 re-reads revoked_at on every request.

-- -----------------------------------------------------------------------------
-- Issue
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.issue_my_api_token(
  p_name         text,
  p_token_prefix text,
  p_token_hash   bytea,
  p_scopes       text[],
  p_expires_at   timestamptz
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_actor  uuid := helm.current_actor_id();
  v_tenant uuid := helm.require_tenant_id();
  v_name   text := btrim(coalesce(p_name, ''));
  v_scope  text;
  v_live   integer;
  v_id     uuid;
BEGIN
  IF v_actor IS NULL OR helm.current_actor_type() <> 'user' THEN
    RAISE EXCEPTION 'helm: only a signed-in person can issue a personal token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Rule 1. The context carries the token that authenticated this request, if
  -- one did; a session-authenticated request carries none.
  IF nullif(current_setting('helm.api_token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'helm: a personal token cannot be issued by a request that authenticated with a token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_name = '' OR length(v_name) > 80 THEN
    RAISE EXCEPTION 'helm: a token needs a name of at most 80 characters';
  END IF;

  IF p_scopes IS NULL OR cardinality(p_scopes) = 0 THEN
    RAISE EXCEPTION 'helm: a token needs at least one scope';
  END IF;

  -- Rule 2.
  FOREACH v_scope IN ARRAY p_scopes LOOP
    IF v_scope <> '*' AND NOT helm.has_permission(v_scope) THEN
      RAISE EXCEPTION 'helm: % is not a permission you hold, so a token cannot carry it', v_scope;
    END IF;
  END LOOP;

  -- Rule 3.
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'helm: a personal token must expire, at a time in the future';
  END IF;
  IF p_expires_at > now() + interval '366 days' THEN
    RAISE EXCEPTION 'helm: a personal token may live at most a year';
  END IF;

  SELECT count(*) INTO v_live
  FROM api_token t
  WHERE t.user_id = v_actor
    AND t.tenant_id = v_tenant
    AND t.revoked_at IS NULL
    AND (t.expires_at IS NULL OR t.expires_at > now());
  IF v_live >= 20 THEN
    RAISE EXCEPTION 'helm: you already hold 20 live tokens; revoke one before issuing another';
  END IF;

  INSERT INTO api_token (
    tenant_id, token_type, user_id, name, token_prefix, token_hash, scopes, expires_at, created_by
  ) VALUES (
    v_tenant, 'user_pat', v_actor, v_name, p_token_prefix, p_token_hash, p_scopes, p_expires_at, v_actor
  )
  RETURNING id INTO v_id;

  -- The prefix is the token's public name — what a leak is reported by — and
  -- the scopes are what a reviewer wants to know. The hash is not here: an
  -- audit row is read by more people than the token table is.
  PERFORM helm.audit(
    'api_token.issued', 'api_token', v_id, 'success', NULL, NULL, NULL,
    jsonb_build_object(
      'name', v_name,
      'prefix', p_token_prefix,
      'scopes', to_jsonb(p_scopes),
      'expiresAt', p_expires_at
    )
  );

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION helm.issue_my_api_token(text, text, bytea, text[], timestamptz) IS
  'Issue a personal API token for the current actor: a person, from a session, '
  'with scopes drawn from what they hold now, expiring within a year. Audited.';

-- -----------------------------------------------------------------------------
-- List
--
-- SECURITY DEFINER because api_token''s read policy is tenant-wide-only: a
-- client-scoped person could not see their own rows through RLS, and the row
-- being theirs is the whole predicate here. Nothing secret is returned — the
-- hash is not selected, and the prefix is designed to be shown.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.my_api_tokens()
  RETURNS TABLE (
    id             uuid,
    name           text,
    token_prefix   text,
    scopes         text[],
    expires_at     timestamptz,
    revoked_at     timestamptz,
    revoked_reason text,
    last_used_at   timestamptz,
    last_used_ip   inet,
    use_count      bigint,
    created_at     timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT t.id, t.name, t.token_prefix, t.scopes, t.expires_at, t.revoked_at, t.revoked_reason,
         t.last_used_at, t.last_used_ip, t.use_count, t.created_at
  FROM api_token t
  WHERE t.user_id = helm.current_actor_id()
    AND t.tenant_id = helm.current_tenant_id()
    AND t.token_type = 'user_pat'
    -- Revoked and expired rows stay visible for a month, so "I revoked it
    -- yesterday, did it take" has an answer on the page, then drop off.
    AND coalesce(t.revoked_at, now()) > now() - interval '30 days'
    AND coalesce(t.expires_at, now()) > now() - interval '30 days'
  ORDER BY (t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())) DESC,
           t.created_at DESC;
$$;

-- -----------------------------------------------------------------------------
-- Revoke
--
-- `user_id = current actor` is the whole security property, as with
-- revoke_my_session: an id belonging to somebody else matches no row, whatever
-- the caller believes it names, and the route answers "no such token" either
-- way.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.revoke_my_api_token(p_id uuid, p_reason text DEFAULT NULL)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := helm.current_actor_id();
  v_rows  integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'helm: no actor in context' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE api_token t
  SET revoked_at = now(),
      revoked_reason = coalesce(nullif(btrim(p_reason), ''), 'revoked by its owner')
  WHERE t.id = p_id
    AND t.user_id = v_actor
    AND t.tenant_id = helm.current_tenant_id()
    AND t.revoked_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows > 0 THEN
    PERFORM helm.audit('api_token.revoked', 'api_token', p_id, 'success');
  END IF;
  RETURN v_rows > 0;
END;
$$;

COMMENT ON FUNCTION helm.revoke_my_api_token(uuid, text) IS
  'Revoke one of the current actor''s own personal tokens. False when the id '
  'is not theirs or already revoked; the two are indistinguishable on purpose.';

-- -----------------------------------------------------------------------------
-- Grants. Writing and reading a token is an act inside a tenant context, so it
-- belongs to the application role; the pre-context authentication boundary in
-- 0270 is untouched and its guard still counts three.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION helm.issue_my_api_token(text, text, bytea, text[], timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.my_api_tokens() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.revoke_my_api_token(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.issue_my_api_token(text, text, bytea, text[], timestamptz) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.my_api_tokens() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.revoke_my_api_token(uuid, text) TO helm_app;

-- -----------------------------------------------------------------------------
-- Scope narrowing applies to a person's token too.
--
-- 0030 read a token's scopes only inside the service-account branch. With
-- personal tokens that is the difference between "narrowed to organization:read"
-- and "everything tier1 can do", so the block moves out of the branch, gains a
-- check that the token belongs to the actor the context is being opened for,
-- and clears step-up for any token-authenticated request. The function is
-- otherwise 0030's, line for line; the grant from 0220 is preserved by CREATE
-- OR REPLACE.
-- -----------------------------------------------------------------------------
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

  ELSE
    RAISE EXCEPTION 'helm: actor type % cannot open a session context', p_actor_type
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A token may only narrow what its subject can already do — and since 0750
  -- the subject may be a person as well as a service account, so this runs for
  -- both. It used to sit inside the service-account branch, which meant a
  -- personal token's scopes were read and then ignored: the token carried the
  -- whole role, whatever it had been issued with.
  --
  -- The subject check is the second half of the rule. A token row names
  -- exactly one subject (api_token_one_subject); a context opened for a
  -- different actor with that token id is a bug in the caller, and the answer
  -- is a refusal, not the other subject's permissions.
  IF p_api_token_id IS NOT NULL THEN
    SELECT t.scopes INTO v_token_scopes
    FROM api_token t
    WHERE t.id = p_api_token_id
      AND t.tenant_id = p_tenant_id
      AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > now())
      AND CASE p_actor_type
            WHEN 'user'            THEN t.user_id = p_actor_id
            WHEN 'service_account' THEN t.service_account_id = p_actor_id
            ELSE false
          END;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'helm: api token % is unknown, revoked, expired or not this actor''s', p_api_token_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT ('*' = ANY (v_token_scopes)) THEN
      SELECT coalesce(array_agg(p), '{}') INTO v_permissions
      FROM unnest(v_permissions) AS p
      WHERE p = ANY (v_token_scopes);
    END IF;

    -- A machine or a script cannot answer a re-authentication prompt, so a
    -- token never satisfies a step-up — even when its person has one open in
    -- a browser. Secrets that require step-up stay unreachable to automation.
    v_step_up := false;
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
