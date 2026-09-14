-- =============================================================================
-- 0310_export_engine.sql — compliance and offboarding exports
--
-- The single most damaging action this product can perform is "produce a file
-- containing every credential for a client". It is also a legitimate, routine
-- operation: an MSP losing a client has a contractual obligation to hand over
-- documentation, and an auditor asking for evidence needs a record they can
-- read. Refusing to build it does not make it not happen — it makes it happen
-- through a database dump nobody logged.
--
-- So it is built, and built as the most controlled path in the system:
--
--   * FOUR EYES. A secret-bearing export needs a second person, and the
--     approver cannot be the requester. Enforced by a CHECK constraint in 0130,
--     so it holds even against a direct UPDATE by someone who found a way past
--     the API.
--
--   * A REASON, ALWAYS. At least ten characters, stored on the job and repeated
--     in the audit trail. "Why did we export Acme's whole vault in March" has
--     an answer.
--
--   * APPROVAL IS A TRANSITION, NOT A COLUMN. helm.approve_export() is the only
--     way approved_by gets set; it refuses self-approval, re-approval, and
--     approval of a job whose scope changed after it was reviewed. A reviewer
--     approves what they read.
--
--   * EVERY SECRET IN THE BUNDLE IS AUDITED INDIVIDUALLY. The export worker
--     reveals through the ordinary audited path, with purpose 'export', and its
--     service account is pinned to that purpose (0290). A 400-credential export
--     leaves 400 audit rows, not one.
--
--   * THE FILE EXPIRES AND EVERY DOWNLOAD IS AN EVENT. A handover archive that
--     lingers in a bucket is a breach waiting for a misconfigured ACL.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- What the reviewer actually approved.
--
-- A scope digest computed when approval is granted. If the scope is edited
-- afterwards, the render refuses: otherwise "approve a two-server inventory,
-- then widen it to the whole tenant" is a one-line UPDATE away from being an
-- approved full-vault export.
-- -----------------------------------------------------------------------------
ALTER TABLE export_job
  ADD COLUMN approved_scope_sha256 bytea,
  -- How many secrets the worker could NOT include, and why. A partially
  -- complete handover that looks complete is worse than one that says what is
  -- missing: the client discovers the gap when they need the credential.
  ADD COLUMN omitted_secret_count integer NOT NULL DEFAULT 0,
  ADD COLUMN omissions jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE export_job ADD CONSTRAINT export_job_approved_scope_len CHECK (
  approved_scope_sha256 IS NULL OR octet_length(approved_scope_sha256) = 32
);
ALTER TABLE export_job ADD CONSTRAINT export_job_omissions_array CHECK (
  jsonb_typeof(omissions) = 'array'
);
ALTER TABLE export_job ADD CONSTRAINT export_job_approved_scope_recorded CHECK (
  approved_by IS NULL OR approved_scope_sha256 IS NOT NULL
);

COMMENT ON COLUMN export_job.approved_scope_sha256 IS
  'Digest of the scope at the moment of approval. The render refuses if the '
  'scope has changed since, so a reviewer approves what they actually read.';

COMMENT ON COLUMN export_job.omissions IS
  'Secrets the render could not include, with a reason each. A handover that '
  'silently drops credentials is discovered by the client, not by us.';

