-- =============================================================================
-- 0820  Built-in backups: a schedule, a destination, and a record of each run
-- =============================================================================
--
-- The install guide has a nightly script you run from cron by hand. Nothing in
-- Helm knew whether it ran. This gives the instance a backup schedule of its
-- own, a destination chosen in Settings, and a row per run — so the Settings
-- page can say "last backup 02:03 today, 412 MB, verified Sunday" or, more
-- usefully, "no successful backup for three days".
--
-- INSTANCE-WIDE, NOT PER TENANT. A dump is of the whole database; there is one
-- schedule and one destination. Neither table carries tenant_id, so the RLS
-- builder does not apply; instead NO role but the owner may touch them, and
-- the application reaches them only through the SECURITY DEFINER functions
-- below, each of which requires tenant:write in the calling session. The
-- backup service itself connects as the migrator (superuser) and reads and
-- writes the tables directly — the same credential that already runs pg_dump.
--
-- WHAT IS NOT HERE: credentials for an object store, and the passphrase the
-- archives are encrypted with. Both stay in .env and the secrets directory,
-- where the master key already lives; a destination's bucket and prefix are
-- settings, its keys are not. And the master key itself is never included in
-- a backup, which §7.1 of the install guide explains.
-- =============================================================================

CREATE TABLE backup_setting (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled          boolean NOT NULL DEFAULT false,
  -- Five-field cron, UTC. The service parses it; this only keeps it sane.
  schedule         text NOT NULL DEFAULT '0 2 * * *',
  destination_kind text NOT NULL DEFAULT 'local' CHECK (destination_kind IN ('local', 's3')),
  -- A directory under the mounted backup root. Relative, no '..'.
  local_subdir     text NOT NULL DEFAULT '',
  s3_bucket        text,
  s3_prefix        text NOT NULL DEFAULT 'helm',
  s3_endpoint      text,
  s3_region        text NOT NULL DEFAULT 'us-east-1',
  keep_days        integer NOT NULL DEFAULT 30 CHECK (keep_days BETWEEN 1 AND 3650),
  keep_count       integer NOT NULL DEFAULT 14 CHECK (keep_count BETWEEN 1 AND 1000),
  include_volumes  boolean NOT NULL DEFAULT true,
  -- 0 = Sunday … 6 = Saturday; NULL = never rehearse a restore.
  verify_weekday   smallint CHECK (verify_weekday IS NULL OR verify_weekday BETWEEN 0 AND 6) DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  CONSTRAINT backup_setting_schedule_ck CHECK (length(schedule) BETWEEN 9 AND 100),
  CONSTRAINT backup_setting_subdir_ck CHECK (local_subdir !~ '(^|/)\.\.(/|$)' AND local_subdir !~ '^/' AND length(local_subdir) <= 200),
  CONSTRAINT backup_setting_s3_ck CHECK (destination_kind <> 's3' OR (s3_bucket IS NOT NULL AND length(s3_bucket) BETWEEN 3 AND 63))
);
INSERT INTO backup_setting (id) VALUES (1);

CREATE TABLE backup_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('backup', 'verify')),
  trigger       text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'running', 'succeeded', 'failed')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  requested_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  started_at    timestamptz,
  finished_at   timestamptz,
  destination   text,
  location      text,
  bytes         bigint,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text
);
CREATE INDEX backup_run_recent_idx ON backup_run (requested_at DESC);
CREATE INDEX backup_run_open_idx ON backup_run (status) WHERE status IN ('requested', 'running');

COMMENT ON TABLE backup_setting IS 'The instance''s backup schedule and destination (0820). One row. Read and written through helm.backup_settings() and helm.set_backup_settings().';
COMMENT ON TABLE backup_run IS 'One row per backup or restore rehearsal (0820), written by the backup service; a manual run is requested here by helm.request_backup().';

-- Nobody but the owner. The functions below are the only door for the app.
REVOKE ALL ON backup_setting, backup_run FROM PUBLIC, helm_app, helm_auth, helm_worker, helm_key_admin, helm_auditor;

