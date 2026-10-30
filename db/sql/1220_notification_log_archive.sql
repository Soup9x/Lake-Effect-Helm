-- =============================================================================
-- 1220 — the notification delivery log can be archived and cleared
--
-- Administration → Email & notifications showed the last twenty deliveries in
-- full, every one, with no way to put away the ones somebody has already read.
-- A destination that goes dead for a weekend fills the page with the same red
-- row and nothing ever takes it off.
--
-- ARCHIVING HIDES, IT DOES NOT DELETE. archived_at takes a finished delivery
-- (delivered, failed or dead) out of the log and out of the destination's
-- "dead" count, so an administrator can acknowledge a bad night. A pending one
-- is still going to be sent and cannot be archived: hiding work in flight is
-- how a stuck queue goes unnoticed. Archived rows can be shown and restored.
--
-- DELETING IS FOR ARCHIVED ROWS ONLY, AND NOT THE NEWEST ONES. The row is what
-- makes (endpoint_id, event_uid) unique, and two senders lean on that to avoid
-- sending twice: task.assigned (one message per run per person) and the hourly
-- task.overdue sweep, which looks back a day. A row younger than two days is
-- kept even when asked, so clearing the log never re-sends a reminder. Older
-- task.assigned keys could in principle collide again if somebody reassigns a
-- step on a weeks-old run; that sends one more message, which is the right
-- way for that to fail.
--
-- All three writes need integration:manage, as editing a destination does, and
-- are audited with how many rows they touched.
-- =============================================================================

ALTER TABLE webhook_delivery ADD COLUMN archived_at timestamptz;

COMMENT ON COLUMN webhook_delivery.archived_at IS
  'When an administrator archived this finished delivery out of the log (1220). '
  'Archived rows can be restored, or deleted once they are two days old.';