-- -----------------------------------------------------------------------------
-- helm.request_export — create a job.
--
-- SECURITY DEFINER so the audit row and the job are written together: an export
-- request that is not in the audit log is the one an investigation cares about.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.request_export(
  p_organization_id uuid,
  p_kind            export_kind,
  p_format          text,
  p_reason          text,
  p_include_secrets boolean DEFAULT false,
  p_scope           jsonb   DEFAULT '{}'::jsonb,
  p_ttl_hours       integer DEFAULT 72
) RETURNS TABLE (export_job_id uuid, status export_status, needs_approval boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_job    uuid;
  v_ttl    integer := least(greatest(coalesce(p_ttl_hours, 72), 1), 720);
BEGIN
  IF NOT helm.has_permission('export:create') THEN
    RAISE EXCEPTION 'helm: export:create is required to request an export'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT helm.org_in_scope(p_organization_id) THEN
    RAISE EXCEPTION 'helm: organisation % is not in scope', p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF coalesce(length(btrim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'helm: an export needs a justification of at least 10 characters'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Requesting a secret-bearing export is itself a permissioned act, separate
  -- from approving one. Someone who cannot export secrets should not be able to
  -- park a request in the queue for a colleague to rubber-stamp.
  IF p_include_secrets AND NOT helm.has_permission('secret:export') THEN
    RAISE EXCEPTION 'helm: secret:export is required to request an export containing credentials'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO export_job (
    tenant_id, organization_id, kind, format, status,
    include_secrets, scope, reason, requested_by, expires_at
  )
  VALUES (
    v_tenant, p_organization_id, p_kind, p_format,
    -- A secret-bearing job is parked until approved. It is still 'queued' —
    -- the worker's backlog query is what filters on approval, so there is one
    -- place that decides what is renderable.
    'queued', p_include_secrets, coalesce(p_scope, '{}'::jsonb), btrim(p_reason),
    helm.current_actor_id(), now() + make_interval(hours => v_ttl)
  )
  RETURNING id INTO v_job;

  PERFORM helm.audit(
    'export.requested', 'export_job', v_job, 'success',
    p_organization_id, NULL, btrim(p_reason),
    jsonb_build_object(
      'kind', p_kind, 'format', p_format,
      'include_secrets', p_include_secrets,
      'scope', coalesce(p_scope, '{}'::jsonb),
      'expires_in_hours', v_ttl));

  RETURN QUERY SELECT v_job, 'queued'::export_status, p_include_secrets;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.approve_export — the second pair of eyes.
--
-- Everything this refuses is something that would otherwise turn four eyes back
-- into two: approving your own request, approving twice, approving a job that
-- already ran, or approving one whose organisation you cannot see.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.approve_export(
  p_export_job_id uuid,
  p_reason        text DEFAULT NULL
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
  v_job    export_job%ROWTYPE;
BEGIN
  IF NOT helm.has_permission('export:approve') THEN
    RAISE EXCEPTION 'helm: export:approve is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Machine identities cannot approve. Four eyes means two people; a service
  -- account rubber-stamping its own pipeline's exports is one.
  IF helm.current_actor_type() <> 'user' THEN
    RAISE EXCEPTION 'helm: only a person may approve an export'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_job FROM export_job
  WHERE id = p_export_job_id AND tenant_id = v_tenant
  FOR UPDATE;

  IF NOT FOUND OR NOT helm.org_in_scope(v_job.organization_id) THEN
    RAISE EXCEPTION 'helm: no such export job' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_job.approved_by IS NOT NULL THEN
    RAISE EXCEPTION 'helm: export % is already approved', p_export_job_id
      USING ERRCODE = 'unique_violation';
  END IF;

  IF v_job.status <> 'queued' THEN
    RAISE EXCEPTION 'helm: export % is %, and only a queued export can be approved',
      p_export_job_id, v_job.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_job.requested_by = v_actor THEN
    -- Also enforced by export_job_four_eyes, but refused here with a message
    -- that tells the reviewer what to do instead of a constraint name.
    RAISE EXCEPTION 'helm: an export must be approved by someone other than the person who requested it'
      USING ERRCODE = 'check_violation',
            HINT = 'Ask a colleague with export:approve to review it.';
  END IF;

  IF v_job.revoked_at IS NOT NULL OR v_job.expires_at <= now() THEN
    RAISE EXCEPTION 'helm: export % is revoked or expired', p_export_job_id
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE export_job
  SET approved_by = v_actor,
      approved_at = now(),
      -- Binds the approval to what was read. Any later change to kind, format,
      -- scope or the secrets flag invalidates it (see helm.export_backlog).
      approved_scope_sha256 = digest(
        v_job.kind::text || '|' || v_job.format || '|' ||
        v_job.include_secrets::text || '|' || v_job.scope::text, 'sha256')
  WHERE id = p_export_job_id;

  PERFORM helm.audit(
    'export.approved', 'export_job', p_export_job_id, 'success',
    v_job.organization_id, NULL, coalesce(p_reason, v_job.reason),
    jsonb_build_object(
      'requested_by', v_job.requested_by,
      'include_secrets', v_job.include_secrets,
      'kind', v_job.kind));

  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.revoke_export — kill an export, before or after it renders.
--
-- Deliberately available to the requester as well as an approver: the person
-- who realises they asked for the wrong thing should not have to find a second
-- person to stop it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.revoke_export(
  p_export_job_id uuid,
  p_reason        text
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_job    export_job%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM export_job
  WHERE id = p_export_job_id AND tenant_id = v_tenant FOR UPDATE;

  IF NOT FOUND OR NOT helm.org_in_scope(v_job.organization_id) THEN
    RAISE EXCEPTION 'helm: no such export job' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT (helm.has_permission('export:approve')
          OR v_job.requested_by = helm.current_actor_id()) THEN
    RAISE EXCEPTION 'helm: only the requester or an approver may revoke an export'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_job.revoked_at IS NOT NULL THEN RETURN false; END IF;

  UPDATE export_job
  SET revoked_at = now(),
      status = CASE WHEN status IN ('queued', 'running') THEN 'revoked'::export_status ELSE status END
  WHERE id = p_export_job_id;

  PERFORM helm.audit(
    'export.revoked', 'export_job', p_export_job_id, 'success',
    v_job.organization_id, NULL, p_reason,
    jsonb_build_object('previous_status', v_job.status, 'downloads', v_job.downloaded_count));

  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.export_backlog — what the render worker may pick up.
--
-- The single place that decides "is this renderable". Four conditions, each of
-- which is a way an export could otherwise escape its controls:
--
--   approved, if it carries secrets      — four eyes
--   scope unchanged since approval       — the reviewer approved THIS
--   not revoked, not expired             — a stop actually stops it
--   tenant active                        — a suspended MSP exports nothing
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.export_backlog(p_limit integer DEFAULT 10)
  RETURNS TABLE (
    tenant_id       uuid,
    worker_actor_id uuid,
    export_job_id   uuid,
    organization_id uuid,
    kind            export_kind,
    format          text,
    include_secrets boolean,
    scope           jsonb,
    requested_at    timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT j.tenant_id, helm.worker_actor(j.tenant_id, 'system_export'),
         j.id, j.organization_id, j.kind, j.format, j.include_secrets, j.scope, j.created_at
  FROM export_job j
  JOIN tenant t ON t.id = j.tenant_id AND t.status = 'active'
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

-- -----------------------------------------------------------------------------
-- Render lifecycle.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.begin_export_render(p_export_job_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_claimed integer;
BEGIN
  UPDATE export_job
  SET status = 'running', started_at = now()
  WHERE id = p_export_job_id
    AND tenant_id = helm.require_tenant_id()
    AND status = 'queued'
    AND revoked_at IS NULL
    AND expires_at > now();

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed = 1;
END;
$$;

CREATE OR REPLACE FUNCTION helm.finish_export_render(
  p_export_job_id    uuid,
  p_status           export_status,
  p_storage_key      text DEFAULT NULL,
  p_byte_size        bigint DEFAULT NULL,
  p_content_sha256   bytea DEFAULT NULL,
  p_encryption_method text DEFAULT NULL,
  p_record_count     integer DEFAULT NULL,
  p_secret_count     integer DEFAULT NULL,
  p_omissions        jsonb DEFAULT '[]'::jsonb,
  p_error            text DEFAULT NULL
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_job     export_job%ROWTYPE;
  v_updated integer;
BEGIN
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'helm: % is not a terminal render status', p_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_job FROM export_job
  WHERE id = p_export_job_id AND tenant_id = v_tenant FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: no such export job' USING ERRCODE = 'no_data_found';
  END IF;

  -- A job revoked while it was rendering stays revoked. The bytes the worker
  -- produced are simply never registered, so there is nothing to download.
  IF v_job.revoked_at IS NOT NULL THEN
    RETURN false;
  END IF;

  UPDATE export_job
  SET status            = p_status,
      completed_at      = now(),
      storage_key       = p_storage_key,
      byte_size         = p_byte_size,
      content_sha256    = p_content_sha256,
      encryption_method = p_encryption_method,
      record_count      = p_record_count,
      secret_count      = p_secret_count,
      omissions         = coalesce(p_omissions, '[]'::jsonb),
      omitted_secret_count = jsonb_array_length(coalesce(p_omissions, '[]'::jsonb)),
      error             = left(p_error, 2000)
  WHERE id = p_export_job_id AND status = 'running';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RETURN false; END IF;

  PERFORM helm.audit(
    'export.rendered', 'export_job', p_export_job_id,
    (CASE WHEN p_status = 'completed' THEN 'success' ELSE 'error' END)::audit_outcome,
    v_job.organization_id, NULL, v_job.reason,
    jsonb_build_object(
      'kind', v_job.kind, 'format', v_job.format,
      'include_secrets', v_job.include_secrets,
      'records', p_record_count, 'secrets', p_secret_count,
      'omitted', jsonb_array_length(coalesce(p_omissions, '[]'::jsonb)),
      'bytes', p_byte_size,
      'sha256', encode(coalesce(p_content_sha256, ''::bytea), 'hex'),
      'encryption', p_encryption_method));

  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.claim_export_download — authorise one download and record it.
--
-- Returns the storage key only when the job is genuinely downloadable, and
-- writes the export_download row in the same transaction. Same principle as
-- reveal_secret: the artefact and the record of who took it are inseparable.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.claim_export_download(
  p_export_job_id uuid,
  p_ip            inet DEFAULT NULL,
  p_user_agent    text DEFAULT NULL
) RETURNS TABLE (
  granted        boolean,
  denial_reason  text,
  storage_key    text,
  byte_size      bigint,
  content_sha256 bytea,
  encryption_method text,
  download_number integer
)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_job    export_job%ROWTYPE;
  v_deny   text := NULL;
  v_number integer;
BEGIN
  SELECT * INTO v_job FROM export_job
  WHERE id = p_export_job_id AND tenant_id = v_tenant FOR UPDATE;

  IF NOT FOUND OR NOT helm.org_in_scope(v_job.organization_id) THEN
    PERFORM helm.audit('export.download_denied', 'export_job', p_export_job_id, 'denied',
                       NULL, NULL, NULL, jsonb_build_object('cause', 'not_found'));
    RETURN QUERY SELECT false, 'not_found', NULL::text, NULL::bigint, NULL::bytea, NULL::text, NULL::integer;
    RETURN;
  END IF;

  IF NOT helm.has_permission('export:create') THEN
    v_deny := 'missing_permission';
  ELSIF v_job.include_secrets AND NOT helm.has_permission('secret:export') THEN
    -- A credential-bearing bundle is not readable by everyone who may pull an
    -- inventory PDF.
    v_deny := 'secret_export_not_permitted';
  ELSIF v_job.revoked_at IS NOT NULL THEN
    v_deny := 'revoked';
  ELSIF v_job.expires_at <= now() THEN
    v_deny := 'expired';
  ELSIF v_job.status <> 'completed' THEN
    v_deny := 'not_ready';
  ELSIF v_job.storage_key IS NULL THEN
    v_deny := 'no_artefact';
  END IF;

  IF v_deny IS NOT NULL THEN
    PERFORM helm.audit('export.download_denied', 'export_job', p_export_job_id, 'denied',
                       v_job.organization_id, NULL, v_job.reason,
                       jsonb_build_object('cause', v_deny, 'status', v_job.status));
    RETURN QUERY SELECT false, v_deny, NULL::text, NULL::bigint, NULL::bytea, NULL::text, NULL::integer;
    RETURN;
  END IF;

  INSERT INTO export_download (tenant_id, export_job_id, downloaded_by, ip, user_agent)
  VALUES (v_tenant, p_export_job_id, helm.current_actor_id(), p_ip, left(p_user_agent, 500));

  UPDATE export_job
  SET downloaded_count = downloaded_count + 1, last_downloaded_at = now()
  WHERE id = p_export_job_id
  RETURNING downloaded_count INTO v_number;

  PERFORM helm.audit(
    'export.downloaded', 'export_job', p_export_job_id, 'success',
    v_job.organization_id, NULL, v_job.reason,
    jsonb_build_object(
      'kind', v_job.kind, 'include_secrets', v_job.include_secrets,
      'download_number', v_number, 'bytes', v_job.byte_size));

  RETURN QUERY SELECT true, NULL::text, v_job.storage_key, v_job.byte_size,
                      v_job.content_sha256, v_job.encryption_method, v_number;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.expire_exports — retire artefacts past their TTL.
--
-- Returns the storage keys so the worker can delete the bytes. Marking a row
-- expired while the file stays in the bucket is the failure this is guarding
-- against, so the two happen in one pass with the deletion driven by what this
-- returned.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.expire_exports()
  RETURNS TABLE (export_job_id uuid, storage_key text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  RETURN QUERY
  WITH expired AS (
    UPDATE export_job
    SET status = 'expired'
    WHERE tenant_id = v_tenant
      AND status = 'completed'
      AND revoked_at IS NULL
      AND expires_at <= now()
    RETURNING id, export_job.storage_key, organization_id, kind, downloaded_count
  ),
  logged AS (
    SELECT helm.audit('export.expired', 'export_job', e.id, 'success',
                      e.organization_id, NULL, NULL,
                      jsonb_build_object('kind', e.kind, 'downloads', e.downloaded_count))
    FROM expired e
  )
  SELECT e.id, e.storage_key FROM expired e
  WHERE (SELECT count(*) FROM logged) >= 0;
END;
$$;

-- -----------------------------------------------------------------------------
-- Grants.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION helm.request_export(uuid, export_kind, text, text, boolean, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.approve_export(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.revoke_export(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.begin_export_render(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.finish_export_render(uuid, export_status, text, bigint, bytea, text, integer, integer, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.claim_export_download(uuid, inet, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.expire_exports() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.export_backlog(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.request_export(uuid, export_kind, text, text, boolean, jsonb, integer) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.approve_export(uuid, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.revoke_export(uuid, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.begin_export_render(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.finish_export_render(uuid, export_status, text, bigint, bytea, text, integer, integer, jsonb, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.claim_export_download(uuid, inet, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.expire_exports() TO helm_app;

-- Cross-tenant: worker only, exactly like the other backlog enumerators.
GRANT EXECUTE ON FUNCTION helm.export_backlog(integer) TO helm_worker;

-- -----------------------------------------------------------------------------
-- Guards.
-- -----------------------------------------------------------------------------
DO $guard$
BEGIN
  IF has_function_privilege('helm_app', 'helm.export_backlog(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app must not enumerate exports across tenants';
  END IF;

  -- The four-eyes constraint is the load-bearing control of this entire file.
  -- If someone drops it while "simplifying", this migration must not pass.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'export_job'::regclass AND conname = 'export_job_four_eyes'
  ) THEN
    RAISE EXCEPTION 'helm: export_job_four_eyes is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'export_job'::regclass AND conname = 'export_job_secrets_need_approval'
  ) THEN
    RAISE EXCEPTION 'helm: export_job_secrets_need_approval is missing';
  END IF;
END
$guard$;
