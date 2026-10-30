-- =============================================================================
-- 1210  Installing a Helm update from the Updates page
-- =============================================================================
--
-- An administrator presses "Update now" (or picks a time) and the server pulls
-- main and runs deploy/setup.sh --yes. THE WEB TIER DOES NONE OF THAT. It holds
-- no Docker socket and no checkout, and it should not: a process that holds
-- decrypted credentials and can also rebuild itself from a remote branch is a
-- much bigger thing to defend. What it does is write a row here. A small
-- updater on the host (deploy/updater.sh, run once a minute by a systemd timer
-- that setup.sh installs) reads the row as the superuser through
-- `docker compose exec postgres psql`, does the work, and writes back what
-- happened.
--
-- INSTANCE-WIDE, like 0820's backups. There is one checkout and one stack, so
-- neither table carries tenant_id; no runtime role may touch them, and the
-- application reaches them only through the SECURITY DEFINER functions below,
-- each of which requires tenant:write in the calling session.
--
-- WHAT A REQUEST CAN NAME: a commit, and nothing else. The updater fetches the
-- configured branch from the configured remote (both read from .env on the
-- host, never from this row) and refuses a commit that is not on it. So the
-- worst a stolen administrator session can do here is install, early, a commit
-- that is already on main and would have been installed anyway.
--
-- AND A PASSWORD. Requesting one needs a step-up in the same request: the route
-- re-checks the person's password (and authenticator code, if they have one)
-- every time, and helm.request_helm_update() refuses a session that has not
-- just stepped up — the same `step_up_required` refusal a critical credential
-- gives, so the database holds the line even if a route forgets to.
-- =============================================================================

CREATE TABLE helm_update (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status         text NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'running', 'succeeded', 'failed', 'cancelled')),
  -- What the administrator saw as "latest" when they asked. The updater
  -- installs exactly this, or refuses.
  target_commit  text NOT NULL CHECK (target_commit ~ '^[0-9a-f]{40}$'),
  -- When to start. now() for "Update now"; the updater looks once a minute.
  scheduled_for  timestamptz NOT NULL DEFAULT now(),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  requested_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  cancelled_at   timestamptz,
  cancelled_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  started_at     timestamptz,
  finished_at    timestamptz,
  -- Written by the updater.
  from_commit    text CHECK (from_commit IS NULL OR from_commit ~ '^[0-9a-f]{40}$'),
  to_commit      text CHECK (to_commit IS NULL OR to_commit ~ '^[0-9a-f]{40}$'),
  stage          text,
  -- The tail of setup.sh's output, so a failure can be read without a shell.
  log            text CHECK (log IS NULL OR length(log) <= 65536),
  error          text CHECK (error IS NULL OR length(error) <= 2000)
);
CREATE INDEX helm_update_recent_idx ON helm_update (requested_at DESC);
-- At most one update queued or running. Two would race for the same checkout.
CREATE UNIQUE INDEX helm_update_one_open_uk ON helm_update ((true))
  WHERE status IN ('scheduled', 'running');

-- One row: when the host's updater last looked. The page offers "Update now"
-- only while this is recent, because a button that queues a request nothing
-- will ever pick up is a button that silently does nothing.
CREATE TABLE helm_updater (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_seen_at  timestamptz NOT NULL,
  host          text CHECK (host IS NULL OR length(host) <= 255)
);

COMMENT ON TABLE helm_update IS 'Updates requested from the Updates page (1210) and what the host updater did with each. Read and written by the app only through helm.helm_updates(), helm.request_helm_update() and helm.cancel_helm_update(); the updater writes as the superuser.';
COMMENT ON TABLE helm_updater IS 'When the host updater (deploy/updater.sh) last checked for a request (1210). One row.';

REVOKE ALL ON helm_update, helm_updater FROM PUBLIC, helm_app, helm_auth, helm_worker, helm_key_admin, helm_auditor;

-- -----------------------------------------------------------------------------
-- The door: tenant:write, in a session.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.require_update_admin() RETURNS void
  LANGUAGE plpgsql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM helm.require_tenant_id();
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: updates are installed by tenant administrators (tenant:write)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION helm.helm_updates(p_limit integer DEFAULT 10)
  RETURNS SETOF helm_update
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM helm.require_update_admin();
  RETURN QUERY SELECT * FROM helm_update ORDER BY requested_at DESC LIMIT greatest(1, least(p_limit, 100));
END;
$$;

CREATE OR REPLACE FUNCTION helm.helm_updater_last_seen()
  RETURNS timestamptz
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM helm.require_update_admin();
  RETURN (SELECT last_seen_at FROM helm_updater WHERE id = 1);
END;
$$;

-- "Update now", or at a time. One open request at a time.
CREATE OR REPLACE FUNCTION helm.request_helm_update(p_target text, p_at timestamptz DEFAULT NULL)
  RETURNS helm_update
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_row helm_update;
  v_at  timestamptz := coalesce(p_at, now());
BEGIN
  PERFORM helm.require_update_admin();
  IF NOT helm.step_up_verified() THEN
    RAISE EXCEPTION 'helm: installing an update needs your password again'
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'step_up_required';
  END IF;
  IF p_target IS NULL OR p_target !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'helm: an update names a full commit hash' USING ERRCODE = 'check_violation';
  END IF;
  IF v_at < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'helm: that time has already passed' USING ERRCODE = 'check_violation';
  END IF;
  IF v_at > now() + interval '30 days' THEN
    RAISE EXCEPTION 'helm: an update can be scheduled at most 30 days ahead' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM helm_update WHERE status IN ('scheduled', 'running')) THEN
    RAISE EXCEPTION 'helm: an update is already scheduled or running' USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO helm_update (target_commit, scheduled_for, requested_by)
  VALUES (p_target, greatest(v_at, now()), helm.current_actor_id())
  RETURNING * INTO v_row;

  PERFORM helm.audit('update.requested', 'helm_update', v_row.id, 'success', NULL, NULL, NULL,
                     jsonb_build_object('target', p_target, 'scheduledFor', v_row.scheduled_for));
  RETURN v_row;
END;
$$;

-- Only before it starts. Once setup.sh is running, stopping it half way is
-- worse than letting it finish.
CREATE OR REPLACE FUNCTION helm.cancel_helm_update(p_id uuid)
  RETURNS helm_update
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE v_row helm_update;
BEGIN
  PERFORM helm.require_update_admin();
  UPDATE helm_update
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = helm.current_actor_id()
   WHERE id = p_id AND status = 'scheduled'
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'helm: that update has already started, finished or been cancelled'
      USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM helm.audit('update.cancelled', 'helm_update', v_row.id, 'success', NULL, NULL, NULL,
                     jsonb_build_object('target', v_row.target_commit));
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION helm.require_update_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.helm_updates(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.helm_updater_last_seen() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.request_helm_update(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.cancel_helm_update(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.require_update_admin() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.helm_updates(integer) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.helm_updater_last_seen() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.request_helm_update(text, timestamptz) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.cancel_helm_update(uuid) TO helm_app;
