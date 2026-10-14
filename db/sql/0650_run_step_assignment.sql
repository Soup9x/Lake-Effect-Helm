-- =============================================================================
-- 0650 — a run step can belong to somebody, and be due
--
-- F1 made checklists runnable; this makes them work somebody can be given. The
-- parity item is "tasks assigned to me", which needs two columns in two places
-- and one query nobody could write before.
--
-- WHY THE ASSIGNEE IS A COMPOSITE FK TO membership, NOT A PLAIN ONE TO app_user.
-- Every other person column in this schema — sop.owner_user_id,
-- sop_run_step.completed_by, secret.created_by — references app_user(id), and
-- that is right for them: they record who DID something, and the actor was by
-- definition present. An assignee is the opposite. It is a claim about the
-- future, and assigning a step to somebody with no membership in this tenant
-- creates work that nobody will ever see: their My Tasks reads through RLS,
-- which starts from the tenant.
--
-- membership already carries UNIQUE (tenant_id, user_id), so
--
--   FOREIGN KEY (tenant_id, assigned_to) REFERENCES membership (tenant_id, user_id)
--
-- is a plain composite key that makes invisible work unrepresentable. The route
-- checks for an ACTIVE membership, which this cannot express; the two together
-- mean a revoked colleague can still hold a task (correct — the work exists and
-- somebody must take it over) while a stranger cannot be handed one at all.
--
-- ON DELETE SET NULL (assigned_to) — THE COLUMN LIST IS LOAD-BEARING. The bare
-- form would null tenant_id along with the assignee, which is the exact defect
-- 0510 found in thirty constraints and fixed with Postgres 15's column list.
-- db/tests/security.sql §41(g) asserts no composite SET NULL key nulls a NOT
-- NULL column, so getting this wrong fails the suite rather than corrupting a
-- row years later. A deleted membership therefore unassigns the step and leaves
-- it exactly where it was.
--
-- WHY due_at IS timestamptz AND NOT date. The schema is split on purpose:
-- warranties, domains and licences use `date` because they expire on a day in
-- the world, and "expires 2026-03-01" meaning three different instants is how a
-- certificate lapses on a Sunday. A task is the other case. "Restart it at
-- 02:00" is a real step, and more to the point a task assigned to you is the
-- one kind of date where the READER is the subject rather than a shared fact —
-- which is precisely when 0630's formatDateTimeLocal() renders local time
-- beside UTC. Overdue is computed against now() in SQL, so it is correct for
-- everybody regardless of where they are reading it.
--
-- THE RUN'S COLUMNS ARE DEFAULTS, APPLIED ONCE. Starting a run stamps its
-- assignee and due date onto every step it creates; a step's value is then
-- concrete and is what My Tasks reads. The alternative — leaving a step NULL
-- and inheriting the run's at read time — makes the central query
-- COALESCE(s.assigned_to, r.assigned_to) = me across a join, which no index can
-- serve, on what will be the most-opened page in the product. It also makes
-- "assigned to nobody" and "assigned to whoever owns the run" the same state,
-- so a step could never be taken off somebody.
-- =============================================================================
SET search_path = public, extensions;

ALTER TABLE sop_run
  ADD COLUMN IF NOT EXISTS assigned_to uuid,
  ADD COLUMN IF NOT EXISTS due_at      timestamptz;

ALTER TABLE sop_run_step
  ADD COLUMN IF NOT EXISTS assigned_to uuid,
  ADD COLUMN IF NOT EXISTS due_at      timestamptz;

DO $add_fks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sop_run_assignee_fk') THEN
    ALTER TABLE sop_run
      ADD CONSTRAINT sop_run_assignee_fk FOREIGN KEY (tenant_id, assigned_to)
        REFERENCES membership (tenant_id, user_id) ON DELETE SET NULL (assigned_to);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sop_run_step_assignee_fk') THEN
    ALTER TABLE sop_run_step
      ADD CONSTRAINT sop_run_step_assignee_fk FOREIGN KEY (tenant_id, assigned_to)
        REFERENCES membership (tenant_id, user_id) ON DELETE SET NULL (assigned_to);
  END IF;
END;
$add_fks$;

