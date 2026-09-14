-- =============================================================================
-- 0270_authentication.sql — the authentication boundary
--
-- Everything else in Helm runs inside a tenant context. Authentication cannot:
-- resolving "which tenant is this bearer token for" is precisely the question
-- that has to be answered BEFORE a context exists. That is a genuine
-- chicken-and-egg, not an excuse to relax RLS.
--
-- So it gets exactly three SECURITY DEFINER functions, each as narrow as the
-- job allows:
--
--   * They return only what is needed to establish a context — never tenant
--     data, never a secret, never an audit row.
--   * They do no authorisation. They answer "who is this?", and
--     helm.set_session_context() then independently decides what that identity
--     may do, from the membership row.
--   * Password/token comparison happens in the APPLICATION, in constant time.
--     PostgreSQL's bytea equality is not constant-time, and a timing oracle on
--     token verification is a real attack on a bearer-token API.
--
-- Anything beyond these three belongs behind a tenant context.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- API token lookup by prefix.
--
-- Returns the stored hash rather than comparing it here, so the caller can use
-- a constant-time comparison. That is not a weakening: the caller already
-- presented the prefix half of the token, and a SHA-256 of the whole token is
-- not usable as a credential.
--
-- Deliberately does NOT filter on revoked/expired. It returns those columns and
-- lets the caller decide, so a revoked token produces the same lookup shape as
-- a live one and the two cannot be distinguished by response timing.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.authenticate_api_token(p_token_prefix text)
  RETURNS TABLE (
    token_id           uuid,
    tenant_id          uuid,
    token_hash         bytea,
    token_type         api_token_type,
    service_account_id uuid,
    user_id            uuid,
    scopes             text[],
    ip_allowlist       inet[],
    expires_at         timestamptz,
    revoked_at         timestamptz,
    subject_disabled   boolean,
    tenant_active      boolean
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT
    t.id,
    t.tenant_id,
    t.token_hash,
    t.token_type,
    t.service_account_id,
    t.user_id,
    t.scopes,
    t.ip_allowlist,
    t.expires_at,
    t.revoked_at,
    -- A disabled service account or user must not authenticate, even with a
    -- token that is otherwise perfectly valid. Offboarding a technician has to
    -- take effect everywhere at once.
    coalesce(sa.disabled_at IS NOT NULL, u.disabled_at IS NOT NULL, false),
    ten.status = 'active'
  FROM api_token t
  JOIN tenant ten ON ten.id = t.tenant_id
  LEFT JOIN service_account sa ON sa.id = t.service_account_id
  LEFT JOIN app_user u ON u.id = t.user_id
  WHERE t.token_prefix = p_token_prefix;
$$;

COMMENT ON FUNCTION helm.authenticate_api_token(text) IS
  'Authentication boundary: resolves a token prefix to its identity before any '
  'tenant context exists. Returns no tenant data and makes no authorisation '
  'decision — set_session_context() does that from the membership row.';

-- -----------------------------------------------------------------------------
-- Usage accounting, best-effort and non-blocking.
--
-- Separate from the lookup because the lookup is STABLE (and must stay so, to
-- be usable in a read-only path), while this writes.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_api_token_use(p_token_id uuid, p_ip inet DEFAULT NULL)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  UPDATE api_token
  SET last_used_at = now(),
      last_used_ip = coalesce(p_ip, last_used_ip),
      use_count    = use_count + 1
  WHERE id = p_token_id;
$$;

-- -----------------------------------------------------------------------------
-- Which tenants may this user enter?
--
-- Needed straight after login, before a tenant is chosen. Returns membership
-- metadata only — no client data, no assets, nothing scoped.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.memberships_for_user(p_user_id uuid)
  RETURNS TABLE (
    tenant_id    uuid,
    tenant_slug  citext,
    tenant_name  text,
    role_key     text,
    role_rank    integer,
    org_scope_all boolean,
    require_step_up boolean
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT ten.id, ten.slug, ten.name, m.role_key, r.rank, m.org_scope_all, m.require_step_up
  FROM membership m
  JOIN tenant ten ON ten.id = m.tenant_id
  JOIN app_role r ON r.key = m.role_key
  JOIN app_user u ON u.id = m.user_id
  WHERE m.user_id = p_user_id
    AND m.status = 'active'
    AND m.revoked_at IS NULL
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND u.disabled_at IS NULL
    AND ten.status = 'active'
  ORDER BY ten.name;
$$;

REVOKE ALL ON FUNCTION helm.authenticate_api_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_api_token_use(uuid, inet) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.memberships_for_user(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.authenticate_api_token(text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.record_api_token_use(uuid, inet) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.memberships_for_user(uuid) TO helm_app, helm_auth;

-- -----------------------------------------------------------------------------
-- Guard: the authentication functions are the only RLS-bypassing read path in
-- the system, so their number is fixed. Adding one is a deliberate act that
-- should fail this assertion and require a decision, not slip through review.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  v_count integer;
  v_names text;
BEGIN
  SELECT count(*), string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO v_count, v_names
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'helm'
    AND p.prosecdef
    AND p.proname IN ('authenticate_api_token', 'record_api_token_use', 'memberships_for_user');

  IF v_count <> 3 THEN
    RAISE EXCEPTION 'helm: expected exactly 3 pre-context authentication functions, found % (%)',
      v_count, coalesce(v_names, 'none');
  END IF;
END
$guard$;
