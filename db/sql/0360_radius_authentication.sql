-- =============================================================================
-- 0360_radius_authentication.sql — RADIUS as a third door, and session tracking
--
-- Helm has had two ways in: Entra (SSO) and a local password. An MSP that
-- already runs RADIUS — almost always in front of the firewalls and switches
-- their technicians log into all day — wants Helm behind the same directory and
-- the same MFA push. This adds that as a third door, on the same session object
-- as the other two.
--
-- THE SHARED SECRET IS A PASSWORD HASH, NOT A CLIENT CREDENTIAL.
--
-- It is tempting to put it in secret_version with everything else. That is
-- wrong for the same reason password_phc is not there: this value is needed
-- BEFORE anybody is signed in, by the one role that runs pre-authentication
-- (helm_auth), with no tenant context and no actor to attribute a reveal to.
-- Pushing it through helm.reveal_secret() would mean either inventing a
-- pre-auth actor or writing an audit row for every login attempt in the
-- deployment, including the failed ones from a password spray.
--
-- So it lives here, enveloped by the same KEK that wraps every tenant DEK —
-- wrapped DEK in the row, shared secret sealed under it with AES-256-GCM, AAD
-- binding the ciphertext to this tenant and this config. Ciphertext at rest,
-- one role that can read it, and the master key wherever the deployment put it
-- (0280: on-prem keyfile or Vault transit). helm_app cannot SELECT this table
-- at all, by any column; it reaches the non-secret settings through a
-- SECURITY DEFINER function and writes the secret without being able to read it
-- back.
--
-- Configuring RADIUS is gated on tenant:write, which only super_admin holds.
-- Changing how an entire MSP authenticates is a strictly larger act than
-- configuring an integration, and integration:manage reaches down to tier3.
--
-- Also here, because it is the same subject: auth_session learns when it was
-- created, where from, and WHICH DOOR was used — so the account page can show
-- somebody their own sessions and end one, and so "you signed in with RADIUS"
-- is a fact about the session rather than a guess.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- How a session was established.
--
-- 'sso' is the default because the Auth.js adapter INSERTs into auth_session
-- with only the three columns it knows about, and the adapter is only ever
-- driven by the Entra flow. A default that named a password would mislabel
-- every SSO session in the deployment.
-- -----------------------------------------------------------------------------
CREATE TYPE auth_method AS ENUM ('sso', 'password', 'radius');

ALTER TABLE auth_session
  ADD COLUMN created_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN auth_method  auth_method NOT NULL DEFAULT 'sso',
  ADD COLUMN ip           inet,
  ADD COLUMN user_agent   text;

COMMENT ON COLUMN auth_session.auth_method IS
  'Which door this session came through. Recorded for the account page and for '
  'incident response; nothing downstream branches on it, because a session is a '
  'session whichever way it was established.';

-- -----------------------------------------------------------------------------
-- radius_config — one RADIUS server per tenant.
--
-- One row per tenant, not a list. A second server is failover, not a second
-- identity source, and modelling it as a list invites "which one said yes?"
-- questions that RADIUS itself answers badly. Failover belongs in host, as the
-- protocol's own retry, if it is ever needed.
-- -----------------------------------------------------------------------------
CREATE TABLE radius_config (
  tenant_id       uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,

  enabled         boolean NOT NULL DEFAULT false,
  host            text NOT NULL,
  port            integer NOT NULL DEFAULT 1812,
  -- How long to wait for one Access-Accept before giving up on that attempt.
  timeout_ms      integer NOT NULL DEFAULT 5000,
  -- UDP loses datagrams silently, so a single timeout is not an answer.
  retries         smallint NOT NULL DEFAULT 2,
  -- What Helm calls itself in the Access-Request. Most RADIUS servers key
  -- their client policy on this, so it is configuration rather than a constant.
  nas_identifier  text NOT NULL DEFAULT 'lake-effect-helm',

  -- The envelope. Identical in shape to tenant_data_key + secret_version,
  -- because it is the same construction: a DEK wrapped by the master KEK, and
  -- the shared secret sealed under that DEK.
  wrap_provider   text   NOT NULL,
  kek_id          text   NOT NULL,
  wrapped_dek     bytea  NOT NULL,
  secret_ciphertext bytea NOT NULL,
  secret_nonce    bytea  NOT NULL,
  secret_tag      bytea  NOT NULL,
  secret_aad      text   NOT NULL,

  -- Last time somebody pressed Test, and what happened. Stored so the answer
  -- survives the page reload that follows it.
  last_test_at    timestamptz,
  last_test_ok    boolean,
  last_test_error text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT radius_host_present   CHECK (length(btrim(host)) > 0),
  CONSTRAINT radius_host_shape     CHECK (host !~ '[[:space:]]'),
  CONSTRAINT radius_port_range     CHECK (port BETWEEN 1 AND 65535),
  -- Below 500ms a healthy server on a busy LAN gets called down; above 30s the
  -- sign-in page has already been abandoned.
  CONSTRAINT radius_timeout_range  CHECK (timeout_ms BETWEEN 500 AND 30000),
  CONSTRAINT radius_retries_range  CHECK (retries BETWEEN 0 AND 5),
  CONSTRAINT radius_nas_shape      CHECK (nas_identifier ~ '^[A-Za-z0-9._-]{1,63}$'),
  CONSTRAINT radius_nonce_len      CHECK (octet_length(secret_nonce) = 12),
  CONSTRAINT radius_tag_len        CHECK (octet_length(secret_tag) = 16),
  CONSTRAINT radius_secret_present CHECK (octet_length(secret_ciphertext) > 0)
);

