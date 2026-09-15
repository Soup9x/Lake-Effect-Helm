-- =============================================================================
-- 0330_export_render_context.sql — who requested and who approved, in the
-- render worker's hands
--
-- A handover pack says "Requested by X, approved by Y" on its cover. That is
-- not decoration: it is the evidence that the four-eyes rule was followed, and
-- it is the first thing an auditor reading the document looks for.
--
-- The render worker could not produce it. Its service account holds
-- organization:read, asset:read, sop:read and the export reveal purpose — and
-- deliberately NOT user:read, so `membership` returns zero rows to it and the
-- LEFT JOIN to app_user yielded NULL. The document rendered with "Approved by:
-- not required", quietly, on an export that certainly did require approval.
--
-- The fix is not to grant the worker user:read. That would hand a background
-- process the tenant's entire staff directory to put two names on a cover page.
-- Instead the names travel with the work: export_backlog() already decides what
-- the worker may render, it is already SECURITY DEFINER, and it is the natural
-- place for "here is the job, and here is who stands behind it".
--
-- The worker therefore learns the names of exactly the two people attached to a
-- job it was already authorised to render, and nothing else.
-- =============================================================================

SET search_path = public, extensions;

DROP FUNCTION IF EXISTS helm.export_backlog(integer);

CREATE OR REPLACE FUNCTION helm.export_backlog(p_limit integer DEFAULT 10)
  RETURNS TABLE (
    tenant_id          uuid,
    worker_actor_id    uuid,
    export_job_id      uuid,
    organization_id    uuid,
    kind               export_kind,
    format             text,
    include_secrets    boolean,
    scope              jsonb,
    reason             text,
    requested_by_name  text,
    approved_by_name   text,
    requested_at       timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT j.tenant_id, helm.worker_actor(j.tenant_id, 'system_export'),
         j.id, j.organization_id, j.kind, j.format, j.include_secrets, j.scope,
         j.reason,
         coalesce(req.name, req.email::text),
         coalesce(app.name, app.email::text),
         j.created_at
  FROM export_job j
  JOIN tenant t ON t.id = j.tenant_id AND t.status = 'active'
  LEFT JOIN app_user req ON req.id = j.requested_by
  LEFT JOIN app_user app ON app.id = j.approved_by
  WHERE j.status = 'queued'
    AND j.revoked_at IS NULL
    AND j.expires_at > now()
    AND (NOT j.include_secrets OR (
          j.approved_by IS NOT NULL
      AND j.approved_at IS NOT NULL
      AND j.approved_scope_sha256 = digest(
            j.kind::text || '|' || j.format || '|' ||
            j.include_secrets::text || '|' || j.scope::text, 'sha256')))
    AND helm.worker_actor(j.tenant_id, 'system_export') IS NOT NULL
  ORDER BY j.created_at
  LIMIT greatest(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION helm.export_backlog(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.export_backlog(integer) TO helm_worker;

-- -----------------------------------------------------------------------------
-- Guard: still worker-only, and the worker still cannot read the staff
-- directory. Both halves matter — the point of returning the names here is that
-- the broader capability was NOT granted.
-- -----------------------------------------------------------------------------
DO $guard$
BEGIN
  IF has_function_privilege('helm_app', 'helm.export_backlog(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app must not enumerate exports across tenants';
  END IF;

  IF EXISTS (
    SELECT 1 FROM role_permission
    WHERE role_key = 'system_export' AND permission_key = 'user:read'
  ) THEN
    RAISE EXCEPTION 'helm: the export worker was granted user:read; the render context '
      'in this migration exists precisely so that it does not need it';
  END IF;
END
$guard$;
