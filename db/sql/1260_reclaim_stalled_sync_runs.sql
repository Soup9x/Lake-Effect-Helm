-- =============================================================================
-- 1260 — Reclaim sync runs that were cut short
-- =============================================================================
--
-- A sync run is opened 'running' by begin_sync_run and closed by
-- finish_sync_run. If the worker stops in between (restarted by an update,
-- killed, out of memory), the run stays 'running' forever, and because
-- sync_due skips a connection with an open run, that integration never syncs
-- again: not on schedule, not on Sync now. Nothing said so.
--
-- Now a run open for more than 2 hours counts as cut short. sync_due no longer
-- lets it block the connection, and begin_sync_run marks it failed
-- ("Interrupted") before opening the next one. A live run that outlasts 2
-- hours still cannot be doubled: each sync job holds its advisory lock for as
-- long as it runs, and its late finish_sync_run changes nothing, since it only
-- closes a run that is still open.
-- =============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION helm.sync_due(p_limit integer DEFAULT 50)
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
    -- A connection that has never run is due NOW, not one interval from when it
    -- was configured. Making an administrator wait an hour to find out whether
    -- the credentials they just entered work is how integrations get abandoned
    -- half-configured.
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
    AND (c.last_sync_at IS NULL
         OR now() >= c.last_sync_at
                     + make_interval(mins => c.sync_interval_minutes
                                             * least(2 ^ least(c.consecutive_failures, 5), 32)::integer))
    -- A run still open after 2 hours was cut short (the worker restarted or
    -- died mid-sync) and will never finish; begin_sync_run closes it.
    AND NOT EXISTS (
      SELECT 1 FROM integration_sync_run r
      WHERE r.connection_id = c.id AND r.status IN ('queued', 'running')
        AND coalesce(r.started_at, now()) > now() - interval '2 hours'
    )
    AND helm.worker_actor(c.tenant_id, 'system_sync') IS NOT NULL
  ORDER BY c.consecutive_failures, coalesce(c.last_sync_at, c.created_at)
  LIMIT greatest(p_limit, 1);
$$;

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
    AND status IN ('queued', 'running')
    AND coalesce(started_at, now()) <= now() - interval '2 hours';

  INSERT INTO integration_sync_run (tenant_id, connection_id, status, trigger_source,
                                    started_at, cursor_before)
  VALUES (v_tenant, p_connection_id, 'running', p_trigger_source, now(), v_cursor)
  ON CONFLICT (connection_id) WHERE status IN ('queued', 'running') DO NOTHING
  RETURNING id INTO v_run;

  IF v_run IS NOT NULL THEN
    PERFORM helm.audit('integration.sync_started', 'integration_connection', p_connection_id,
                       'success', NULL, NULL, NULL,
                       jsonb_build_object('run_id', v_run, 'trigger', p_trigger_source));
  END IF;

  RETURN v_run;
END;
$$;