COMMENT ON TABLE radius_config IS
  'RADIUS server settings and the enveloped shared secret. Readable only by '
  'helm_auth — the same boundary local_credential.password_phc sits behind.';

CREATE TRIGGER radius_config_touch BEFORE UPDATE ON radius_config
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- -----------------------------------------------------------------------------
-- helm.radius_config_for_email — what the login path needs, and only that.
--
-- Takes an address rather than a tenant because at sign-in time an address is
-- all there is: no session, no cookie, no tenant. Resolves through the user's
-- ACTIVE memberships, so a revoked technician does not get to authenticate
-- against their former employer's directory.
--
-- A user with memberships in several tenants that each run RADIUS is a genuine
-- ambiguity. It resolves to the oldest membership, deterministically, rather
-- than to whichever the planner returned first.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.radius_config_for_email(p_email citext)
RETURNS TABLE (
  tenant_id uuid, host text, port integer, timeout_ms integer, retries smallint,
  nas_identifier text, wrap_provider text, kek_id text, wrapped_dek bytea,
  secret_ciphertext bytea, secret_nonce bytea, secret_tag bytea, secret_aad text
)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT r.tenant_id, r.host, r.port, r.timeout_ms, r.retries,
         r.nas_identifier, r.wrap_provider, r.kek_id, r.wrapped_dek,
         r.secret_ciphertext, r.secret_nonce, r.secret_tag, r.secret_aad
  FROM radius_config r
  JOIN membership m ON m.tenant_id = r.tenant_id AND m.status = 'active'
  JOIN app_user u   ON u.id = m.user_id
  WHERE u.email = p_email
    AND u.disabled_at IS NULL
    AND r.enabled
  ORDER BY m.created_at
  LIMIT 1;
$$;

-- -----------------------------------------------------------------------------
-- helm.radius_config_for_tenant — the same row, for the admin test button.
--
-- Separate from the above because the caller is different in kind: a signed-in
-- administrator testing their own tenant's settings, not an anonymous login
-- attempt. Taking a tenant_id keeps the login function's address lookup from
-- being reachable with a tenant somebody guessed.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.radius_config_for_tenant(p_tenant_id uuid)
RETURNS TABLE (
  tenant_id uuid, host text, port integer, timeout_ms integer, retries smallint,
  nas_identifier text, wrap_provider text, kek_id text, wrapped_dek bytea,
  secret_ciphertext bytea, secret_nonce bytea, secret_tag bytea, secret_aad text
)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT r.tenant_id, r.host, r.port, r.timeout_ms, r.retries,
         r.nas_identifier, r.wrap_provider, r.kek_id, r.wrapped_dek,
         r.secret_ciphertext, r.secret_nonce, r.secret_tag, r.secret_aad
  FROM radius_config r WHERE r.tenant_id = p_tenant_id;
$$;

