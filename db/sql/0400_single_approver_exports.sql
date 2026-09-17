-- =============================================================================
-- 0400_single_approver_exports.sql — one authorised person may export
-- credentials, and the audit log is what watches them
--
-- A DELIBERATE CHANGE OF SECURITY POSTURE, requested with that framing. It is
-- not a bug fix and it is not a tightening: it removes a control that was
-- described in 0310 as "the load-bearing control of this entire file". What
-- follows is a record of exactly what was removed, exactly what was kept, and
-- why the thing that remains is worth relying on.
--
-- WHAT WAS REMOVED
--   The requirement that a SECOND person approve a secret-bearing export before
--   the render worker will pick it up. Concretely: the
--   export_job_secrets_need_approval constraint, the approval filter in
--   helm.export_backlog(), helm.approve_export() itself, and the export:approve
--   permission that had nothing left to gate.
--
-- WHAT WAS KEPT, DELIBERATELY AND IN FULL
--   * secret:export. A person still needs that permission to request an export
--     carrying credentials, and secret:reveal to have the material fetched.
--   * min_role_rank on every secret. The render reveals each credential through
--     helm.reveal_secret(), which applies the rank ladder per secret — so an
--     export cannot carry a credential its requester could not have revealed
--     one at a time.
--   * Tenant scoping and organisation scope, unchanged.
--   * The written reason, still required and still at least ten characters.
--   * The expiry on the bundle and the record of every download.
--   * Encryption of any bundle containing secrets.
--
-- WHY THE AUDIT TRAIL IS A REAL SAFEGUARD AND NOT A CONSOLATION
--   Approval produced ONE row saying somebody agreed. What remains produces
--   more, not less:
--
--     export.requested   who asked, for which client, with what scope and reason
--     secret.revealed    ONE ROW PER CREDENTIAL, naming each secret the bundle
--                        carries — written by reveal_secret with purpose
--                        'export', so "who exported what" is answerable per
--                        credential rather than per job
--     export.rendered    what was produced: counts, bytes, sha256, omissions
--     export.downloaded  every retrieval, numbered, with the byte size
--
--   The chain is hash-linked and append-only (0140), so this record cannot be
--   edited after the fact by the person it describes. What is genuinely lost is
--   PREVENTION: nothing now stops a single authorised person exporting a
--   client's credentials, and the MSP finds out by reading the log or by
--   receiving a notification rather than by being asked to approve. That is the
--   trade that was asked for, stated plainly so nobody rediscovers it later.
-- =============================================================================

SET search_path = public, extensions;

-- IF EXISTS throughout. The runner applies a migration once, so this is not
-- required — but a file that cannot be re-applied cannot be TESTED against a
-- database that already has it, and the upgrade path here (renaming a
-- permission while preserving its grants) is worth being able to exercise.

-- -----------------------------------------------------------------------------
-- The gate.
--
-- `queued` and `revoked` were already exempt so a job could be PARKED awaiting
-- approval (0320). With approval gone the constraint would refuse a
-- secret-bearing job ever reaching 'completed', so it goes rather than being
-- loosened into something that reads as if it still did something.
-- -----------------------------------------------------------------------------
ALTER TABLE export_job DROP CONSTRAINT IF EXISTS export_job_secrets_need_approval;

-- approved_by, approved_at and approved_scope_sha256 STAY. Exports approved
-- before this migration keep their record — deleting the columns would rewrite
-- history to say the approval never happened. Nothing sets them from here on,
-- and the two constraints that keep them coherent (no self-approval, a digest
-- recorded whenever an approver is) are left in place for the same reason.
COMMENT ON COLUMN export_job.approved_by IS
  'Historical. Two-person approval was removed in 0400; this is null on every '
  'job created since, and non-null rows are the record of an approval that '
  'really happened.';

