-- Minimal assertion helper. Installed as a superuser; callable by any role.
CREATE SCHEMA IF NOT EXISTS helm_test;

CREATE OR REPLACE FUNCTION helm_test.check(p_description text, p_condition boolean)
  RETURNS void
  LANGUAGE plpgsql
AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION E'\n  FAIL: %', p_description USING ERRCODE = 'assert_failure';
  END IF;
  RAISE NOTICE '  ok  %', p_description;
END;
$$;

-- Asserts that a statement raises. Used for the "this must be impossible" tests.
CREATE OR REPLACE FUNCTION helm_test.check_raises(p_description text, p_sql text)
  RETURNS void
  LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  ok  % (rejected: %)', p_description, left(SQLERRM, 70);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  FAIL: % — statement was ACCEPTED but should have been rejected', p_description
    USING ERRCODE = 'assert_failure';
END;
$$;

-- Void-returning wrapper so the test scripts do not print the whole resolved
-- context jsonb on every BEGIN. psql does not interpolate :variables inside
-- dollar-quoted blocks, so a DO block is not an option here.
CREATE OR REPLACE FUNCTION helm_test.ctx(p_tenant uuid, p_actor uuid)
  RETURNS void
  LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM helm.set_session_context(p_tenant, p_actor);
END;
$$;

-- =============================================================================
-- The catalogue backstop: "a table carrying tenant_id that nobody wired up".
--
-- WHY IT LIVES HERE AND NOT IN A MIGRATION. 0200 ends with a DO block asserting
-- exactly this, and that assertion was true at the moment 0200 ran and has been
-- false ever since. A one-time check cannot see a table created by a LATER
-- migration, which is the only case it was ever meant to catch — and three
-- tables duly slipped past it: radius_config (0360), oidc_provider (0410) and
-- notification_cursor (0420), each carrying tenant_id with RLS switched off.
-- 0550 enabled it on all three; this is what stops the fourth.
--
-- The block stays in 0200 because an applied migration is immutable (see
-- scripts/check-migrations.ts). It is harmless there: it passes at that point
-- in the sequence and always will. It simply is not the backstop. This is.
--
-- It is a FUNCTION rather than a query pasted into security.sql so that the
-- tamper suite — which is superuser and can therefore actually create a table
-- — proves this exact query catches one, rather than proving it about a
-- lookalike.
--
-- FOUR GAPS, and the last is not the one 0200 looked for:
--
--   RLS disabled                the table is wide open to anything holding a
--                               grant, and a grant is one reasonable-sounding
--                               request away.
--   RLS not FORCEd              without FORCE the table OWNER is exempt, and
--                               every SECURITY DEFINER function in this schema
--                               runs as an owner.
--   enabled but no policy       denies everything, for every role, forever. Not
--                               a leak — but for any table the application
--                               actually reads directly it is an outage waiting
--                               for the first tenant to use the feature, and it
--                               means nobody decided what the rule should be.
--   a deny-all table grew one   the inverse, and the dangerous direction. See
--                               DENY_ALL below.
-- =============================================================================
CREATE OR REPLACE FUNCTION helm_test.rls_catalogue_gaps()
  RETURNS TABLE (table_name text, gap text)
  LANGUAGE sql STABLE
AS $$
  WITH tenant_tables AS (
    SELECT c.oid, c.relname::text AS name, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ),
  -- DENY_ALL: tables where "RLS on, no policy at all" is the DESIGN.
  --
  -- secret_version is the ciphertext store. 0200 enables RLS and deliberately
  -- creates no policy, so every direct read returns zero rows for every role
  -- forever, and the only way to ciphertext is helm.reveal_secret(), which
  -- writes the audit row in the same transaction. That is what makes "every
  -- secret read is audited" a property of the database.
  --
  -- Listed by name rather than skipped by a heuristic, because the interesting
  -- failure is the opposite one: a permissive SELECT policy appearing here
  -- would quietly turn the audited-only door into a door, and would otherwise
  -- look like somebody finally wiring up a table that was missing a policy.
  deny_all(name) AS (VALUES ('secret_version'))
  SELECT t.name, 'RLS disabled'
    FROM tenant_tables t WHERE NOT t.relrowsecurity
  UNION ALL
  SELECT t.name, 'RLS enabled but not FORCEd'
    FROM tenant_tables t WHERE t.relrowsecurity AND NOT t.relforcerowsecurity
  UNION ALL
  SELECT t.name, 'RLS enforced but the table has no policy at all'
    FROM tenant_tables t
    WHERE t.relrowsecurity
      AND t.name NOT IN (SELECT name FROM deny_all)
      AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid)
  UNION ALL
  SELECT t.name, 'deny-all by design, but a policy has appeared on it'
    FROM tenant_tables t
    WHERE t.name IN (SELECT name FROM deny_all)
      AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid)
  ORDER BY 1, 2;
$$;

-- The assertion, so a failure names the tables instead of saying "false".
CREATE OR REPLACE FUNCTION helm_test.check_rls_catalogue()
  RETURNS void
  LANGUAGE plpgsql