-- -----------------------------------------------------------------------------
-- helm.radius_settings — everything EXCEPT the secret, for the current tenant.
--
-- This is what helm_app is allowed to know. It runs inside a tenant context and
-- returns at most one row, so there is no argument to get wrong and no way to
-- name another tenant. The secret columns are not in the result type at all —
-- not filtered out downstream, absent.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.radius_settings()
RETURNS TABLE (
  enabled boolean, host text, port integer, timeout_ms integer, retries smallint,
  nas_identifier text, secret_set boolean, last_test_at timestamptz,
  last_test_ok boolean, last_test_error text, updated_at timestamptz
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.is_tenant_wide() THEN
    RAISE EXCEPTION 'helm: authentication settings are not visible to a client-side role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT r.enabled, r.host, r.port, r.timeout_ms, r.retries, r.nas_identifier,
           true AS secret_set,
           r.last_test_at, r.last_test_ok, r.last_test_error, r.updated_at
    FROM radius_config r WHERE r.tenant_id = v_tenant;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.set_radius_config — write settings and the enveloped secret together.
--
-- One function rather than one for settings and one for the secret, because
-- the AAD binds the ciphertext to this tenant: a half-applied change that left
-- a secret sealed against settings that had moved on would be a config nobody
-- can authenticate against and nobody can see is broken.
--
-- The caller encrypts. It has the KEK provider; the database has never had it
-- and is not being given it here. What arrives is ciphertext.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_radius_config(
  p_enabled        boolean,
  p_host           text,
  p_port           integer,
  p_timeout_ms     integer,
  p_retries        smallint,
  p_nas_identifier text,
  p_wrap_provider  text,
  p_kek_id         text,
  p_wrapped_dek    bytea,
  p_ciphertext     bytea,
  p_nonce          bytea,
  p_tag            bytea,
  p_aad            text
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
BEGIN
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: configuring authentication requires tenant:write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO radius_config (
    tenant_id, enabled, host, port, timeout_ms, retries, nas_identifier,
    wrap_provider, kek_id, wrapped_dek,
    secret_ciphertext, secret_nonce, secret_tag, secret_aad,
    created_by, updated_by)
  VALUES (
    v_tenant, p_enabled, btrim(p_host), p_port, p_timeout_ms, p_retries,
    p_nas_identifier, p_wrap_provider, p_kek_id, p_wrapped_dek,
    p_ciphertext, p_nonce, p_tag, p_aad, v_actor, v_actor)
  ON CONFLICT (tenant_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    host = EXCLUDED.host,
    port = EXCLUDED.port,
    timeout_ms = EXCLUDED.timeout_ms,
    retries = EXCLUDED.retries,
    nas_identifier = EXCLUDED.nas_identifier,
    wrap_provider = EXCLUDED.wrap_provider,
    kek_id = EXCLUDED.kek_id,
    wrapped_dek = EXCLUDED.wrapped_dek,
    secret_ciphertext = EXCLUDED.secret_ciphertext,
    secret_nonce = EXCLUDED.secret_nonce,
    secret_tag = EXCLUDED.secret_tag,
    secret_aad = EXCLUDED.secret_aad,
    -- A settings change invalidates whatever the last test proved.
    last_test_at = NULL,
    last_test_ok = NULL,
    last_test_error = NULL,
    updated_by = v_actor;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.update_radius_settings — change everything but the secret.
--
-- Exists so that adjusting a timeout does not require re-typing the shared
-- secret, which is the kind of friction that ends with the secret in a
-- password manager note shared across the team.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.update_radius_settings(
  p_enabled        boolean,
  p_host           text,
  p_port           integer,
  p_timeout_ms     integer,
  p_retries        smallint,
  p_nas_identifier text
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
  v_rows   integer;
BEGIN
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: configuring authentication requires tenant:write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE radius_config SET
    enabled = p_enabled,
    host = btrim(p_host),
    port = p_port,
    timeout_ms = p_timeout_ms,
    retries = p_retries,
    nas_identifier = p_nas_identifier,
    last_test_at = NULL,
    last_test_ok = NULL,
    last_test_error = NULL,
    updated_by = v_actor
  WHERE tenant_id = v_tenant;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.forget_radius_config — turn the third door off and take the key with it.
--
-- Deletes rather than clearing `enabled`, so a decommissioned RADIUS server
-- does not leave its shared secret sitting in the database indefinitely.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.forget_radius_config() RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_rows   integer;
BEGIN
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: configuring authentication requires tenant:write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM radius_config WHERE tenant_id = v_tenant;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.record_radius_test — remember what the Test button found.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_radius_test(
  p_tenant_id uuid,
  p_ok        boolean,
  p_error     text DEFAULT NULL
) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  UPDATE radius_config
  SET last_test_at = now(), last_test_ok = p_ok, last_test_error = left(p_error, 500)
  WHERE tenant_id = p_tenant_id;
$$;

-- -----------------------------------------------------------------------------
-- helm.create_local_session — now records which door, and from where.
--
-- Replaces the 0340 definition. The old three-argument form is dropped rather
-- than kept alongside: two functions differing only in what they forget to
-- record is how half the sessions in a deployment end up with no method.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS helm.create_local_session(uuid, text, integer);

CREATE OR REPLACE FUNCTION helm.create_local_session(
  p_user_id       uuid,
  p_session_token text,
  p_ttl_minutes   integer DEFAULT 480,
  p_method        auth_method DEFAULT 'password',
  p_ip            inet DEFAULT NULL,
  p_user_agent    text DEFAULT NULL
) RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_expires timestamptz;
BEGIN
  IF length(coalesce(p_session_token, '')) < 32 THEN
    RAISE EXCEPTION 'helm: session token is too short to be a session token'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_method = 'sso' THEN
    -- An SSO session is written by the Auth.js adapter, not by this path.
    -- Accepting 'sso' here would let the local login route mislabel itself.
    RAISE EXCEPTION 'helm: create_local_session does not establish SSO sessions'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_expires := now() + make_interval(mins => least(greatest(p_ttl_minutes, 5), 1440));

  INSERT INTO auth_session (session_token, user_id, expires, auth_method, ip, user_agent)
  VALUES (p_session_token, p_user_id, v_expires, p_method, p_ip, left(p_user_agent, 400));

  UPDATE app_user SET last_login_at = now() WHERE id = p_user_id;

  RETURN v_expires;
END;
$$;

-- -----------------------------------------------------------------------------
-- Your own sessions, without your own session tokens.
--
-- helm_app must never reach auth_session — §21 of the security model, asserted
-- by a guard in 0220 and again at the bottom of this file. But an account page
-- that cannot show you where you are signed in is not much of an account page,
-- so these three functions expose exactly the shape needed and no more.
--
-- The identifier is sha256 of the token, hex, truncated. Truncated because 128
-- bits of a hash is far past collision range for the handful of sessions one
-- person holds, and because a full hash of a live bearer token is a thing worth
-- not putting in HTML. The token itself never leaves the auth boundary.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.session_ref(p_session_token text) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT substr(encode(sha256(convert_to(p_session_token, 'UTF8')), 'hex'), 1, 32);
$$;

CREATE OR REPLACE FUNCTION helm.my_sessions()
RETURNS TABLE (
  session_ref text, created_at timestamptz, expires timestamptz,
  auth_method auth_method, ip inet, user_agent text
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := helm.current_actor_id();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'helm: no actor in context' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT helm.session_ref(s.session_token), s.created_at, s.expires,
           s.auth_method, s.ip, s.user_agent
    FROM auth_session s
    WHERE s.user_id = v_actor AND s.expires > now()
    ORDER BY s.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION helm.revoke_my_session(p_session_ref text) RETURNS boolean
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

  -- `user_id = v_actor` is the whole security property: a ref belonging to
  -- somebody else matches no row, whatever the caller believes it identifies.
  DELETE FROM auth_session s
  WHERE s.user_id = v_actor AND helm.session_ref(s.session_token) = p_session_ref;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

CREATE OR REPLACE FUNCTION helm.revoke_my_other_sessions(p_keep_ref text)
RETURNS integer
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

  DELETE FROM auth_session s
  WHERE s.user_id = v_actor
    AND helm.session_ref(s.session_token) IS DISTINCT FROM p_keep_ref;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.set_my_profile — the parts of your own account you may change.
--
-- `name` only. Email is deliberately not here: it is the join key the Entra
-- adapter matches on and the username RADIUS is asked about, so changing it
-- from a profile form would silently detach an account from both directories.
-- The account page says so rather than offering a field that breaks sign-in.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_my_profile(p_name text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := helm.current_actor_id();
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'helm: no actor in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_name IS NOT NULL AND length(v_name) > 120 THEN
    RAISE EXCEPTION 'helm: display name is too long'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE app_user SET name = v_name, updated_at = now() WHERE id = v_actor;
  RETURN v_name;
END;
$$;

-- =============================================================================
-- Grants
-- =============================================================================

-- The table itself: helm_auth and nobody else. Same boundary password_phc sits
-- behind, for the same reason.
REVOKE ALL ON radius_config FROM PUBLIC, helm_app, helm_worker, helm_auditor, helm_key_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON radius_config TO helm_auth;

REVOKE ALL ON FUNCTION helm.radius_config_for_email(citext) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.radius_config_for_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_radius_test(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.radius_settings() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_radius_config(
  boolean, text, integer, integer, smallint, text, text, text, bytea, bytea, bytea, bytea, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.update_radius_settings(boolean, text, integer, integer, smallint, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.forget_radius_config() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.create_local_session(uuid, text, integer, auth_method, inet, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.my_sessions() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.revoke_my_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.revoke_my_other_sessions(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_my_profile(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.session_ref(text) FROM PUBLIC;

-- Reading the secret is a pre-authentication act, so it belongs to the
-- pre-authentication role and to nothing else.
GRANT EXECUTE ON FUNCTION helm.radius_config_for_email(citext) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.radius_config_for_tenant(uuid) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.record_radius_test(uuid, boolean, text) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.create_local_session(uuid, text, integer, auth_method, inet, text)
  TO helm_auth;

-- Writing it is an administrative act inside a tenant context, so it belongs to
-- the application role — which still cannot read back what it wrote.
GRANT EXECUTE ON FUNCTION helm.radius_settings() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_radius_config(
  boolean, text, integer, integer, smallint, text, text, text, bytea, bytea, bytea, bytea, text)
  TO helm_app;
GRANT EXECUTE ON FUNCTION helm.update_radius_settings(boolean, text, integer, integer, smallint, text)
  TO helm_app;
GRANT EXECUTE ON FUNCTION helm.forget_radius_config() TO helm_app;

GRANT EXECUTE ON FUNCTION helm.my_sessions() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.revoke_my_session(text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.revoke_my_other_sessions(text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_my_profile(text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.session_ref(text) TO helm_app, helm_auth;

-- =============================================================================
-- Guards
--
-- Structural, and checked at migration time rather than asserted in a test that
-- may not be run. Each of these is a boundary that is easy to erase later by
-- adding one convenient grant.
-- =============================================================================
DO $$
DECLARE
  v_col text;
BEGIN
  -- 1. helm_app cannot read the shared secret, or anything else on this table.
  FOR v_col IN
    SELECT column_name FROM information_schema.columns WHERE table_name = 'radius_config'
  LOOP
    IF has_column_privilege('helm_app', 'radius_config', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'helm: helm_app can read radius_config.% — the shared secret must stay behind helm_auth', v_col;
    END IF;
  END LOOP;

  IF has_table_privilege('helm_app', 'radius_config', 'INSERT')
     OR has_table_privilege('helm_app', 'radius_config', 'UPDATE') THEN
    RAISE EXCEPTION 'helm: helm_app has direct write access to radius_config; it must go through set_radius_config()';
  END IF;

  -- 2. helm_worker and helm_auditor have no business here at all. A background
  --    job that could read this could authenticate as anybody in the directory.
  IF has_table_privilege('helm_worker', 'radius_config', 'SELECT')
     OR has_table_privilege('helm_auditor', 'radius_config', 'SELECT') THEN
    RAISE EXCEPTION 'helm: a non-auth role can read radius_config';
  END IF;

  -- 3. §21 still holds. The session functions above are SECURITY DEFINER
  --    precisely so this stays true.
  IF has_table_privilege('helm_app', 'auth_session', 'SELECT')
     OR has_table_privilege('helm_app', 'auth_session', 'DELETE') THEN
    RAISE EXCEPTION 'helm: helm_app reached auth_session directly; the account page must use my_sessions()';
  END IF;

  -- 4. The session helpers must be SECURITY DEFINER, or they are just an
  --    error message where a boundary used to be.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm'
      AND p.proname IN ('my_sessions', 'revoke_my_session', 'revoke_my_other_sessions',
                        'set_my_profile', 'radius_settings', 'set_radius_config',
                        'radius_config_for_email')
      AND NOT p.prosecdef
  ) THEN
    RAISE EXCEPTION 'helm: an account or RADIUS helper lost SECURITY DEFINER';
  END IF;

  -- 5. The old three-argument session constructor is gone, not shadowed.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'create_local_session'
      AND p.pronargs = 3
  ) THEN
    RAISE EXCEPTION 'helm: the session constructor that cannot record an auth method still exists';
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- One more attempt outcome: RADIUS was configured and could not be reached.
--
-- Worth recording separately because it is the signal an operator needs and the
-- one they will otherwise never see — a fallback to local passwords is silent
-- by design, and "everybody quietly stopped using the directory three weeks
-- ago" is not something to learn during an audit.
--
-- Deliberately absent from the throttle's partial indexes (0340): a server
-- outage must not lock out the people it is failing.
-- -----------------------------------------------------------------------------
ALTER TABLE auth_attempt DROP CONSTRAINT auth_attempt_outcome_known;
ALTER TABLE auth_attempt ADD CONSTRAINT auth_attempt_outcome_known CHECK (
  outcome IN ('success', 'bad_password', 'no_such_account', 'locked',
              'rate_limited', 'disabled', 'reset_redeemed', 'reset_refused',
              'radius_unavailable')
);
