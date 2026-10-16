-- 0770_sop_schedules.sql — a checklist that raises itself
--
-- 0090 modelled procedures, published versions and runs; F1 gave the product a
-- way to start a run; 0650 gave a run an assignee and a due date; 0690 and
-- 0700 built the reminders. What was still missing is the thing MSPs actually
-- use checklists for: the monthly patch round, the quarterly access review,
-- the annual DR test — work that has to happen on a date nobody is looking at.
-- src/lib/nav/org-categories.ts has said so since D: "what is still missing is
-- the recurring part: something that raises a run on a schedule".
--
-- A SCHEDULE IS A ROW, NOT A CRON LINE. Every N days from a chosen first date,
-- optionally with an assignee and a due date relative to the slot. The worker
-- raises a run for each slot that has arrived and moves the schedule forward
-- by whole intervals from the SLOT, not from "now", so a schedule set for the
-- first of the month stays on the first. A worker that was down for a month
-- raises ONE run, not four: missed slots are skipped, because four identical
-- overdue runs on a Monday morning are the thing that teaches people to
-- ignore the queue.
--
-- THE RUN IS AN ORDINARY RUN. Same table, same steps, same reminders, same
-- page. It is started by the scheduling worker identity rather than by a
-- person, which the audit row says.
--
-- THE SCHEDULE BELONGS TO THE PROCEDURE'S ORGANISATION, copied onto the row
-- by a trigger so RLS can scope it the way it scopes everything else that
-- belongs to a client, and so a caller cannot point a schedule at a procedure
-- from one organisation and file the runs under another.

