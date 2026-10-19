-- =============================================================================
-- 0870 — checklist work in team channels: task.assigned and task.overdue
--
-- A step assigned to somebody, and a step reaching its due date undone, were
-- told only to that person — the bell and their own email (0690, 0700). A team
-- channel in Teams, Discord or Slack could hear about exports, reveals and
-- expiries but not about the work itself. These two events close that gap,
-- through the queue every other notification uses: one delivery per subscribed
-- destination, the same retry and backoff, the same payload allow-list.
--
-- INDEPENDENT OF ANYBODY'S PERSONAL PREFERENCES. A person turning off their
-- own "task due" email is not a decision about what the team channel hears, so
-- neither event reads user_notification_preference or task_reminder.
--
--   task.assigned  raised by a trigger on sop_run_step when a step gains an
--                  assignee. ONE PER RUN PER PERSON: starting a twelve-step
--                  offboarding for Sam is one message, not twelve. The event
--                  id is derived from the run and the person, and the queue's
--                  (endpoint, event_uid) key absorbs the other eleven.
--   task.overdue   raised by the hourly reminder sweep for a pending step on a
--                  live run whose due time has passed — once per step and due
--                  date. Only steps that fell due in the last day: a channel
--                  added today should not receive every deadline missed since
--                  the product was installed.
--
-- WHY A FUNCTION OF ITS OWN TO QUEUE. helm.enqueue_notification() takes the
-- tenant from the session, and the sweep crosses tenants with none set. This
-- is the same insert with the tenant passed in, and it is reachable only from
-- the two SECURITY DEFINER callers below.
-- =============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION helm.notification_events() RETURNS text[]
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT ARRAY[
    'export.requested',
    'export.rendered',
    'export.downloaded',
    'export.revoked',
    'secret.revealed',
    'access.denied',
    'expiration.warning',
    'integration.failed',
    'key.rotated',
    -- 0870: checklist work, for team channels.
    'task.assigned',
    'task.overdue'
  ]::text[];
$$;

CREATE OR REPLACE FUNCTION helm.notification_payload(p_event text, p_metadata jsonb)
  RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT coalesce(
    jsonb_object_agg(k, p_metadata -> k) FILTER (WHERE p_metadata ? k),
    '{}'::jsonb)
  FROM unnest(
    CASE p_event
      WHEN 'export.requested' THEN
        ARRAY['kind', 'format', 'include_secrets', 'expires_in_hours']
      WHEN 'export.rendered' THEN
        ARRAY['record_count', 'secret_count', 'byte_size', 'omissions', 'encryption_method']
      WHEN 'export.downloaded' THEN
        ARRAY['download_number', 'byte_size']
      WHEN 'export.revoked' THEN
        ARRAY['previous_status', 'downloads']
      WHEN 'secret.revealed' THEN
        ARRAY['purpose', 'sensitivity', 'label', 'version', 'step_up']
      WHEN 'access.denied' THEN
        ARRAY['cause', 'purpose', 'sensitivity', 'required_rank', 'actor_rank']
      WHEN 'integration.failed' THEN
        ARRAY['provider', 'error', 'consecutive_failures']
      WHEN 'key.rotated' THEN
        ARRAY['generation', 'data_key_id', 'wrap_provider']
      WHEN 'expiration.warning' THEN
        ARRAY['kind', 'label', 'days_remaining', 'severity', 'expires_at']
      -- Names and a date: what the work is and who has it. Never a step's
      -- note, which is free text somebody may have pasted anything into.
      WHEN 'task.assigned' THEN
        ARRAY['run', 'procedure', 'step', 'assignee', 'due_at']
      WHEN 'task.overdue' THEN
        ARRAY['run', 'procedure', 'step', 'assignee', 'due_at']
      ELSE ARRAY[]::text[]
    END
  ) AS k;
$$;

CREATE OR REPLACE FUNCTION helm.notification_subject(
  p_event   text,
  p_actor   text,
  p_org     text,
  p_payload jsonb
) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT CASE p_event
    WHEN 'export.requested' THEN
      format('%s requested a%s export for %s',
             p_actor,
             CASE WHEN p_payload ->> 'include_secrets' = 'true'
                  THEN ' CREDENTIAL-BEARING' ELSE 'n' END,
             coalesce(p_org, 'the tenant'))
    WHEN 'export.rendered' THEN
      format('An export for %s finished: %s records, %s credentials',
             coalesce(p_org, 'the tenant'),
             coalesce(p_payload ->> 'record_count', '0'),
             coalesce(p_payload ->> 'secret_count', '0'))
    WHEN 'export.downloaded' THEN
      format('%s downloaded an export for %s (download #%s)',
             p_actor, coalesce(p_org, 'the tenant'),
             coalesce(p_payload ->> 'download_number', '1'))
    WHEN 'export.revoked' THEN
      format('%s revoked an export for %s', p_actor, coalesce(p_org, 'the tenant'))
    WHEN 'secret.revealed' THEN
      format('%s revealed %s (%s) for %s',
             p_actor,
             coalesce(p_payload ->> 'label', 'a credential'),
             coalesce(p_payload ->> 'sensitivity', 'standard'),
             coalesce(p_payload ->> 'purpose', 'view'))
    WHEN 'access.denied' THEN
      format('%s was refused: %s',
             p_actor, coalesce(p_payload ->> 'cause', 'not permitted'))
    WHEN 'integration.failed' THEN
      format('The %s sync for %s is failing',
             coalesce(p_payload ->> 'provider', 'integration'),
             coalesce(p_org, 'the tenant'))
    WHEN 'key.rotated' THEN
      format('%s moved a tenant encryption key', p_actor)
    WHEN 'expiration.warning' THEN
      format('%s: %s %s',
             coalesce(p_org, 'the tenant'),
             coalesce(p_payload ->> 'label', 'an item'),
             CASE
               WHEN (p_payload ->> 'days_remaining')::int < 0
                 THEN format('expired %s day(s) ago', abs((p_payload ->> 'days_remaining')::int))
               WHEN (p_payload ->> 'days_remaining')::int = 0 THEN 'expires today'
               ELSE format('expires in %s day(s)', p_payload ->> 'days_remaining')
             END)
    WHEN 'task.assigned' THEN
      format('%s: %s was assigned work on “%s”',
             coalesce(p_org, 'the tenant'),
             coalesce(p_payload ->> 'assignee', 'somebody'),
             coalesce(p_payload ->> 'run', 'a checklist'))
    WHEN 'task.overdue' THEN
      format('%s: “%s” is overdue on “%s” (%s)',
             coalesce(p_org, 'the tenant'),
             coalesce(p_payload ->> 'step', 'a step'),
             coalesce(p_payload ->> 'run', 'a checklist'),
             coalesce(p_payload ->> 'assignee', 'unassigned'))
    ELSE format('%s: %s', p_event, p_actor)
  END;
