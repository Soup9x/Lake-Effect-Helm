-- =============================================================================
-- 0550 — the three tenant-scoped tables that were held by grants alone
--
-- oidc_provider (0410), radius_config (0360) and notification_cursor (0420)
-- each carry tenant_id, and each arrived with relrowsecurity = false and zero
-- policies. Every other table carrying tenant_id has had RLS since 0200.
--
-- WHAT WAS ALREADY PROTECTING THEM, because it is not nothing. helm_app — the
-- role every web request runs as — holds no privilege on any of the three. The
-- grants are narrow and deliberate:
--
--     oidc_provider        helm_auth    SELECT, INSERT, UPDATE, DELETE
--     radius_config        helm_auth    SELECT, INSERT, UPDATE, DELETE
--     notification_cursor  helm_worker  SELECT, INSERT, UPDATE, DELETE
--
-- and everything that reads or writes them does so through SECURITY DEFINER
-- functions owned by postgres, which scope by the resolved session tenant
-- themselves. 0410 and 0360 both assert that helm_app cannot reach the wrapped
-- DEK or the ciphertext columns at all.
--
-- SO WHY ADD RLS. Because that is one layer, and it is the layer that a single
-- future GRANT undoes. "helm_app needs to read the provider slug for the
-- sign-in page" is an entirely reasonable-sounding request, and the moment
-- somebody grants SELECT to satisfy it, a table with no policy hands over every
-- tenant's row. The grant is the door; the policy is the lock behind it. On
-- every other tenant table in this schema both are present, and a reviewer
-- reading these three could reasonably conclude the omission was considered.
--
-- It also makes the catalogue backstop true again. 0200 ends with a DO block
-- asserting that no table carrying tenant_id has RLS disabled. That assertion
-- was correct when 0200 ran and has been false since 0360 — a one-time check
-- cannot see a table created by a later migration. db/tests/security.sql § 42
-- now runs the same query against the FINAL schema on every CI run, and these
-- three are why it would otherwise have started life red.
--
-- WHAT THIS CHANGES AT RUNTIME: nothing. A SECURITY DEFINER function owned by a
-- superuser bypasses row security entirely, FORCE included, so all sixteen
-- readers and writers behave exactly as they did. db/tests/security.sql § 42
-- exercises them rather than assuming it.
--
-- THE POLICIES, and why these ranks:
--
--   p_org_scoped = false for all three. None has an organization_id, and none
--   should: an OIDC provider, a RADIUS server and a fan-out cursor are
--   tenant-wide facts, not per-client ones. That yields the MSP-only predicate
--   — tenant_id matches AND helm.is_tenant_wide() — so a client-scoped actor
--   cannot see them even if a grant appears.
--
--   Write rank 100 for oidc_provider and radius_config, because that is what
--   the functions already demand. set_oidc_provider, update_oidc_settings,
--   forget_oidc_provider and their RADIUS counterparts all begin with
--   helm.has_permission('tenant:write'), and tenant:write is held by
--   super_admin alone. A lower number here would say something the product
--   does not mean.
--
--   Write rank 80 for notification_cursor, matching integration_sync_run and
--   the other worker-owned progress state in 0200. It is not user-facing
--   configuration; it is how far helm.fan_out_notifications() has read, and
--   system_sync is rank 80.
-- =============================================================================
SET search_path = public, extensions;

-- The explicit NULL is not decoration. 0390 added a five-argument overload of
-- apply_tenant_rls for the is_internal_only tables, so a three-argument call is
-- ambiguous and fails to resolve. Naming the fourth argument settles it.
SELECT helm.apply_tenant_rls('oidc_provider',       false, 100, NULL);
SELECT helm.apply_tenant_rls('radius_config',       false, 100, NULL);
SELECT helm.apply_tenant_rls('notification_cursor', false,  80, NULL);

-- =============================================================================
-- Guards
-- =============================================================================
DO $rls_guard$
DECLARE
  v_table   text;
  v_missing text;
  v_count   integer;
BEGIN
  -- 1. EACH OF THE THREE IS NOW ENABLED, FORCED, AND CARRIES ITS FOUR POLICIES.
  --    Counted rather than assumed. A misspelled table name would raise inside
  --    apply_tenant_rls, so that much is self-checking — but what the helper
  --    CREATES is not: it is one function that four other migrations also call,
  --    and a future edit dropping the DELETE policy would leave these three
  --    writable-but-undeletable with nothing to say so.
  FOREACH v_table IN ARRAY ARRAY['oidc_provider', 'radius_config', 'notification_cursor']
  LOOP
    SELECT count(*) INTO v_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_table
      AND c.relrowsecurity AND c.relforcerowsecurity;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'helm: % did not end up with RLS enabled and forced', v_table;
    END IF;

    SELECT count(*) INTO v_count
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_table;
    IF v_count <> 4 THEN
      RAISE EXCEPTION 'helm: % has % policies, expected 4', v_table, v_count;
    END IF;
  END LOOP;

  -- 2. THE POLICIES ARE THE MSP-ONLY SHAPE, not the organisation-scoped one.
  --    A table with no organization_id column would have failed to create an
  --    org-scoped policy, but apply_tenant_rls takes org-scoping as a
  --    PARAMETER, so passing the wrong one is a silent widening rather than an
  --    error. This is the assertion that a `false` did not become a `true`.
  SELECT string_agg(c.relname || '.' || p.polname, ', ' ORDER BY c.relname, p.polname)
    INTO v_missing
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('oidc_provider', 'radius_config', 'notification_cursor')
    AND pg_get_expr(coalesce(p.polqual, p.polwithcheck), p.polrelid) NOT LIKE '%is_tenant_wide%';
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'helm: these policies are not MSP-only: %', v_missing;
  END IF;

  -- 3. NOTHING ELSE MOVED. helm_app still has no privilege on any of the three;
  --    RLS is a second layer here, not a replacement for the first, and a
  --    migration that quietly traded one for the other would be worse than the
  --    gap it closed.
  FOREACH v_table IN ARRAY ARRAY['oidc_provider', 'radius_config', 'notification_cursor']
  LOOP
    FOR v_missing IN SELECT unnest(ARRAY['helm_app', 'helm_auditor', 'helm_key_admin'])
    LOOP
      IF has_table_privilege(v_missing, v_table, 'SELECT')
         OR has_table_privilege(v_missing, v_table, 'INSERT')
         OR has_table_privilege(v_missing, v_table, 'UPDATE')
         OR has_table_privilege(v_missing, v_table, 'DELETE') THEN
        RAISE EXCEPTION 'helm: % holds a grant on %', v_missing, v_table;
      END IF;
    END LOOP;
  END LOOP;

  -- 4. THE CATALOGUE IS WHOLE AGAIN. The same query 0200 ends with, run here
  --    against the schema as it stands after every migration to date — which is
  --    the thing 0200's copy could never see. This is a point-in-time check and
  --    knows it; db/tests/security.sql § 42 is the one that keeps running.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'helm: tables still carry tenant_id without enforced RLS: %', v_missing;
  END IF;

  RAISE NOTICE '0550: RLS enabled on oidc_provider, radius_config, notification_cursor';
END
$rls_guard$;
