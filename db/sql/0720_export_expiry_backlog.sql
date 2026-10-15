-- 0720_export_expiry_backlog.sql — the export TTL job could not see any tenant
--
-- src/workers/exports.ts expireExports() found its tenants with a plain query
-- on the worker pool:
--
--   SELECT ... FROM audit_chain_head h JOIN tenant t ON ...
--
-- Both tables are FORCE ROW LEVEL SECURITY with policies keyed on
-- helm.current_tenant_id(), and the worker holds no tenant context while it is
-- deciding which tenants to enter. So the query returned zero rows on every
-- tick, helm.expire_exports() was never called, and no export ever expired:
-- rows stayed `completed`, bundles that may hold credentials were never
-- deleted from disk, and no `export.expired` audit event was written.
-- Downloads were still refused after expires_at, which is why nothing visible
-- broke.
--
-- This is the fourth zero-rows-under-RLS enumeration in this project (0700
-- records the third and lists the others). The fix is the house pattern every
-- other backlog follows: a SECURITY DEFINER function, executable by the worker
-- alone, that says which tenants have work, after which the job enters each
-- one through withTenant() as before.
--
-- Pre-filtered with the same predicate helm.expire_exports() applies, so an
-- idle deployment enters no tenant at all.

CREATE OR REPLACE FUNCTION helm.export_expiry_backlog(p_limit integer DEFAULT 50)
  RETURNS TABLE (tenant_id uuid, worker_actor_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT t.id, helm.worker_actor(t.id, 'system_export')
  FROM tenant t
  WHERE t.status = 'active'
    AND helm.worker_actor(t.id, 'system_export') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM export_job j
      WHERE j.tenant_id = t.id
        AND j.status = 'completed'
        AND j.revoked_at IS NULL
        AND j.expires_at <= now()
    )
  ORDER BY t.id
  LIMIT greatest(p_limit, 1);
$$;

COMMENT ON FUNCTION helm.export_expiry_backlog(integer) IS
  'Which tenants hold completed exports past their TTL. SECURITY DEFINER because '
  'the worker has no tenant context and `tenant` is behind RLS — the raw query '
  'this replaces returned zero rows, so exports never expired. See 0720.';

REVOKE ALL ON FUNCTION helm.export_expiry_backlog(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.export_expiry_backlog(integer) TO helm_worker;

DO $guard$
BEGIN
  IF has_function_privilege('helm_app', 'helm.export_expiry_backlog(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '0720: helm_app must not enumerate tenants';
  END IF;
  IF NOT (
    SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'export_expiry_backlog'
  ) THEN
    RAISE EXCEPTION '0720: export_expiry_backlog must be SECURITY DEFINER';
  END IF;
END;
$guard$;