CREATE TABLE sop_schedule (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,
  sop_id           uuid NOT NULL,
  site_id          uuid,
  assigned_to      uuid,

  -- Every this many days from the first slot.
  interval_days    integer NOT NULL,
  -- The next slot. Advanced by the worker, never set to "now".
  next_run_at      timestamptz NOT NULL,
  -- The run's due date, this many days after its slot. NULL: no due date.
  due_after_days   integer,
  -- Overrides the procedure's name as the run title's first half.
  title            text,

  enabled          boolean NOT NULL DEFAULT true,
  last_raised_at   timestamptz,
  last_run_id      uuid REFERENCES sop_run(id) ON DELETE SET NULL,
  -- Why the last slot raised nothing, if it did not: an unpublished or
  -- archived procedure. Cleared by the next successful slot.
  last_error       text,

  created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sop_schedule_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT sop_schedule_sop_fk FOREIGN KEY (sop_id, tenant_id)
    REFERENCES sop (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT sop_schedule_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT sop_schedule_site_fk FOREIGN KEY (site_id, tenant_id)
    REFERENCES site (id, tenant_id) ON DELETE SET NULL (site_id),
  -- The same composite key 0650 uses: an assignee is a member of this tenant,
  -- and a membership that ends takes the assignment with it.
  CONSTRAINT sop_schedule_assignee_fk FOREIGN KEY (tenant_id, assigned_to)
    REFERENCES membership (tenant_id, user_id) ON DELETE SET NULL (assigned_to),
  CONSTRAINT sop_schedule_interval_sane CHECK (interval_days BETWEEN 1 AND 366),
  CONSTRAINT sop_schedule_due_sane CHECK (due_after_days IS NULL OR due_after_days BETWEEN 0 AND 366),
  CONSTRAINT sop_schedule_title_length CHECK (title IS NULL OR length(title) BETWEEN 1 AND 200)
);

CREATE INDEX sop_schedule_due_idx ON sop_schedule (tenant_id, next_run_at) WHERE enabled;
CREATE INDEX sop_schedule_sop_idx ON sop_schedule (tenant_id, sop_id);

COMMENT ON TABLE sop_schedule IS
  'A procedure that raises a run every interval_days from next_run_at. The '
  'worker advances the slot by whole intervals and skips missed ones.';

-- -----------------------------------------------------------------------------
-- The organisation is the procedure's, always.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.sop_schedule_bind_organization() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT n.organization_id INTO v_org
  FROM asset_node n
  WHERE n.id = NEW.sop_id AND n.tenant_id = NEW.tenant_id AND n.node_type = 'sop';
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'helm: no such procedure' USING ERRCODE = 'no_data_found';
  END IF;
  NEW.organization_id := v_org;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER sop_schedule_bind_organization
  BEFORE INSERT OR UPDATE ON sop_schedule
  FOR EACH ROW EXECUTE FUNCTION helm.sop_schedule_bind_organization();

-- Scoped like a run: visible to whoever can see the client, writable from
-- rank 40 (tier1 and up). The route additionally asks for sop:execute, since a
-- schedule is a run started in advance.
SELECT helm.apply_tenant_rls('sop_schedule', true, 40, NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON sop_schedule TO helm_app;
GRANT SELECT ON sop_schedule TO helm_auditor;

-- -----------------------------------------------------------------------------
-- Which tenants have a slot that has arrived. Worker-only, cross-tenant, and
-- it names the identity the raise runs as — the same construction as
-- helm.alert_backlog(). system_sync because it is the worker role that writes
-- assets and runs; nothing here reveals a secret.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.schedule_backlog(p_limit integer DEFAULT 25)
  RETURNS TABLE (tenant_id uuid, tenant_name text, worker_actor_id uuid, due bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT t.id, t.name, helm.worker_actor(t.id, 'system_sync'), count(*)
  FROM tenant t
  JOIN sop_schedule s ON s.tenant_id = t.id AND s.enabled AND s.next_run_at <= now()
  WHERE t.status = 'active'
  GROUP BY t.id, t.name
  HAVING helm.worker_actor(t.id, 'system_sync') IS NOT NULL
  ORDER BY t.name
  LIMIT greatest(p_limit, 1);
$$;

-- -----------------------------------------------------------------------------
-- Raise the runs whose slot has arrived, inside the current tenant context.
--
-- One row per schedule considered: 'raised' with the run, or 'skipped' with
-- the reason stored on the schedule. A skipped slot still advances, so a
-- procedure that is never published does not pile up a backlog that floods
-- the queue the day it is.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.raise_scheduled_runs(p_limit integer DEFAULT 100)
  RETURNS TABLE (schedule_id uuid, run_id uuid, outcome text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant   uuid := helm.require_tenant_id();
  v_s        sop_schedule%ROWTYPE;
  v_version  record;
  v_assignee uuid;
  v_due      timestamptz;
  v_title    text;
  v_run      uuid;
  v_steps    integer;
  v_next     timestamptz;
BEGIN
  FOR v_s IN
    SELECT * FROM sop_schedule s
    WHERE s.tenant_id = v_tenant AND s.enabled AND s.next_run_at <= now()
    ORDER BY s.next_run_at
    LIMIT greatest(p_limit, 1)
    FOR UPDATE SKIP LOCKED
  LOOP
    -- Advance first, from the slot and by whole intervals, past every slot
    -- that has already gone. Whatever happens below, this slot is dealt with.
    v_next := v_s.next_run_at;
    LOOP
      v_next := v_next + make_interval(days => v_s.interval_days);
      EXIT WHEN v_next > now();
    END LOOP;

    SELECT v.id, v.version, v.snapshot, n.name INTO v_version
    FROM sop p
    JOIN asset_node n ON n.id = p.id
    JOIN sop_version v ON v.sop_id = p.id AND v.version = p.current_version
    WHERE p.id = v_s.sop_id AND n.archived_at IS NULL;

    IF NOT FOUND THEN
      UPDATE sop_schedule
      SET next_run_at = v_next,
          last_error = 'the procedure has no published version, or is archived',
          updated_at = now()
      WHERE id = v_s.id;
      schedule_id := v_s.id; run_id := NULL; outcome := 'skipped';
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- An assignee who has since left is dropped rather than failing the slot:
    -- the run is still due, somebody will pick it up from the client's page.
    SELECT v_s.assigned_to INTO v_assignee
    WHERE v_s.assigned_to IS NOT NULL AND EXISTS (
      SELECT 1 FROM membership m
      WHERE m.tenant_id = v_tenant AND m.user_id = v_s.assigned_to
        AND m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > now())
    );
    v_due := CASE WHEN v_s.due_after_days IS NOT NULL
                  THEN v_s.next_run_at + make_interval(days => v_s.due_after_days) END;
    v_title := coalesce(v_s.title, v_version.name) || ' — ' || to_char(v_s.next_run_at, 'YYYY-MM-DD');

    INSERT INTO sop_run (
      tenant_id, organization_id, site_id, sop_id, sop_version_id,
      title, status, started_at, assigned_to, due_at
    ) VALUES (
      v_tenant, v_s.organization_id, v_s.site_id, v_s.sop_id, v_version.id,
      v_title, 'in_progress', now(), v_assignee, v_due
    )
    RETURNING id INTO v_run;

    -- The steps, from the published snapshot — the same shape
    -- stepsFromSnapshot() reads in src/lib/sops/steps.ts.
    INSERT INTO sop_run_step (
      tenant_id, run_id, position, title, body, kind, status, assigned_to, due_at
    )
    SELECT v_tenant, v_run,
           coalesce(nullif(e->>'position', '')::integer, ord::integer),
           e->>'title', nullif(e->>'body', ''), 'manual', 'pending', v_assignee, v_due
    FROM jsonb_array_elements(coalesce(v_version.snapshot->'steps', '[]'::jsonb))
         WITH ORDINALITY AS t(e, ord)
    WHERE coalesce(e->>'title', '') <> '';
    GET DIAGNOSTICS v_steps = ROW_COUNT;

    IF v_steps = 0 THEN
      -- A published version always has steps; reaching here means a snapshot
      -- this function cannot read. Leave no empty run behind.
      DELETE FROM sop_run WHERE id = v_run;
      UPDATE sop_schedule
      SET next_run_at = v_next,
          last_error = format('version %s has no readable steps; publish it again', v_version.version),
          updated_at = now()
      WHERE id = v_s.id;
      schedule_id := v_s.id; run_id := NULL; outcome := 'skipped';
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- 0690's "you have been given this", per step, as the route does.
    IF v_assignee IS NOT NULL THEN
      PERFORM helm.raise_assignment_reminder(s.id) FROM sop_run_step s WHERE s.run_id = v_run;
    END IF;

    UPDATE sop_schedule
    SET next_run_at = v_next, last_raised_at = now(), last_run_id = v_run,
        last_error = NULL, updated_at = now()
    WHERE id = v_s.id;

    PERFORM helm.audit(
      'sop.run_scheduled', 'sop_run', v_run, 'success', v_s.organization_id, v_s.sop_id, NULL,
      jsonb_build_object(
        'scheduleId', v_s.id, 'title', v_title, 'slot', v_s.next_run_at,
        'assignedTo', v_assignee, 'dueAt', v_due, 'steps', v_steps
      )
    );

    schedule_id := v_s.id; run_id := v_run; outcome := 'raised';
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION helm.schedule_backlog(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.raise_scheduled_runs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.schedule_backlog(integer) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.raise_scheduled_runs(integer) TO helm_worker;

-- -----------------------------------------------------------------------------
-- Guard: a schedule is scoped, and the worker — not the request role — raises.
-- -----------------------------------------------------------------------------
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sop_schedule' AND policyname = 'sop_schedule_rls_select'
  ) THEN
    RAISE EXCEPTION 'helm: sop_schedule has no row-level security policy';
  END IF;
  IF has_function_privilege('helm_app', 'helm.raise_scheduled_runs(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app must not be able to raise scheduled runs; that is the worker''s job';
  END IF;
END
$guard$;
