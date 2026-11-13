-- =============================================================================
-- 1310 — "Sync now" that can be seen, and a worker that says it is alive
-- =============================================================================
--
-- Sync now used to only clear last_sync_at and answer "Queued". Whether a run
-- ever followed depended entirely on the worker, and when it did not (worker
-- stopped, stalled with a full job pool, a job hung, another process holding
-- the job's lock) nothing anywhere said so: no run row, no error, no log line
-- above debug. That is what happened to NinjaOne on 2026-11-03 and again on
-- 2026-11-13: "Queued", then nothing in Recent runs, ever.
--
-- Three changes:
--
--  1. Sync now records a 'queued' run straight away, so the request shows up
--     in Recent runs the moment it is made. begin_sync_run promotes that row
--     to 'running' instead of inserting a second one (the open-run unique
--     index would otherwise make the worker think another worker had it, and
--     skip). A queued run only blocks nothing: sync_due ignores it.
--
--  2. The worker writes a heartbeat every tick, on a connection of its own so
--     a full job pool cannot silence it, with the jobs it is running and the
--     jobs whose lock another process holds. The settings cards read it and
--     say, in words, why a queued run has not started.
--
--  3. sync_due takes a provider. Each sync job asked for the first 25 due
--     connections of ANY provider and kept its own; ordered by failures, a
--     provider that had failed a few times could be pushed off the list by
--     others and never be due as far as its own job could see.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- When a run was asked for, separate from when it started.
-- -----------------------------------------------------------------------------
ALTER TABLE integration_sync_run ADD COLUMN IF NOT EXISTS requested_at timestamptz;
-- Set after the column exists, so existing rows stay NULL rather than all
-- taking this migration's time.
ALTER TABLE integration_sync_run ALTER COLUMN requested_at SET DEFAULT now();

-- -----------------------------------------------------------------------------
-- Worker heartbeat. Not tenant data: one row per worker process.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS helm_worker_heartbeat (
  instance    text PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  seen_at     timestamptz NOT NULL DEFAULT now(),
  -- { "<job name>": "<started ISO time>" } for jobs running right now.
  running     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- { "<job name>": "<first skipped ISO time>" } for jobs skipped because
  -- another process holds their advisory lock.
  locked_out  jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT worker_heartbeat_running_object CHECK (jsonb_typeof(running) = 'object'),
  CONSTRAINT worker_heartbeat_locked_object CHECK (jsonb_typeof(locked_out) = 'object')
);

REVOKE ALL ON helm_worker_heartbeat FROM PUBLIC, helm_app, helm_auth, helm_worker, helm_key_admin, helm_auditor;

CREATE OR REPLACE FUNCTION helm.record_worker_heartbeat(
  p_instance   text,
  p_started_at timestamptz,
  p_running    jsonb DEFAULT '{}'::jsonb,
  p_locked_out jsonb DEFAULT '{}'::jsonb
) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
  INSERT INTO helm_worker_heartbeat (instance, started_at, seen_at, running, locked_out)
  VALUES (left(p_instance, 200), p_started_at, now(),
          coalesce(p_running, '{}'::jsonb), coalesce(p_locked_out, '{}'::jsonb))
  ON CONFLICT (instance) DO UPDATE
    SET started_at = EXCLUDED.started_at, seen_at = EXCLUDED.seen_at,
        running = EXCLUDED.running, locked_out = EXCLUDED.locked_out;
  -- Processes that went away (a restart gets a new pid) are kept a day, long
  -- enough to read, then dropped.
  DELETE FROM helm_worker_heartbeat WHERE seen_at < now() - interval '1 day';
$$;

/**
 * The most recently seen worker, for the settings cards. Nothing tenant
 * specific: when it last checked in, since when it has been up, what it is
 * running. Any signed-in person who can see an integration card may read it.
 */
CREATE OR REPLACE FUNCTION helm.worker_liveness()
  RETURNS TABLE (instance text, started_at timestamptz, seen_at timestamptz,
                 running jsonb, locked_out jsonb, now timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT h.instance, h.started_at, h.seen_at, h.running, h.locked_out, now()
  FROM helm_worker_heartbeat h
  ORDER BY h.seen_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION helm.record_worker_heartbeat(text, timestamptz, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.worker_liveness() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.record_worker_heartbeat(text, timestamptz, jsonb, jsonb) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.worker_liveness() TO helm_app;

-- -----------------------------------------------------------------------------
-- helm.queue_manual_sync_run — the row Sync now leaves behind. Internal: only
-- the request_*_sync functions below call it, after their own permission check.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.queue_manual_sync_run(p_tenant uuid, p_connection_id uuid)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  -- A queued run nobody picked up in an hour is closed with the reason, so a
  -- fresh Sync now is not hidden behind it and the history says what happened.
  UPDATE integration_sync_run
  SET status = 'cancelled', finished_at = now(),
      error_summary = 'Not started: Helm''s background worker did not pick this up within an hour.'
  WHERE connection_id = p_connection_id AND tenant_id = p_tenant
    AND status = 'queued' AND coalesce(requested_at, now()) < now() - interval '1 hour';

  INSERT INTO integration_sync_run (tenant_id, connection_id, status, trigger_source, requested_at)
  VALUES (p_tenant, p_connection_id, 'queued', 'manual', now())
  ON CONFLICT (connection_id) WHERE status IN ('queued', 'running') DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION helm.queue_manual_sync_run(uuid, uuid) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- The four Sync now functions, as before plus the queued row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.request_ninja_sync() RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_id     uuid;
BEGIN
  IF NOT helm.has_permission('integration:rmm:manage') THEN
    RAISE EXCEPTION 'helm: running a NinjaOne sync requires integration:rmm:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE integration_connection SET last_sync_at = NULL
  WHERE tenant_id = v_tenant AND provider = 'ninja_one' AND sync_enabled AND disabled_at IS NULL
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RETURN false; END IF;

  PERFORM helm.queue_manual_sync_run(v_tenant, v_id);
  PERFORM helm.audit('integration.rmm_sync_requested', 'integration_connection', v_id, 'success');
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION helm.request_action1_sync() RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_id     uuid;
BEGIN
  IF NOT helm.has_permission('integration:rmm:manage') THEN
    RAISE EXCEPTION 'helm: running an Action1 sync requires integration:rmm:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE integration_connection SET last_sync_at = NULL
  WHERE tenant_id = v_tenant AND provider = 'action1' AND sync_enabled AND disabled_at IS NULL
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RETURN false; END IF;

  PERFORM helm.queue_manual_sync_run(v_tenant, v_id);
  PERFORM helm.audit('integration.rmm_sync_requested', 'integration_connection', v_id, 'success');
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION helm.request_m365_sync(p_connection_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_org    uuid;
BEGIN
  IF NOT helm.has_permission('integration:m365:manage') THEN
    RAISE EXCEPTION 'helm: running a Microsoft 365 sync requires integration:m365:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE integration_connection SET last_sync_at = NULL
  WHERE id = p_connection_id AND tenant_id = v_tenant AND provider = 'microsoft_graph'
    AND sync_enabled AND disabled_at IS NULL
  RETURNING organization_id INTO v_org;
  IF v_org IS NULL THEN RETURN false; END IF;

  PERFORM helm.queue_manual_sync_run(v_tenant, p_connection_id);
  PERFORM helm.audit('integration.m365_sync_requested', 'integration_connection', p_connection_id,
                     'success', v_org);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION helm.request_proxmox_sync(p_connection_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_org    uuid;
BEGIN
  IF NOT helm.has_permission('integration:hypervisor:manage') THEN
    RAISE EXCEPTION 'helm: running a Proxmox sync requires integration:hypervisor:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE integration_connection SET last_sync_at = NULL
  WHERE id = p_connection_id AND tenant_id = v_tenant AND provider = 'proxmox'
    AND sync_enabled AND disabled_at IS NULL
  RETURNING organization_id INTO v_org;
  IF v_org IS NULL THEN RETURN false; END IF;

  PERFORM helm.queue_manual_sync_run(v_tenant, p_connection_id);
  PERFORM helm.audit('integration.hypervisor_sync_requested', 'integration_connection', p_connection_id,
                     'success', v_org);
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- sync_due, per provider. Only a RUNNING run blocks a connection now: a queued
-- one is exactly what makes it due, and begin_sync_run takes it over.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS helm.sync_due(integer);

CREATE FUNCTION helm.sync_due(p_limit integer DEFAULT 50, p_provider integration_provider DEFAULT NULL)
  RETURNS TABLE (
    tenant_id       uuid,
    worker_actor_id uuid,
    connection_id   uuid,
    provider        integration_provider,
    display_name    text,
    organization_id uuid,
    direction       sync_direction,
    last_sync_at    timestamptz,
    consecutive_failures integer,
    due_since       timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT
    c.tenant_id, helm.worker_actor(c.tenant_id, 'system_sync'),
    c.id, c.provider, c.display_name, c.organization_id, c.direction,
    c.last_sync_at, c.consecutive_failures,
    coalesce(
      c.last_sync_at
        + make_interval(mins => c.sync_interval_minutes
                                * least(2 ^ least(c.consecutive_failures, 5), 32)::integer),
      c.created_at)
  FROM integration_connection c
  JOIN tenant t ON t.id = c.tenant_id AND t.status = 'active'
  WHERE c.sync_enabled
    AND c.disabled_at IS NULL
    AND c.status <> 'disabled'
    AND (p_provider IS NULL OR c.provider = p_provider)
    AND (c.last_sync_at IS NULL
         OR now() >= c.last_sync_at
                     + make_interval(mins => c.sync_interval_minutes
                                             * least(2 ^ least(c.consecutive_failures, 5), 32)::integer))
    -- A run still open after 2 hours was cut short (1260); begin_sync_run
    -- closes it.
    AND NOT EXISTS (
      SELECT 1 FROM integration_sync_run r
      WHERE r.connection_id = c.id AND r.status = 'running'
        AND coalesce(r.started_at, now()) > now() - interval '2 hours'
    )
    AND helm.worker_actor(c.tenant_id, 'system_sync') IS NOT NULL
  ORDER BY c.consecutive_failures, coalesce(c.last_sync_at, c.created_at)
  LIMIT greatest(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION helm.sync_due(integer, integration_provider) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.sync_due(integer, integration_provider) TO helm_worker;

-- -----------------------------------------------------------------------------
-- begin_sync_run takes over a queued run rather than colliding with it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.begin_sync_run(
  p_connection_id  uuid,
  p_trigger_source text DEFAULT 'schedule'
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_cursor text;
  v_run    uuid;
  v_trigger text;
BEGIN
  SELECT sync_cursor INTO v_cursor
  FROM integration_connection
  WHERE id = p_connection_id AND tenant_id = v_tenant;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: no such integration connection %', p_connection_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Close a run that was cut short so the new one can start; see sync_due.
  UPDATE integration_sync_run
  SET status = 'failed', finished_at = greatest(now(), started_at),
      error_summary = 'Interrupted: Helm stopped before this run finished (a restart or update during the sync).'
  WHERE connection_id = p_connection_id AND tenant_id = v_tenant
    AND status = 'running'
    AND coalesce(started_at, now()) <= now() - interval '2 hours';

  -- Somebody pressed Sync now: this run is that one.
  UPDATE integration_sync_run
  SET status = 'running', started_at = now(), cursor_before = v_cursor
  WHERE connection_id = p_connection_id AND tenant_id = v_tenant AND status = 'queued'
  RETURNING id, trigger_source INTO v_run, v_trigger;

  IF v_run IS NULL THEN
    v_trigger := p_trigger_source;
    INSERT INTO integration_sync_run (tenant_id, connection_id, status, trigger_source,
                                      requested_at, started_at, cursor_before)
    VALUES (v_tenant, p_connection_id, 'running', p_trigger_source, now(), now(), v_cursor)
    ON CONFLICT (connection_id) WHERE status IN ('queued', 'running') DO NOTHING
    RETURNING id INTO v_run;
  END IF;

  IF v_run IS NOT NULL THEN
    PERFORM helm.audit('integration.sync_started', 'integration_connection', p_connection_id,
                       'success', NULL, NULL, NULL,
                       jsonb_build_object('run_id', v_run, 'trigger', v_trigger));
  END IF;

  RETURN v_run;
END;
$$;
