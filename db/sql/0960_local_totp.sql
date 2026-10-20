-- =============================================================================
-- 0960 — an authenticator-app code (TOTP) for local sign-in
--
-- A local password is the break-glass door: it works when single sign-on does
-- not, which makes it exactly the door an attacker would choose. A person can
-- now add a second step to it — a six-digit code from an authenticator app —
-- and an administrator can require that every local sign-in have one.
--
-- WHAT IS STORED. The seed must be READ BACK to check a code, so it cannot be
-- hashed. It is enveloped exactly as the RADIUS secret is (0360): a DEK wrapped
-- by the KEK in the row, the seed sealed under it with AES-256-GCM, the AAD
-- binding the ciphertext to this person. It is needed before anybody is signed
-- in, by helm_auth, so like local_credential it is a helm_auth table that
-- helm_app cannot SELECT at all.
--
-- A row with confirmed_at NULL is an enrolment in progress: the seed has been
-- shown but no code from it has been typed back yet. It does nothing at sign-in
-- until it is confirmed.
--
-- RECOVERY CODES are ten single-use strings shown once at enrolment, for a
-- lost phone. They are random and high-entropy, so a SHA-256 is enough; they
-- are never shown again.
--
-- REPLAY. last_step is the time step of the last code accepted; a code from
-- that step or an earlier one is refused, so a code read over a shoulder cannot
-- be used a second time.
--
-- A WRONG CODE IS A FAILED SIGN-IN. 'bad_totp' counts towards the per-account
-- and per-address throttle and advances the lockout exactly as a wrong
-- password does: six digits are a million guesses, and the lockout is what
-- makes that a million minutes.
-- =============================================================================

SET search_path = public, extensions;

CREATE TABLE local_totp (
  user_id         uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  wrap_provider   text NOT NULL,
  kek_id          text NOT NULL,
  wrapped_dek     bytea NOT NULL,
  seed_ciphertext bytea NOT NULL,
  seed_nonce      bytea NOT NULL,
  seed_tag        bytea NOT NULL,
  seed_aad        text NOT NULL,
  confirmed_at    timestamptz,
  last_step       bigint,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE local_totp_recovery (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hash)
);

COMMENT ON TABLE local_totp IS
  'A person''s authenticator-app seed for local sign-in (0960), enveloped by the '
  'KEK. confirmed_at NULL is an enrolment not yet proven with a code.';
COMMENT ON TABLE local_totp_recovery IS
  'Single-use recovery codes for local_totp, as SHA-256 (0960).';

-- As local_credential (0340): helm_auth only, by default privileges undone.
ALTER TABLE local_totp ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_totp FORCE ROW LEVEL SECURITY;
ALTER TABLE local_totp_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_totp_recovery FORCE ROW LEVEL SECURITY;
REVOKE ALL ON local_totp, local_totp_recovery
  FROM PUBLIC, helm_app, helm_auth, helm_key_admin, helm_auditor, helm_worker;
CREATE POLICY local_totp_rls_auth ON local_totp TO helm_auth USING (true) WITH CHECK (true);
CREATE POLICY local_totp_recovery_rls_auth ON local_totp_recovery TO helm_auth USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON local_totp, local_totp_recovery TO helm_auth;

-- -----------------------------------------------------------------------------
-- 'bad_totp' is a genuine failure: recorded, throttled, and it locks.
-- -----------------------------------------------------------------------------
ALTER TABLE auth_attempt DROP CONSTRAINT auth_attempt_outcome_known;
ALTER TABLE auth_attempt ADD CONSTRAINT auth_attempt_outcome_known CHECK (
  outcome IN ('success', 'bad_password', 'no_such_account', 'locked',
              'rate_limited', 'disabled', 'reset_redeemed', 'reset_refused',
              'radius_unavailable', 'bad_totp')
);

DROP INDEX auth_attempt_email_idx;
DROP INDEX auth_attempt_ip_idx;
CREATE INDEX auth_attempt_email_idx ON auth_attempt (email, occurred_at DESC)
  WHERE outcome IN ('bad_password', 'no_such_account', 'disabled', 'bad_totp');
CREATE INDEX auth_attempt_ip_idx ON auth_attempt (ip, occurred_at DESC)
  WHERE outcome IN ('bad_password', 'no_such_account', 'disabled', 'bad_totp');

