-- =============================================================================
-- 0890 — sign-in and session policy an administrator can set
--
-- Until now every number here was a constant: a session lived eight hours and
-- extended itself while used, a step-up lasted fifteen minutes, and five wrong
-- passwords locked a local account for a minute, doubling to fifteen. Those are
-- reasonable defaults and remain the defaults. What changes is that an MSP with
-- a policy of its own — "sign out after 30 idle minutes", "sign in again every
-- day" — can now set it, from Global → Settings, for everybody.
--
-- ONE ROW PER TENANT, and THE STRICTEST ONE WINS. A person with memberships in
-- two tenants is held to the shorter idle timeout, the shorter absolute
-- lifetime and the lower lockout threshold of the two: a session is one
-- session, and the tenant that asked for less trust should get it.
--
-- WHO READS IT. helm_auth, before anybody is in a tenant, through
-- helm.session_policy_for_user(): it enforces idle and absolute limits when it
-- resolves a session, and the lockout when it records a bad password. helm_app
-- reads its own tenant's row to show the settings card and to time a step-up,
-- and its own actor's effective policy to warn before an idle sign-out. Neither
-- reads the table directly.
--
-- WHAT "IDLE" MEANS. auth_session gains last_seen_at, moved forward (at most
-- once a minute) whenever the session is resolved. A browser left open with
-- nobody at it makes no requests, so it goes idle; one that somebody is using
-- does not. The shell also warns a minute before and pings while the person is
-- active, so reading a long page is not "idle".
-- =============================================================================

SET search_path = public, extensions;

CREATE TABLE session_policy (
  tenant_id           uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  -- Sign out after this long with no activity.
  idle_minutes        integer NOT NULL DEFAULT 480,
  -- Sign in again after this long whatever the activity. NULL: no limit.
  absolute_hours      integer,
  -- How long a step-up (re-entering a password before a reveal) lasts.
  step_up_minutes     integer NOT NULL DEFAULT 15,
  -- Wrong local passwords before the account is locked, and the longest lock.
  lockout_threshold   integer NOT NULL DEFAULT 5,
  lockout_max_minutes integer NOT NULL DEFAULT 15,

  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT session_policy_idle_ck CHECK (idle_minutes BETWEEN 5 AND 1440),
  CONSTRAINT session_policy_absolute_ck CHECK (absolute_hours IS NULL OR absolute_hours BETWEEN 1 AND 720),
  CONSTRAINT session_policy_step_up_ck CHECK (step_up_minutes BETWEEN 1 AND 60),
  CONSTRAINT session_policy_lockout_ck CHECK (lockout_threshold BETWEEN 3 AND 20),
  CONSTRAINT session_policy_lockout_minutes_ck CHECK (lockout_max_minutes BETWEEN 1 AND 1440)
);

COMMENT ON TABLE session_policy IS
  'Sign-in and session limits a tenant administrator sets (0890). A person in '
  'several tenants is held to the strictest of them.';

-- Reached only through the functions below. The policies are the MSP-only,
-- rank-100 set radius_config has, as a second wall behind the missing grants.
SELECT helm.apply_tenant_rls('session_policy', false, 100, NULL);
-- Default privileges (0220) grant new tables to the application roles;
-- this one is not theirs to read.
REVOKE ALL ON session_policy FROM PUBLIC, helm_app, helm_auth;

ALTER TABLE auth_session ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
COMMENT ON COLUMN auth_session.last_seen_at IS
  'When this session was last resolved, to within a minute (0890). Idle time is '
  'measured from here.';

-- -----------------------------------------------------------------------------
-- The effective policy for one person: the strictest across every tenant they
-- hold an active membership in, and the defaults where none has a row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.session_policy_for_user(p_user_id uuid)
RETURNS TABLE (
  idle_minutes        integer,
  absolute_hours      integer,
  step_up_minutes     integer,
  lockout_threshold   integer,
  lockout_max_minutes integer
)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  -- A tenant that never saved a policy holds its members to the defaults, so
  -- the defaults take part in the comparison rather than being skipped.
  SELECT
    coalesce(min(coalesce(p.idle_minutes, 480)), 480),
    min(p.absolute_hours),
    coalesce(min(coalesce(p.step_up_minutes, 15)), 15),
    coalesce(min(coalesce(p.lockout_threshold, 5)), 5),
    coalesce(max(coalesce(p.lockout_max_minutes, 15)), 15)
  FROM membership m
  LEFT JOIN session_policy p ON p.tenant_id = m.tenant_id
  WHERE m.user_id = p_user_id
    AND m.status = 'active'
    AND m.revoked_at IS NULL
    AND (m.expires_at IS NULL OR m.expires_at > now());
$$;