-- -----------------------------------------------------------------------------
-- The index My Tasks is.
--
-- The page's query is "steps assigned to me that are not finished, soonest
-- first", so the index leads with the two equality predicates and carries the
-- ordering column. Partial on assigned_to IS NOT NULL because an unassigned
-- step is never in anybody's list and most steps will be unassigned.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS sop_run_step_assignee_idx
  ON sop_run_step (tenant_id, assigned_to, status, due_at)
  WHERE assigned_to IS NOT NULL;

-- Overdue work across a tenant, for the count on the dashboard and for K's
-- reminders later. Deliberately not partial on status: 'done' rows are read by
-- the same index when somebody asks what they finished late.
CREATE INDEX IF NOT EXISTS sop_run_step_due_idx
  ON sop_run_step (tenant_id, due_at)
  WHERE due_at IS NOT NULL;

-- =============================================================================
-- Guards
-- =============================================================================
DO $assignment_guard$
DECLARE
  v_rec record;
BEGIN
  -- 1. BOTH TABLES, BOTH COLUMNS, NULLABLE. A NOT NULL assignee would mean
  --    every run step must belong to somebody from the moment it exists, and
  --    most checklist steps belong to whoever picks them up.
  FOR v_rec IN
    SELECT t.table_name, c.column_name, c.is_nullable, c.data_type
    FROM (VALUES ('sop_run'), ('sop_run_step')) AS t(table_name)
    CROSS JOIN (VALUES ('assigned_to'), ('due_at')) AS col(column_name)
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public' AND c.table_name = t.table_name
     AND c.column_name = col.column_name
  LOOP
    IF v_rec.column_name IS NULL THEN
      RAISE EXCEPTION 'helm: % is missing an assignment column', v_rec.table_name;
    END IF;
    IF v_rec.is_nullable <> 'YES' THEN
      RAISE EXCEPTION 'helm: %.% must stay nullable', v_rec.table_name, v_rec.column_name;
    END IF;
  END LOOP;

  -- 2. THE ASSIGNEE GOES THROUGH membership. A plain app_user reference would
  --    let a step be assigned to somebody who cannot see this tenant, which is
  --    work that silently never gets done.
  FOR v_rec IN
    SELECT unnest(ARRAY['sop_run_assignee_fk', 'sop_run_step_assignee_fk']) AS conname
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class ref ON ref.oid = c.confrelid
      WHERE c.conname = v_rec.conname AND c.contype = 'f' AND ref.relname = 'membership'
    ) THEN
      RAISE EXCEPTION 'helm: % must reference membership, so a step cannot be assigned '
                      'outside the tenant', v_rec.conname;
    END IF;
  END LOOP;

  -- 3. AND IT NULLS ONLY THE ASSIGNEE. This is 0510's defect in a new
  --    constraint: without the column list, deleting a membership nulls
  --    tenant_id too, which is NOT NULL, so the delete fails with "null value
  --    in column tenant_id violates not-null constraint" — measured, not
  --    guessed.
  --
  --    NULL, NOT '{}'. Postgres reports confdelsetcols as NULL when no column
  --    list was given, so `confdelsetcols = '{}'` is NULL rather than true and
  --    a guard written that way never fires. That is not a hypothetical: the
  --    shipped assertion in db/tests/security.sql §41(g) was written that way,
  --    passed with this exact defect present, and is fixed in the same change
  --    as this file.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname IN ('sop_run_assignee_fk', 'sop_run_step_assignee_fk')
      AND c.confdeltype = 'n'
      AND (c.confdelsetcols IS NULL OR c.confdelsetcols = '{}'::int2[])
  ) THEN
    RAISE EXCEPTION 'helm: an assignee constraint nulls its whole key, not just assigned_to';
  END IF;

  -- 4. THE PAGE HAS AN INDEX. My Tasks is one equality pair plus an ordering,
  --    and a sequential scan of every run step in a tenant on the most-opened
  --    page is the kind of thing that is only noticed in production.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'sop_run_step_assignee_idx'
  ) THEN
    RAISE EXCEPTION 'helm: the My Tasks index is missing';
  END IF;
END;
$assignment_guard$;