-- -----------------------------------------------------------------------------
-- The door: tenant:write, in a session.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.require_backup_admin() RETURNS void
  LANGUAGE plpgsql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM helm.require_tenant_id();
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: backups are managed by tenant administrators (tenant:write)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION helm.backup_settings()
  RETURNS backup_setting
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE v_row backup_setting;
BEGIN
  PERFORM helm.require_backup_admin();
  SELECT * INTO v_row FROM backup_setting WHERE id = 1;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION helm.set_backup_settings(p jsonb)
  RETURNS backup_setting
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_row backup_setting;
  v_before backup_setting;
BEGIN
  PERFORM helm.require_backup_admin();
  SELECT * INTO v_before FROM backup_setting WHERE id = 1;

  UPDATE backup_setting SET
    enabled          = coalesce((p->>'enabled')::boolean, enabled),
    schedule         = coalesce(nullif(trim(p->>'schedule'), ''), schedule),
    destination_kind = coalesce(p->>'destinationKind', destination_kind),
    local_subdir     = coalesce(trim(both '/' from p->>'localSubdir'), local_subdir),
    s3_bucket        = CASE WHEN p ? 's3Bucket' THEN nullif(trim(p->>'s3Bucket'), '') ELSE s3_bucket END,
    s3_prefix        = coalesce(trim(both '/' from p->>'s3Prefix'), s3_prefix),
    s3_endpoint      = CASE WHEN p ? 's3Endpoint' THEN nullif(trim(p->>'s3Endpoint'), '') ELSE s3_endpoint END,
    s3_region        = coalesce(nullif(trim(p->>'s3Region'), ''), s3_region),
    keep_days        = coalesce((p->>'keepDays')::integer, keep_days),
    keep_count       = coalesce((p->>'keepCount')::integer, keep_count),
    include_volumes  = coalesce((p->>'includeVolumes')::boolean, include_volumes),
    verify_weekday   = CASE WHEN p ? 'verifyWeekday' THEN (p->>'verifyWeekday')::smallint ELSE verify_weekday END,
    updated_at       = now(),
    updated_by       = helm.current_actor_id()
  WHERE id = 1
  RETURNING * INTO v_row;

  PERFORM helm.audit(
    'backup.settings_changed', 'backup_setting', NULL, 'success', NULL, NULL, NULL,
    jsonb_build_object(
      'enabled', v_row.enabled, 'schedule', v_row.schedule, 'destination', v_row.destination_kind,
      'localSubdir', v_row.local_subdir, 's3Bucket', v_row.s3_bucket, 's3Prefix', v_row.s3_prefix,
      'keepDays', v_row.keep_days, 'keepCount', v_row.keep_count,
      'wasEnabled', v_before.enabled));
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION helm.backup_runs(p_limit integer DEFAULT 20)
  RETURNS SETOF backup_run
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM helm.require_backup_admin();
  RETURN QUERY SELECT * FROM backup_run ORDER BY requested_at DESC LIMIT greatest(1, least(p_limit, 200));
END;
$$;

-- "Run now". One open request at a time: the service runs them one by one and
-- a second button press should not queue a second dump.
CREATE OR REPLACE FUNCTION helm.request_backup(p_kind text)
  RETURNS backup_run
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE v_row backup_run;
BEGIN
  PERFORM helm.require_backup_admin();
  IF p_kind NOT IN ('backup', 'verify') THEN
    RAISE EXCEPTION 'helm: a run is a backup or a verify' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM backup_run WHERE status IN ('requested', 'running')) THEN
    RAISE EXCEPTION 'helm: a backup run is already queued or running' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO backup_run (kind, trigger, requested_by)
  VALUES (p_kind, 'manual', helm.current_actor_id())
  RETURNING * INTO v_row;
  PERFORM helm.audit('backup.requested', 'backup_run', v_row.id, 'success', NULL, NULL, NULL,
                     jsonb_build_object('kind', p_kind));
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION helm.require_backup_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.backup_settings() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_backup_settings(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.backup_runs(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.request_backup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.require_backup_admin() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.backup_settings() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_backup_settings(jsonb) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.backup_runs(integer) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.request_backup(text) TO helm_app;

DO $$
BEGIN
  IF has_table_privilege('helm_app', 'backup_setting', 'SELECT')
     OR has_table_privilege('helm_app', 'backup_run', 'SELECT') THEN
    RAISE EXCEPTION '0820: helm_app can read a backup table directly';
  END IF;
  IF (SELECT count(*) FROM backup_setting) <> 1 THEN
    RAISE EXCEPTION '0820: backup_setting is not a singleton';
  END IF;
END $$;