-- The caller's own effective policy, for the shell's idle warning.
CREATE OR REPLACE FUNCTION helm.my_session_policy()
RETURNS TABLE (idle_minutes integer, absolute_hours integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT p.idle_minutes, p.absolute_hours
  FROM helm.session_policy_for_user(helm.current_actor_id()) p;
$$;

-- This tenant's own settings, for the settings card and the step-up route.
-- Defaults when it has never saved any.
CREATE OR REPLACE FUNCTION helm.session_policy()
RETURNS TABLE (
  idle_minutes        integer,
  absolute_hours      integer,
  step_up_minutes     integer,
  lockout_threshold   integer,
  lockout_max_minutes integer,
  updated_at          timestamptz
)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT coalesce(p.idle_minutes, 480), p.absolute_hours, coalesce(p.step_up_minutes, 15),
         coalesce(p.lockout_threshold, 5), coalesce(p.lockout_max_minutes, 15), p.updated_at
  FROM (SELECT helm.require_tenant_id() AS tenant_id) t
  LEFT JOIN session_policy p ON p.tenant_id = t.tenant_id;
$$;

CREATE OR REPLACE FUNCTION helm.set_session_policy(
  p_idle_minutes        integer,
  p_absolute_hours      integer,
  p_step_up_minutes     integer,
  p_lockout_threshold   integer,
  p_lockout_max_minutes integer
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
    lockout_threshold, lockout_max_minutes, updated_by)
  VALUES (v_tenant, p_idle_minutes, p_absolute_hours, p_step_up_minutes,
          p_lockout_threshold, p_lockout_max_minutes, v_actor)
  ON CONFLICT (tenant_id) DO UPDATE SET
    idle_minutes = EXCLUDED.idle_minutes,
    absolute_hours = EXCLUDED.absolute_hours,
    step_up_minutes = EXCLUDED.step_up_minutes,
    lockout_threshold = EXCLUDED.lockout_threshold,
    lockout_max_minutes = EXCLUDED.lockout_max_minutes,
    updated_at = now(),
    updated_by = v_actor;

  PERFORM helm.audit(
    'session_policy.updated', 'tenant', v_tenant, 'success', NULL, NULL, NULL,
    jsonb_build_object(
      'idleMinutes', p_idle_minutes, 'absoluteHours', p_absolute_hours,
      'stepUpMinutes', p_step_up_minutes, 'lockoutThreshold', p_lockout_threshold,
      'lockoutMaxMinutes', p_lockout_max_minutes));
END;
$$;

-- -----------------------------------------------------------------------------
-- Sign everybody else out: every session of every person with a membership in
-- this tenant, except the caller's own. For after an incident, or after
-- tightening the policy, when "from now on" is not soon enough.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.end_tenant_sessions() RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_actor   uuid := helm.current_actor_id();
  v_deleted integer;
BEGIN
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: signing everybody out requires tenant:write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM auth_session s
  WHERE s.user_id <> v_actor
    AND EXISTS (SELECT 1 FROM membership m WHERE m.user_id = s.user_id AND m.tenant_id = v_tenant);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  PERFORM helm.audit(
    'session.ended_all', 'tenant', v_tenant, 'success', NULL, NULL, NULL,
    jsonb_build_object('sessions', v_deleted));
  RETURN v_deleted;
END;
$$;

-- -----------------------------------------------------------------------------
-- The lockout, from the policy. 0340's state machine, with its two constants
-- read from the person's effective policy: N wrong passwords lock for a
-- minute, doubling, up to the ceiling. Everything else is unchanged —
-- including that only a wrong password advances it.
-- -----------------------------------------------------------------------------
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

  -- ONLY a wrong password advances the lockout (see 0340).
  IF p_outcome <> 'bad_password' THEN
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
    -- threshold → 1 min, then doubling, capped at the ceiling.
    v_lock_until := now() + least(
      make_interval(mins => (2 ^ least(v_failures - v_threshold, 10))::integer),
      make_interval(mins => v_ceiling)
    );

    UPDATE local_credential SET locked_until = v_lock_until WHERE user_id = p_user_id;
  END IF;

  RETURN v_lock_until;
END;
$$;

REVOKE ALL ON FUNCTION helm.session_policy_for_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.my_session_policy() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.session_policy() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_session_policy(integer, integer, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.end_tenant_sessions() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.session_policy_for_user(uuid) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.my_session_policy() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.session_policy() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_session_policy(integer, integer, integer, integer, integer) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.end_tenant_sessions() TO helm_app;

DO $$
BEGIN
  -- The table is reached only through the functions: neither application role
  -- may read or write it directly.
  IF has_table_privilege('helm_app', 'session_policy', 'SELECT')
     OR has_table_privilege('helm_app', 'session_policy', 'UPDATE')
     OR has_table_privilege('helm_auth', 'session_policy', 'SELECT') THEN
    RAISE EXCEPTION '0890: an application role can reach session_policy directly';
  END IF;
  -- And 0350's invariant still holds: helm_app cannot reach auth_session.
  IF has_table_privilege('helm_app', 'auth_session', 'SELECT')
     OR has_table_privilege('helm_app', 'auth_session', 'DELETE') THEN
    RAISE EXCEPTION '0890: helm_app has direct access to auth_session';
  END IF;
END
$$;