-- 0340's challenge, counting a wrong code as a failure; and saying whether a
-- second step is due — enrolled, or required by policy and not yet enrolled.
DROP FUNCTION helm.local_login_challenge(text, inet);
CREATE FUNCTION helm.local_login_challenge(
  p_email text,
  p_ip    inet DEFAULT NULL
) RETURNS TABLE (
  found              boolean,
  user_id            uuid,
  password_phc       text,
  must_change        boolean,
  disabled           boolean,
  locked_until       timestamptz,
  throttled          boolean,
  account_failures   integer,
  address_failures   integer,
  totp_enrolled      boolean,
  totp_required      boolean
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_user       app_user%ROWTYPE;
  v_credential local_credential%ROWTYPE;
  v_email      citext := lower(btrim(p_email))::citext;
  v_account    integer := 0;
  v_address    integer := 0;
  v_enrolled   boolean := false;
  v_required   boolean := false;
BEGIN
  SELECT count(*) INTO v_account
  FROM auth_attempt
  WHERE email = v_email
    AND outcome IN ('bad_password', 'no_such_account', 'disabled', 'bad_totp')
    AND occurred_at > now() - interval '15 minutes';

  IF p_ip IS NOT NULL THEN
    SELECT count(*) INTO v_address
    FROM auth_attempt
    WHERE ip = p_ip
      AND outcome IN ('bad_password', 'no_such_account', 'disabled', 'bad_totp')
      AND occurred_at > now() - interval '15 minutes';
  END IF;

  SELECT * INTO v_user FROM app_user WHERE email = v_email;

  IF FOUND THEN
    SELECT * INTO v_credential FROM local_credential WHERE local_credential.user_id = v_user.id;
    SELECT EXISTS (SELECT 1 FROM local_totp t WHERE t.user_id = v_user.id AND t.confirmed_at IS NOT NULL)
      INTO v_enrolled;
    SELECT p.require_local_totp INTO v_required FROM helm.session_policy_for_user(v_user.id) p;
  END IF;

  RETURN QUERY SELECT
    v_credential.user_id IS NOT NULL,
    v_user.id,
    v_credential.password_phc,
    coalesce(v_credential.must_change, false),
    v_user.disabled_at IS NOT NULL,
    v_credential.locked_until,
    (v_account >= 10 OR v_address >= 30),
    v_account,
    v_address,
    v_enrolled,
    coalesce(v_required, false);
END;
$$;

-- -----------------------------------------------------------------------------
-- The session policy learns "require a code for local sign-in" (0890 + one
-- column). The strictest wins: any of a person's tenants requiring it requires
-- it for them.
-- -----------------------------------------------------------------------------
ALTER TABLE session_policy ADD COLUMN require_local_totp boolean NOT NULL DEFAULT false;

DROP FUNCTION helm.my_session_policy();
DROP FUNCTION helm.session_policy_for_user(uuid);
CREATE FUNCTION helm.session_policy_for_user(p_user_id uuid)
RETURNS TABLE (
  idle_minutes        integer,
  absolute_hours      integer,
  step_up_minutes     integer,
  lockout_threshold   integer,
  lockout_max_minutes integer,
  require_local_totp  boolean
)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT
    coalesce(min(coalesce(p.idle_minutes, 480)), 480),
    min(p.absolute_hours),
    coalesce(min(coalesce(p.step_up_minutes, 15)), 15),
    coalesce(min(coalesce(p.lockout_threshold, 5)), 5),
    coalesce(max(coalesce(p.lockout_max_minutes, 15)), 15),
    coalesce(bool_or(coalesce(p.require_local_totp, false)), false)
  FROM membership m
  LEFT JOIN session_policy p ON p.tenant_id = m.tenant_id
  WHERE m.user_id = p_user_id
    AND m.status = 'active'
    AND m.revoked_at IS NULL
    AND (m.expires_at IS NULL OR m.expires_at > now());
$$;

CREATE FUNCTION helm.my_session_policy()
RETURNS TABLE (idle_minutes integer, absolute_hours integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT p.idle_minutes, p.absolute_hours
  FROM helm.session_policy_for_user(helm.current_actor_id()) p;
$$;

DROP FUNCTION helm.session_policy();
CREATE FUNCTION helm.session_policy()
RETURNS TABLE (
  idle_minutes        integer,
  absolute_hours      integer,
  step_up_minutes     integer,
  lockout_threshold   integer,
  lockout_max_minutes integer,
  require_local_totp  boolean,
  updated_at          timestamptz
)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT coalesce(p.idle_minutes, 480), p.absolute_hours, coalesce(p.step_up_minutes, 15),
         coalesce(p.lockout_threshold, 5), coalesce(p.lockout_max_minutes, 15),
         coalesce(p.require_local_totp, false), p.updated_at
  FROM (SELECT helm.require_tenant_id() AS tenant_id) t
  LEFT JOIN session_policy p ON p.tenant_id = t.tenant_id;
$$;

DROP FUNCTION helm.set_session_policy(integer, integer, integer, integer, integer);
CREATE FUNCTION helm.set_session_policy(
  p_idle_minutes        integer,
  p_absolute_hours      integer,
  p_step_up_minutes     integer,
  p_lockout_threshold   integer,
  p_lockout_max_minutes integer,
  p_require_local_totp  boolean
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
BEGIN
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: changing the session policy requires tenant:write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO session_policy (
    tenant_id, idle_minutes, absolute_hours, step_up_minutes,
    lockout_threshold, lockout_max_minutes, require_local_totp, updated_by)
  VALUES (v_tenant, p_idle_minutes, p_absolute_hours, p_step_up_minutes,
          p_lockout_threshold, p_lockout_max_minutes, p_require_local_totp, v_actor)
  ON CONFLICT (tenant_id) DO UPDATE SET
    idle_minutes = EXCLUDED.idle_minutes,
    absolute_hours = EXCLUDED.absolute_hours,
    step_up_minutes = EXCLUDED.step_up_minutes,
    lockout_threshold = EXCLUDED.lockout_threshold,
    lockout_max_minutes = EXCLUDED.lockout_max_minutes,
    require_local_totp = EXCLUDED.require_local_totp,
    updated_at = now(),
    updated_by = v_actor;

  PERFORM helm.audit(
    'session_policy.updated', 'tenant', v_tenant, 'success', NULL, NULL, NULL,
    jsonb_build_object(
      'idleMinutes', p_idle_minutes, 'absoluteHours', p_absolute_hours,
      'stepUpMinutes', p_step_up_minutes, 'lockoutThreshold', p_lockout_threshold,
      'lockoutMaxMinutes', p_lockout_max_minutes, 'requireLocalTotp', p_require_local_totp));
END;
$$;

-- A wrong code advances the lockout as a wrong password does. 0890's function
-- with one more outcome in its gate.
CREATE OR REPLACE FUNCTION helm.record_login_attempt(
  p_email      text,
  p_user_id    uuid,
  p_outcome    text,
  p_ip         inet DEFAULT NULL,
  p_user_agent text DEFAULT NULL
) RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_failures   integer;
  v_lock_until timestamptz := NULL;
  v_threshold  integer;
  v_ceiling    integer;
BEGIN
  INSERT INTO auth_attempt (email, user_id, ip, outcome, user_agent)
  VALUES (lower(btrim(p_email))::citext, p_user_id, p_ip, p_outcome, left(p_user_agent, 500));

  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_outcome = 'success' THEN
    UPDATE local_credential
    SET failed_attempts = 0, locked_until = NULL, last_success_at = now()
    WHERE user_id = p_user_id;
    RETURN NULL;
  END IF;

  IF p_outcome NOT IN ('bad_password', 'bad_totp') THEN
    RETURN NULL;
  END IF;

  UPDATE local_credential
  SET failed_attempts = failed_attempts + 1, last_failure_at = now()
  WHERE user_id = p_user_id
  RETURNING failed_attempts INTO v_failures;

  IF v_failures IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.lockout_threshold, p.lockout_max_minutes INTO v_threshold, v_ceiling
  FROM helm.session_policy_for_user(p_user_id) p;

  IF v_failures >= v_threshold THEN
    v_lock_until := now() + least(
      make_interval(mins => (2 ^ least(v_failures - v_threshold, 10))::integer),
      make_interval(mins => v_ceiling)
    );
    UPDATE local_credential SET locked_until = v_lock_until WHERE user_id = p_user_id;
  END IF;

  RETURN v_lock_until;
END;
$$;

-- -----------------------------------------------------------------------------
-- For helm_app: whether a member has a code (the People page), and an
-- administrator's reset for a lost phone. Neither reveals or touches a seed
-- beyond deleting it.
-- -----------------------------------------------------------------------------
CREATE FUNCTION helm.members_with_totp() RETURNS TABLE (user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT t.user_id FROM local_totp t
  JOIN membership m ON m.user_id = t.user_id AND m.tenant_id = helm.current_tenant_id()
  WHERE t.confirmed_at IS NOT NULL
    AND (helm.has_permission('user:read') OR t.user_id = helm.current_actor_id());
$$;

CREATE FUNCTION helm.reset_local_totp(p_user_id uuid, p_reason text DEFAULT NULL)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.has_permission('user:write') THEN
    RAISE EXCEPTION 'helm: resetting somebody''s authenticator requires user:write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM membership m
    WHERE m.user_id = p_user_id AND m.tenant_id = v_tenant AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'helm: that person is not a member of this tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM local_totp_recovery WHERE user_id = p_user_id;
  DELETE FROM local_totp WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM helm.audit('auth.totp_reset', 'app_user', p_user_id,
                     'success'::audit_outcome, NULL, NULL, p_reason, '{}'::jsonb);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION helm.local_login_challenge(text, inet) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.session_policy_for_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.my_session_policy() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.session_policy() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_session_policy(integer, integer, integer, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.members_with_totp() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.reset_local_totp(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.local_login_challenge(text, inet) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.session_policy_for_user(uuid) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.my_session_policy() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.session_policy() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_session_policy(integer, integer, integer, integer, integer, boolean) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.members_with_totp() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.reset_local_totp(uuid, text) TO helm_app;

DO $$
BEGIN
  IF has_table_privilege('helm_app', 'local_totp', 'SELECT')
     OR has_table_privilege('helm_app', 'local_totp_recovery', 'SELECT') THEN
    RAISE EXCEPTION '0960: helm_app can read authenticator seeds or recovery codes';
  END IF;
END
$$;