$$;

-- -----------------------------------------------------------------------------
-- Queue one event for one tenant, the tenant passed in rather than read from
-- the session. Not granted to anybody: only the two callers below reach it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.enqueue_task_event(
  p_tenant          uuid,
  p_event           text,
  p_source_uid      uuid,
  p_organization_id uuid,
  p_payload         jsonb
) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_payload jsonb := helm.notification_payload(p_event, coalesce(p_payload, '{}'::jsonb));
  v_org     text;
  v_rows    integer;
BEGIN
  IF p_event NOT IN ('task.assigned', 'task.overdue') THEN
    RAISE EXCEPTION 'helm: % is not a task event', p_event USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT o.name INTO v_org FROM organization o
  WHERE o.id = p_organization_id AND o.tenant_id = p_tenant;

  INSERT INTO webhook_delivery (
    tenant_id, endpoint_id, event_type, event_uid, organization_id, subject, payload)
  SELECT p_tenant, e.id, p_event, p_source_uid, p_organization_id,
         helm.notification_subject(p_event, 'Helm', v_org, v_payload), v_payload
  FROM webhook_endpoint e
  WHERE e.tenant_id = p_tenant
    AND e.is_active AND p_event = ANY (e.events)
    AND (e.organization_id IS NULL OR e.organization_id = p_organization_id)
  ON CONFLICT (endpoint_id, event_uid) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION helm.enqueue_task_event(uuid, text, uuid, uuid, jsonb) FROM PUBLIC;

-- What both events say about a step, in one place.
CREATE OR REPLACE FUNCTION helm.task_event_payload(p_step_id uuid)
  RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'run', r.title,
    'procedure', n.name,
    'step', s.title,
    'assignee', coalesce(u.name, u.email::text),
    'due_at', s.due_at)
  FROM sop_run_step s
  JOIN sop_run r ON r.id = s.run_id AND r.tenant_id = s.tenant_id
  JOIN asset_node n ON n.id = r.sop_id
  LEFT JOIN app_user u ON u.id = s.assigned_to
  WHERE s.id = p_step_id;
$$;

REVOKE ALL ON FUNCTION helm.task_event_payload(uuid) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- task.assigned: a step gains an assignee.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.task_assigned_event() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF NEW.assigned_to IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.assigned_to IS NOT DISTINCT FROM NEW.assigned_to THEN
    RETURN NEW;
  END IF;

  SELECT r.organization_id INTO v_org FROM sop_run r
  WHERE r.id = NEW.run_id AND r.tenant_id = NEW.tenant_id;

  PERFORM helm.enqueue_task_event(
    NEW.tenant_id, 'task.assigned',
    -- One per run per person: the other steps of the same run collide here.
    md5('task.assigned:' || NEW.run_id::text || ':' || NEW.assigned_to::text)::uuid,
    v_org,
    helm.task_event_payload(NEW.id));
  RETURN NEW;
END;
$$;

CREATE TRIGGER sop_run_step_assigned_event
  AFTER INSERT OR UPDATE OF assigned_to ON sop_run_step
  FOR EACH ROW EXECUTE FUNCTION helm.task_assigned_event();

-- -----------------------------------------------------------------------------
-- task.overdue: the hourly sweep. Returns how many deliveries it queued.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.raise_task_channel_events(p_limit integer DEFAULT 500)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  r       record;
  v_total integer := 0;
BEGIN
  FOR r IN
    SELECT s.id, s.tenant_id, s.due_at, run.organization_id
    FROM sop_run_step s
    JOIN sop_run run ON run.id = s.run_id AND run.tenant_id = s.tenant_id
    WHERE s.status = 'pending'
      AND s.due_at IS NOT NULL
      AND s.due_at <= now()
      AND s.due_at > now() - interval '1 day'
      AND run.status IN ('in_progress', 'blocked')
      -- Only where somebody is listening, so an idle tenant costs nothing.
      AND EXISTS (
        SELECT 1 FROM webhook_endpoint e
        WHERE e.tenant_id = s.tenant_id AND e.is_active AND 'task.overdue' = ANY (e.events))
    ORDER BY s.due_at
    LIMIT greatest(p_limit, 1)
  LOOP
    v_total := v_total + helm.enqueue_task_event(
      r.tenant_id, 'task.overdue',
      md5('task.overdue:' || r.id::text || ':' || r.due_at::text)::uuid,
      r.organization_id,
      helm.task_event_payload(r.id));
  END LOOP;
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION helm.raise_task_channel_events(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.raise_task_channel_events(integer) TO helm_worker;