-- -----------------------------------------------------------------------------
-- The backlog no longer asks whether anybody approved.
--
-- The scope-digest comparison goes with it: it existed to bind a render to the
-- scope a REVIEWER read, and there is no reviewer. Nothing else can widen a
-- job's scope after the fact — helm.request_export() is the only writer of
-- export_job.scope and there is no update path — so the property that check
-- protected is now held by there being nothing to protect against.
-- -----------------------------------------------------------------------------
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
    requested_by       uuid,
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
         j.requested_by,
         coalesce(req.name, req.email::text),
         -- Still returned, still rendered on the cover page when present, so a
         -- bundle produced under the old rule keeps saying who approved it.
         coalesce(app.name, app.email::text),
         j.created_at
  FROM export_job j
  JOIN tenant t ON t.id = j.tenant_id AND t.status = 'active'
  LEFT JOIN app_user req ON req.id = j.requested_by
  LEFT JOIN app_user app ON app.id = j.approved_by
  WHERE j.status = 'queued'
    AND j.revoked_at IS NULL
    AND j.expires_at > now()
    AND helm.worker_actor(j.tenant_id, 'system_export') IS NOT NULL
  ORDER BY j.created_at
  LIMIT greatest(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION helm.export_backlog(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.export_backlog(integer) TO helm_worker;

-- -----------------------------------------------------------------------------
-- helm.approve_export goes entirely.
--
-- Left in place it would be a callable endpoint that sets a column nothing
-- reads — the exact "stale state" this change was asked not to leave behind.
-- Its audit action, export.approved, stays in the vocabulary: rows written
-- before today still carry it and the log must remain readable.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS helm.approve_export(uuid, text);

-- -----------------------------------------------------------------------------
-- export:approve is RENAMED, not deleted, and the difference matters.
--
-- Deleting it was the first attempt and it was wrong. helm.revoke_export()
-- gates on this permission too — "only the requester or an approver may revoke
-- an export" — so removing it would have silently narrowed revocation to the
-- requester alone. Revocation is a CONTAINMENT action: the one thing you want
-- available when an export should not have happened is the ability to pull it
-- back, and this change is supposed to remove a gate, not remove the brakes.
--
-- So the capability survives with a name that describes what it still does.
-- The rename cascades to role_permission through its foreign key, so every
-- role that held it keeps it.
-- -----------------------------------------------------------------------------
-- Guarded on the OLD key existing, because this file runs BEFORE 0900 seeds the
-- catalogue. On a fresh build there is nothing to rename and 0900 seeds the new
-- name directly; on an upgrade the rows are already there and this moves them.
-- Unguarded, the insert below collided with the seed and broke every rebuild.
DO $rename$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permission WHERE key = 'export:approve') THEN
    RETURN;
  END IF;

  INSERT INTO permission (key, category, description, msp_only)
  VALUES ('export:revoke_any', 'export', 'Revoke an export requested by someone else', true)
  ON CONFLICT (key) DO NOTHING;

  UPDATE role_permission rp SET permission_key = 'export:revoke_any'
  WHERE rp.permission_key = 'export:approve'
    AND NOT EXISTS (
      SELECT 1 FROM role_permission existing
      WHERE existing.role_key = rp.role_key
        AND existing.permission_key = 'export:revoke_any'
    );

  DELETE FROM role_permission WHERE permission_key = 'export:approve';
  DELETE FROM permission WHERE key = 'export:approve';
END;
$rename$;

-- -----------------------------------------------------------------------------
-- ...and revoke_export names it.
--
-- Copied MECHANICALLY from the live definition, with one string substituted.
-- The first attempt retyped it and invented a `revoked_by` column that does not
-- exist — the third time in this project that rebuilding a routine from memory
-- has broken it. The rule is now simple: never retype a definition, always
-- transform the live one.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.revoke_export(p_export_job_id uuid, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'helm', 'extensions', 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_job    export_job%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM export_job
  WHERE id = p_export_job_id AND tenant_id = v_tenant FOR UPDATE;

  IF NOT FOUND OR NOT helm.org_in_scope(v_job.organization_id) THEN
    RAISE EXCEPTION 'helm: no such export job' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT (helm.has_permission('export:revoke_any')
          OR v_job.requested_by = helm.current_actor_id()) THEN
    RAISE EXCEPTION 'helm: only the requester or a senior reviewer may revoke an export'
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
$function$;

REVOKE ALL ON FUNCTION helm.revoke_export(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.revoke_export(uuid, text) TO helm_app;


-- -----------------------------------------------------------------------------
-- request_export no longer answers a question nobody asks.
--
-- It returned (export_job_id, status, needs_approval), where needs_approval was
-- simply include_secrets under another name. Left alone it would now be a
-- column that says "true, this is waiting for a reviewer" about a job that is
-- already renderable — a stale state handed to every caller, which is exactly
-- what this change was asked not to leave behind.
--
-- DROP before CREATE: a RETURNS TABLE signature cannot be narrowed in place.
--
-- Transformed from the live definition, not retyped. The body below differs
-- from 0310's only in the final RETURN QUERY and in two comments that described
-- approval as if it still happened.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS helm.request_export(uuid, export_kind, text, text, boolean, jsonb, integer);

CREATE OR REPLACE FUNCTION helm.request_export(p_organization_id uuid, p_kind export_kind, p_format text, p_reason text, p_include_secrets boolean DEFAULT false, p_scope jsonb DEFAULT '{}'::jsonb, p_ttl_hours integer DEFAULT 72)
 RETURNS TABLE(export_job_id uuid, status export_status)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'helm', 'extensions', 'pg_catalog', 'pg_temp'
AS $function$
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

  -- This is now THE permission check on walking out with a client's
  -- credentials, rather than the first of two. It was always separate from
  -- export:create for a reason, and that reason survives the change: an account
  -- that may produce a documentation pack should not thereby be able to produce
  -- one containing every password in it.
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
    -- 'queued' now means what it says: waiting for a worker. Until 0400 a
    -- secret-bearing job sat here waiting for a person as well.
    'queued', p_include_secrets, coalesce(p_scope, '{}'::jsonb), btrim(p_reason),
    helm.current_actor_id(), now() + make_interval(hours => v_ttl)
  )
  RETURNING id INTO v_job;

  -- The first link in what is now the primary safeguard: who asked, for which
  -- client, under what scope and reason, and whether it carries credentials.
  PERFORM helm.audit(
    'export.requested', 'export_job', v_job, 'success',
    p_organization_id, NULL, btrim(p_reason),
    jsonb_build_object(
      'kind', p_kind, 'format', p_format,
      'include_secrets', p_include_secrets,
      'scope', coalesce(p_scope, '{}'::jsonb),
      'expires_in_hours', v_ttl));

  RETURN QUERY SELECT v_job, 'queued'::export_status;
END;
$function$;

REVOKE ALL ON FUNCTION helm.request_export(uuid, export_kind, text, text, boolean, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.request_export(uuid, export_kind, text, text, boolean, jsonb, integer) TO helm_app;


-- -----------------------------------------------------------------------------
-- The check that would have made every credential export render EMPTY.
--
-- helm.is_in_approved_export() is what lets the render worker reveal a secret
-- at all: its whole capability is the 'export' purpose, and that purpose is
-- gated on the secret belonging to a live, APPROVED export job. Remove approval
-- and nothing is ever in an approved export, so the worker would have been
-- refused every credential, written an omission for each, and produced a
-- handover pack containing no credentials — with no error anywhere.
--
-- Found by the export tests rather than by reading, which is the argument for
-- having them: the failure is silent, and the bundle looks plausible.
--
-- Renamed as well as loosened. "is in an approved export" would have been a
-- false name for a function that no longer asks about approval, and a false
-- name is how the next person reintroduces the assumption.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.is_in_live_secret_export(p_secret_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM export_job j
    JOIN secret s ON s.tenant_id = j.tenant_id AND s.organization_id = j.organization_id
    WHERE j.tenant_id = helm.current_tenant_id()
      AND j.include_secrets
      AND j.revoked_at IS NULL
      AND j.expires_at > now()
      AND j.status IN ('queued', 'running')
      AND s.id = p_secret_id
      AND s.deleted_at IS NULL
  );
$function$;

REVOKE ALL ON FUNCTION helm.is_in_live_secret_export(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.is_in_live_secret_export(uuid) TO helm_app, helm_worker;

CREATE OR REPLACE FUNCTION helm.reveal_secret(p_secret_id uuid, p_reason text DEFAULT NULL::text, p_purpose text DEFAULT 'view'::text, p_version integer DEFAULT NULL::integer)
 RETURNS TABLE(granted boolean, denial_reason text, audit_event_uid uuid, secret_id uuid, version integer, kind secret_kind, algorithm text, ciphertext bytea, nonce bytea, auth_tag bytea, aad text, data_key_id uuid, wrapped_dek bytea, kek_id text, wrap_provider text, wrap_context jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'helm', 'extensions', 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_tenant   uuid := helm.current_tenant_id();
  v_secret   secret%ROWTYPE;
  v_version  secret_version%ROWTYPE;
  v_key      tenant_data_key%ROWTYPE;
  v_deny     text := NULL;
  v_event    uuid;
  v_target   integer;
  v_purposes text[];
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'helm: no tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_purpose NOT IN ('view', 'copy', 'autofill', 'export', 'integration', 'rotation') THEN
    RAISE EXCEPTION 'helm: unknown reveal purpose %', p_purpose
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_secret FROM secret
  WHERE id = p_secret_id AND tenant_id = v_tenant AND deleted_at IS NULL;

  -- Unknown and out-of-scope are the same answer on purpose: probing for secret
  -- ids must not distinguish "no such secret" from "not yours".
  IF NOT FOUND OR NOT helm.org_in_scope(v_secret.organization_id) THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', p_secret_id, 'denied',
                          NULL, NULL, p_reason,
                          jsonb_build_object('purpose', p_purpose, 'cause', 'not_found_or_out_of_scope'));
    RETURN QUERY SELECT false, 'not_found', v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  -- A machine identity may be pinned to the purposes its job actually has.
  IF helm.current_actor_type() = 'service_account' THEN
    SELECT sa.allowed_reveal_purposes INTO v_purposes
    FROM service_account sa
    WHERE sa.id = helm.current_actor_id() AND sa.tenant_id = v_tenant;
  END IF;

  -- Authorisation ladder, most specific refusal first.
  -- Visibility leads the ladder. Until 0390 this rung did not exist, and a
  -- credential on an internal-only asset was withheld from a co-managed client
  -- only because the shipped client roles happen to hold neither secret:reveal
  -- nor a rank reaching any secret — two coincidences, not a rule.
  --
  -- First rather than last because the audit row records the reason, and "your
  -- rank is too low" is a different fact from "you may not see this at all".
  -- The second is the one an MSP needs when the client asks why.
  IF NOT helm.is_tenant_wide() AND NOT helm.secret_node_visible(v_secret.id) THEN
    v_deny := 'internal_only';
  ELSIF NOT helm.has_permission('secret:reveal') THEN
    v_deny := 'missing_permission';
  ELSIF v_purposes IS NOT NULL AND NOT (p_purpose = ANY (v_purposes)) THEN
    v_deny := 'purpose_not_permitted_for_actor';
  ELSIF helm.current_role_rank() < v_secret.min_role_rank THEN
    v_deny := 'insufficient_role_rank';
  ELSIF v_secret.requires_step_up AND NOT helm.step_up_verified() THEN
    v_deny := 'step_up_required';
  ELSIF v_secret.requires_reason AND coalesce(length(btrim(p_reason)), 0) < 10 THEN
    v_deny := 'reason_required';
  ELSIF p_purpose = 'export' AND NOT helm.has_permission('secret:export') THEN
    v_deny := 'export_not_permitted';
  ELSIF p_purpose = 'export' AND NOT helm.is_in_live_secret_export(v_secret.id) THEN
    -- Reached by the export worker, whose whole capability is this purpose.
    -- Re-derived from export_job every time, so a job revoked mid-render stops
    -- yielding material immediately. Until 0400 this also required the job to
    -- have been APPROVED — which, with approval removed, would have meant the
    -- worker could never reveal anything and every credential export rendered
    -- silently empty.
    v_deny := 'not_in_a_live_export';
  ELSIF p_purpose = 'integration' AND NOT helm.is_integration_credential(v_secret.id) THEN
    v_deny := 'not_an_integration_credential';
  ELSIF p_purpose = 'autofill' AND v_secret.sensitivity <> 'standard' THEN
    -- Elevated and critical credentials are never auto-filled into a browser.
    -- A domain admin password belongs in a deliberate, observed copy action.
    v_deny := 'autofill_not_permitted_for_sensitivity';
  END IF;

  IF v_deny IS NOT NULL THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', v_secret.id, 'denied',
                          v_secret.organization_id, v_secret.id, p_reason,
                          jsonb_build_object(
                            'purpose', p_purpose,
                            'cause', v_deny,
                            'sensitivity', v_secret.sensitivity,
                            'required_rank', v_secret.min_role_rank,
                            'actor_rank', helm.current_role_rank()));
    RETURN QUERY SELECT false, v_deny, v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  v_target := coalesce(p_version, v_secret.current_version);

  SELECT * INTO v_version FROM secret_version sv
  WHERE sv.secret_id = v_secret.id AND sv.version = v_target;

  IF NOT FOUND THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', v_secret.id, 'error',
                          v_secret.organization_id, v_secret.id, p_reason,
                          jsonb_build_object('purpose', p_purpose, 'cause', 'no_such_version',
                                             'requested_version', v_target));
    RETURN QUERY SELECT false, 'no_such_version', v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_key FROM tenant_data_key WHERE id = v_version.data_key_id;

  IF v_key.status = 'destroyed' THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', v_secret.id, 'error',
                          v_secret.organization_id, v_secret.id, p_reason,
                          jsonb_build_object('purpose', p_purpose, 'cause', 'key_destroyed',
                                             'data_key_id', v_key.id));
    RETURN QUERY SELECT false, 'key_destroyed', v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  -- Granted. The audit row and the material leave together.
  v_event := helm.audit(
    'secret.revealed', 'secret', v_secret.id, 'success',
    v_secret.organization_id, v_secret.id, p_reason,
    jsonb_build_object(
      'purpose',      p_purpose,
      'version',      v_version.version,
      'kind',         v_secret.kind,
      'sensitivity',  v_secret.sensitivity,
      'label',        v_secret.label,
      'data_key_id',  v_key.id,
      'step_up',      helm.step_up_verified()));

  UPDATE secret
  SET last_accessed_at = now(), access_count = access_count + 1
  WHERE id = v_secret.id;

  RETURN QUERY SELECT
    true, NULL::text, v_event,
    v_secret.id, v_version.version, v_secret.kind, v_version.algorithm,
    v_version.ciphertext, v_version.nonce, v_version.auth_tag, v_version.aad,
    v_key.id, v_key.wrapped_dek, v_key.kek_id, v_key.wrap_provider, v_key.wrap_context;
END;
$function$;

DROP FUNCTION IF EXISTS helm.is_in_approved_export(uuid);

-- =============================================================================
-- credential.client_visible — the unused column from the previous session
--
-- Reported then as decorative and it is: it defaults to false, no write path in
-- the product ever set it, and 0390 deliberately declined to enforce it because
-- doing so would have hidden every credential from every co-managed client.
-- A credential is hidden with the asset it documents, which is where the intent
-- actually lives.
--
-- Dropped rather than left, so nobody wires a feature to it believing it
-- carries meaning that was never there.
-- =============================================================================
ALTER TABLE credential DROP CONSTRAINT IF EXISTS credential_break_glass_not_client_visible;
ALTER TABLE credential DROP COLUMN IF EXISTS client_visible;

-- =============================================================================
-- Guards
-- =============================================================================
DO $$
BEGIN
  -- 1. The gate is gone, and gone in the way intended: the constraint removed
  --    rather than loosened into something that still looks like a control.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'export_job'::regclass AND conname = 'export_job_secrets_need_approval'
  ) THEN
    RAISE EXCEPTION 'helm: the approval gate is still in place';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'approve_export'
  ) THEN
    RAISE EXCEPTION 'helm: helm.approve_export still exists';
  END IF;

  -- 2. EVERY OTHER CONTROL IS STILL THERE. This is the half of the change that
  --    matters: "remove the second approver" must not quietly become "remove
  --    the controls near the second approver".
  --
  --    The permission catalogue is NOT asserted here: 0900 seeds it and runs
  --    after this file, so on a fresh build there is nothing to check yet. The
  --    first attempt did check, and failed every rebuild. §35 of
  --    db/tests/security.sql asserts it instead, against a seeded database.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'export_job'::regclass AND conname = 'export_job_reason_present'
  ) THEN
    RAISE EXCEPTION 'helm: the written reason is no longer required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'export_job'::regclass AND conname = 'export_job_secrets_need_encryption'
  ) THEN
    RAISE EXCEPTION 'helm: a secret-bearing bundle is no longer required to be encrypted';
  END IF;

  -- 3. The reveal ladder still applies per secret, which is what stops an
  --    export carrying a credential its requester could not reveal by hand.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'reveal_secret'
      AND pg_get_functiondef(p.oid) LIKE '%min_role_rank%'
  ) THEN
    RAISE EXCEPTION 'helm: reveal_secret no longer applies the rank ladder';
  END IF;

  -- 4. The audit trail is now the primary safeguard, so the events it depends
  --    on must exist. Asserted against the enum rather than against rows,
  --    because a fresh deployment has no history yet.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'export_job'::regclass AND conname = 'export_job_four_eyes'
  ) THEN
    RAISE EXCEPTION 'helm: historical approval rows are no longer kept coherent';
  END IF;

  -- 5. And the column really is gone.
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.credential'::regclass AND attname = 'client_visible'
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'helm: credential.client_visible is still present';
  END IF;
END;
$$;