AS $$
DECLARE
  v_gaps  text;
  v_count integer;
BEGIN
  SELECT string_agg(table_name || ' — ' || gap, E'\n        ' ORDER BY table_name, gap)
    INTO v_gaps
  FROM helm_test.rls_catalogue_gaps();

  -- Quantifying over something: a query that found no tenant tables at all
  -- would report no gaps and read exactly like success.
  SELECT count(*) INTO v_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');

  PERFORM helm_test.check(
    format('all %s tables carrying tenant_id enforce RLS and have a decided policy%s',
           v_count, coalesce(E' — but:\n        ' || v_gaps, '')),
    v_count >= 60 AND v_gaps IS NULL);
END;
$$;

-- ---------------------------------------------------------------------------
-- helm_test.plant_reminder — a real task_reminder row, for the RLS assertions.
--
-- 0690's reminder queue is written only by SECURITY DEFINER functions (helm_app
-- and helm_worker both hold no INSERT on it), and its step_id references a
-- sop_run_step — so a test that wants to READ one has to build the chain
-- asset_node → sop → sop_version → sop_run → sop_run_step first. Done here
-- rather than inline so the five assertions that use it read as assertions.
--
-- SECURITY DEFINER AND OWNED BY A SUPERUSER, so this bypasses RLS. That is the
-- point: it is a fixture, not an assertion. What is being tested is who can
-- READ the row afterwards, from a seat established with helm_test.ctx().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm_test.plant_reminder(
  p_tenant uuid,
  p_user   uuid,
  p_kind   text DEFAULT 'assigned',
  p_suffix text DEFAULT ''
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_org     uuid;
  v_sop     uuid := gen_random_uuid();
  v_version uuid := gen_random_uuid();
  v_run     uuid := gen_random_uuid();
  v_step    uuid := gen_random_uuid();
  v_id      uuid;
BEGIN
  SELECT id INTO v_org FROM organization WHERE tenant_id = p_tenant ORDER BY name LIMIT 1;

  INSERT INTO asset_node (id, tenant_id, organization_id, node_type, name)
  VALUES (v_sop, p_tenant, v_org, 'sop', 'zz planted procedure ' || p_suffix || v_sop::text);
  INSERT INTO sop (id, tenant_id, summary, current_version)
  VALUES (v_sop, p_tenant, 'planted for the reminder RLS assertions', 1);
  INSERT INTO sop_version (id, tenant_id, sop_id, version, snapshot, snapshot_sha256)
  VALUES (v_version, p_tenant, v_sop, 1, '{"steps":[]}'::jsonb,
          digest('planted'::text, 'sha256'));
  INSERT INTO sop_run (id, tenant_id, organization_id, sop_id, sop_version_id, title,
                       assigned_to, status)
  VALUES (v_run, p_tenant, v_org, v_sop, v_version, 'zz planted run', p_user, 'in_progress');
  INSERT INTO sop_run_step (id, tenant_id, run_id, position, title, kind, assigned_to,
                            due_at)
  VALUES (v_step, p_tenant, v_run, 1, 'zz planted step', 'manual', p_user,
          now() + interval '1 day');

  INSERT INTO task_reminder (tenant_id, step_id, user_id, kind, lead_day, next_attempt_at)
  VALUES (p_tenant, v_step, p_user, p_kind::task_reminder_kind, 0, now())
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

/**
 * Whether `p_reader` can see a reminder addressed to `p_owner`.
 *
 * Plants the row, re-establishes the session as the reader, and asks. The
 * context is left pointing at the reader, so a caller that wants another seat
 * afterwards calls helm_test.ctx() again — the assertions below do.
 */
CREATE OR REPLACE FUNCTION helm_test.reminder_visible(
  p_tenant uuid,
  p_owner  uuid,
  p_reader uuid
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, helm_test, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_id      uuid := helm_test.plant_reminder(p_tenant, p_owner);
  v_visible boolean;
BEGIN
  -- INVOKER rights, deliberately: the read below has to happen as the role
  -- running the suite, under the policy, or this proves nothing.
  PERFORM helm_test.ctx(p_tenant, p_reader);
  SELECT EXISTS (SELECT 1 FROM task_reminder WHERE id = v_id) INTO v_visible;
  RETURN v_visible;
END;
$$;

GRANT USAGE ON SCHEMA helm_test TO PUBLIC;
GRANT EXECUTE ON FUNCTION helm_test.check(text, boolean) TO PUBLIC;
GRANT EXECUTE ON FUNCTION helm_test.check_raises(text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION helm_test.ctx(uuid, uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION helm_test.rls_catalogue_gaps() TO PUBLIC;
GRANT EXECUTE ON FUNCTION helm_test.check_rls_catalogue() TO PUBLIC;
GRANT EXECUTE ON FUNCTION helm_test.plant_reminder(uuid, uuid, text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION helm_test.reminder_visible(uuid, uuid, uuid) TO PUBLIC;