-- -----------------------------------------------------------------------------
-- The log, one side of the archive at a time, newest first.
--
-- recent_notifications() (0420) capped at 200 and could not tell archived rows
-- apart. This returns up to 1000 of one side; the counts below say how many
-- there are in all, so the page can say when it is showing only the newest.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.notification_log(
  p_archived boolean DEFAULT false,
  p_limit    integer DEFAULT 500
)
  RETURNS TABLE (
    id uuid, endpoint_name text, event_type text, subject text,
    status webhook_delivery_status, attempts smallint, response_code integer,
    error text, created_at timestamptz, delivered_at timestamptz,
    archived_at timestamptz
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.is_tenant_wide() THEN
    RAISE EXCEPTION 'helm: notification history is not visible to a client-side role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT d.id, e.name, d.event_type, d.subject, d.status, d.attempts,
           d.response_code, d.error, d.created_at, d.delivered_at, d.archived_at
    FROM webhook_delivery d
    JOIN webhook_endpoint e ON e.id = d.endpoint_id
    WHERE d.tenant_id = v_tenant
      AND (d.archived_at IS NOT NULL) = coalesce(p_archived, false)
    ORDER BY d.created_at DESC
    LIMIT least(greatest(p_limit, 1), 1000);
END;
$$;

-- How many deliveries there are, by status and side of the archive.
CREATE OR REPLACE FUNCTION helm.notification_log_counts()
  RETURNS TABLE (status webhook_delivery_status, archived boolean, n bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.is_tenant_wide() THEN
    RAISE EXCEPTION 'helm: notification history is not visible to a client-side role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT d.status, d.archived_at IS NOT NULL, count(*)
    FROM webhook_delivery d
    WHERE d.tenant_id = v_tenant
    GROUP BY 1, 2;
END;
$$;

-- 0420's reader, kept for anything still calling it, now without archived rows.
CREATE OR REPLACE FUNCTION helm.recent_notifications(p_limit integer DEFAULT 20)
  RETURNS TABLE (
    id uuid, endpoint_name text, event_type text, subject text,
    status webhook_delivery_status, attempts smallint, response_code integer,
    error text, created_at timestamptz, delivered_at timestamptz
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT l.id, l.endpoint_name, l.event_type, l.subject, l.status, l.attempts,
           l.response_code, l.error, l.created_at, l.delivered_at
    FROM helm.notification_log(false, least(greatest(p_limit, 1), 200)) l;
END;
$$;

-- -----------------------------------------------------------------------------
-- Archiving: the listed deliveries, or (p_ids NULL) every finished one older
-- than p_older_than_days (0 means all of them). Returns how many were archived.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.archive_notifications(
  p_ids               uuid[]  DEFAULT NULL,
  p_older_than_days   integer DEFAULT 0
)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_rows   integer;
BEGIN
  IF NOT helm.has_permission('integration:manage') THEN
    RAISE EXCEPTION 'helm: archiving the notification log requires integration:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE webhook_delivery SET archived_at = now()
  WHERE tenant_id = v_tenant
    AND archived_at IS NULL
    AND status <> 'pending'
    AND (
      CASE WHEN p_ids IS NULL
        THEN created_at < now() - make_interval(days => greatest(coalesce(p_older_than_days, 0), 0))
        ELSE id = ANY (p_ids)
      END
    );
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows > 0 THEN
    PERFORM helm.audit(
      'notification.log_archived', 'webhook_delivery', NULL, 'success', NULL, NULL, NULL,
      jsonb_build_object('count', v_rows, 'selected', p_ids IS NOT NULL,
                         'older_than_days', CASE WHEN p_ids IS NULL THEN p_older_than_days END)
    );
  END IF;
  RETURN v_rows;
END;
$$;

-- Putting archived deliveries back in the log: the listed ones, or all of them.
CREATE OR REPLACE FUNCTION helm.restore_notifications(p_ids uuid[] DEFAULT NULL)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_rows   integer;
BEGIN
  IF NOT helm.has_permission('integration:manage') THEN
    RAISE EXCEPTION 'helm: restoring the notification log requires integration:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE webhook_delivery SET archived_at = NULL
  WHERE tenant_id = v_tenant
    AND archived_at IS NOT NULL
    AND (p_ids IS NULL OR id = ANY (p_ids));
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows > 0 THEN
    PERFORM helm.audit(
      'notification.log_restored', 'webhook_delivery', NULL, 'success', NULL, NULL, NULL,
      jsonb_build_object('count', v_rows, 'selected', p_ids IS NOT NULL)
    );
  END IF;
  RETURN v_rows;
END;
$$;

-- Deleting archived deliveries for good: the listed ones, or all of them, but
-- never one younger than two days (see the header).
CREATE OR REPLACE FUNCTION helm.delete_archived_notifications(p_ids uuid[] DEFAULT NULL)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_rows   integer;
BEGIN
  IF NOT helm.has_permission('integration:manage') THEN
    RAISE EXCEPTION 'helm: clearing the notification log requires integration:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM webhook_delivery
  WHERE tenant_id = v_tenant
    AND archived_at IS NOT NULL
    AND created_at < now() - interval '2 days'
    AND (p_ids IS NULL OR id = ANY (p_ids));
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows > 0 THEN
    PERFORM helm.audit(
      'notification.log_deleted', 'webhook_delivery', NULL, 'success', NULL, NULL, NULL,
      jsonb_build_object('count', v_rows, 'selected', p_ids IS NOT NULL)
    );
  END IF;
  RETURN v_rows;
END;
$$;

-- -----------------------------------------------------------------------------
-- The destinations list: 0690's function, with archived dead deliveries left
-- out of the "dead" count. Archiving them is how somebody says "seen it".
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.webhook_endpoints()
  RETURNS TABLE (
    id uuid, name text, format webhook_format, is_active boolean,
    transport notification_transport, email_address text,
    organization_id uuid, organization_name text, events text[],
    url_host text, url_digest text, signing_secret_set boolean,
    max_attempts smallint, timeout_ms integer,
    last_delivery_at timestamptz, last_delivery_ok boolean,
    last_delivery_error text, consecutive_failures integer,
    pending_count bigint, dead_count bigint, updated_at timestamptz
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.is_tenant_wide() THEN
    RAISE EXCEPTION 'helm: notification settings are not visible to a client-side role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT e.id, e.name, e.format, e.is_active,
           e.transport, e.email_address::text,
           e.organization_id, o.name, e.events,
           e.url_host, e.url_digest, e.signing_secret_set,
           e.max_attempts, e.timeout_ms,
           e.last_delivery_at, e.last_delivery_ok,
           e.last_delivery_error, e.consecutive_failures,
           count(d.id) FILTER (WHERE d.status = 'pending'),
           count(d.id) FILTER (WHERE d.status = 'dead' AND d.archived_at IS NULL),
           e.updated_at
    FROM webhook_endpoint e
    LEFT JOIN organization o ON o.id = e.organization_id AND o.tenant_id = v_tenant
    LEFT JOIN webhook_delivery d
      ON d.endpoint_id = e.id AND d.created_at > now() - interval '7 days'
    WHERE e.tenant_id = v_tenant
    GROUP BY e.id, o.name
    ORDER BY e.name;
END;
$$;

REVOKE ALL ON FUNCTION helm.notification_log(boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.notification_log_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.archive_notifications(uuid[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.restore_notifications(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.delete_archived_notifications(uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.notification_log(boolean, integer) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.notification_log_counts() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.archive_notifications(uuid[], integer) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.restore_notifications(uuid[]) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.delete_archived_notifications(uuid[]) TO helm_app;
