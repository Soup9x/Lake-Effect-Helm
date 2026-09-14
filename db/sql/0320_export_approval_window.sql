-- =============================================================================
-- 0320_export_approval_window.sql — two defects the export engine exposed
--
-- Both were latent from Step 1 and both are the same shape: a control written
-- slightly too broadly, which turns out to forbid something legitimate.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. A secret-bearing export could not be PARKED awaiting approval.
--
-- The original constraint read:
--
--   NOT include_secrets OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
--
-- which is right about the destination and wrong about the journey: it makes
-- the unapproved state unrepresentable, so the only way to create a
-- credential-bearing export is to supply the approver at creation time — by the
-- requester, in the same call. That is not four eyes, it is one person typing
-- two names.
--
-- The fix keeps the guarantee exactly where it matters. A job may sit in
-- `queued` unapproved (that IS the state a reviewer is looking at), and may be
-- `revoked` unapproved (stopping something must never require approving it
-- first). Every other status — running, completed, expired, failed — still
-- demands an approver, and helm.begin_export_render() is the transition into
-- `running`, so an unapproved job is refused by the DATABASE at the moment it
-- would start reading credentials.
-- -----------------------------------------------------------------------------
ALTER TABLE export_job DROP CONSTRAINT export_job_secrets_need_approval;

ALTER TABLE export_job ADD CONSTRAINT export_job_secrets_need_approval CHECK (
  NOT include_secrets
  OR status IN ('queued', 'revoked')
  OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
);

COMMENT ON CONSTRAINT export_job_secrets_need_approval ON export_job IS
  'A credential-bearing export may await review in `queued` and may be stopped '
  'in `revoked`, but cannot enter `running` — and therefore cannot decrypt '
  'anything — without a recorded approver.';

-- -----------------------------------------------------------------------------
-- 2. v_secret_metadata was unusable by the role that needs it.
--
-- The view is security_invoker and LEFT JOINs secret_version for the current
-- version's strength score and length. No role has any privilege on
-- secret_version — deliberately; that is the control which makes
-- helm.reveal_secret() the only route to ciphertext — so every SELECT from the
-- view failed with "permission denied for table secret_version", including from
-- the asset detail route that has referenced it since Step 3.
--
-- Three ways to fix this and two of them are wrong:
--
--   Making the view SECURITY DEFINER would run it as the schema owner and
--   quietly bypass RLS on `secret`, turning a privilege error into a
--   cross-tenant read. No.
--
--   Granting column-level SELECT on the non-material columns removes the error
--   but achieves nothing else: secret_version has no SELECT policy at all, so
--   RLS still returns zero rows and strength_score would simply be NULL
--   forever. It also weakens the suite's assertion that helm_app "cannot SELECT
--   secret_version at all" into something narrower, in exchange for no
--   capability. No.
--
--   So: denormalise. The current version's strength and length are properties
--   of the secret as a whole, they are written by a SECURITY DEFINER function
--   that already has the privilege, and they are not material. Putting them on
--   `secret` lets the view drop the join entirely — which means the invariant
--   stays absolute: NO ROLE READS secret_version, for any column, ever.
-- -----------------------------------------------------------------------------
ALTER TABLE secret
  ADD COLUMN current_strength_score smallint,
  ADD COLUMN current_plaintext_length smallint,
  ADD COLUMN current_version_created_at timestamptz;

ALTER TABLE secret ADD CONSTRAINT secret_strength_range CHECK (
  current_strength_score IS NULL OR current_strength_score BETWEEN 0 AND 100
);

COMMENT ON COLUMN secret.current_strength_score IS
  'Strength of the CURRENT version, denormalised from secret_version so the '
  'vault index can flag weak credentials without anything being granted a read '
  'on the table that holds ciphertext.';

-- Backfill from the existing versions. Runs as the migration owner, which is
-- the only identity that may read secret_version at all.
UPDATE secret s
SET current_strength_score   = sv.strength_score,
    current_plaintext_length = sv.plaintext_length,
    current_version_created_at = sv.created_at
FROM secret_version sv
WHERE sv.secret_id = s.id AND sv.version = s.current_version;

-- -----------------------------------------------------------------------------
-- write_secret_version now maintains them.
--
-- Only the UPDATE of `secret` changes; the rest is carried over verbatim from
-- 0210 so the two definitions cannot drift on anything else.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.write_secret_version(
  p_secret_id       uuid,
  p_data_key_id     uuid,
  p_ciphertext      bytea,
  p_nonce           bytea,
  p_auth_tag        bytea,
  p_aad             text,
  p_reuse_hmac      bytea    DEFAULT NULL,
  p_strength_score  smallint DEFAULT NULL,
  p_plaintext_length smallint DEFAULT NULL,
  p_rotation_reason text     DEFAULT NULL
) RETURNS TABLE (
  version         integer,
  audit_event_uid uuid
)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $body$
DECLARE
  v_tenant     uuid := helm.require_tenant_id();
  v_secret     secret%ROWTYPE;
  v_next       integer;
  v_key_status data_key_status;
  v_event      uuid;
BEGIN
  SELECT * INTO v_secret FROM secret
  WHERE id = p_secret_id AND tenant_id = v_tenant AND deleted_at IS NULL;

  IF NOT FOUND OR NOT helm.org_in_scope(v_secret.organization_id) THEN
    PERFORM helm.audit('secret.write_denied', 'secret', p_secret_id, 'denied',
                       NULL, NULL, NULL, jsonb_build_object('cause', 'not_found_or_out_of_scope'));
    RAISE EXCEPTION 'helm: secret % not found', p_secret_id USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT helm.has_permission('secret:write') THEN
    PERFORM helm.audit('secret.write_denied', 'secret', p_secret_id, 'denied',
                       v_secret.organization_id, p_secret_id, NULL,
                       jsonb_build_object('cause', 'missing_permission'));
    RAISE EXCEPTION 'helm: secret:write is required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF helm.current_role_rank() < v_secret.min_role_rank THEN
    PERFORM helm.audit('secret.write_denied', 'secret', p_secret_id, 'denied',
                       v_secret.organization_id, p_secret_id, NULL,
                       jsonb_build_object('cause', 'insufficient_role_rank'));
    RAISE EXCEPTION 'helm: role rank % is below the % required by this secret',
      helm.current_role_rank(), v_secret.min_role_rank
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_secret.sensitivity = 'critical' AND NOT helm.step_up_verified() THEN
    PERFORM helm.audit('secret.write_denied', 'secret', p_secret_id, 'denied',
                       v_secret.organization_id, p_secret_id, NULL,
                       jsonb_build_object('cause', 'step_up_required'));
    RAISE EXCEPTION 'helm: step-up verification required to rotate a critical secret'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT status INTO v_key_status FROM tenant_data_key
  WHERE id = p_data_key_id AND tenant_id = v_tenant;

  IF v_key_status IS NULL THEN
    RAISE EXCEPTION 'helm: data key % does not belong to tenant %', p_data_key_id, v_tenant
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_key_status <> 'active' THEN
    RAISE EXCEPTION 'helm: data key % is % and cannot encrypt new material',
      p_data_key_id, v_key_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_next := v_secret.current_version + 1;

  INSERT INTO secret_version (
    tenant_id, secret_id, version, data_key_id, algorithm,
    ciphertext, nonce, auth_tag, aad,
    reuse_hmac, strength_score, plaintext_length,
    created_by, created_by_type, rotation_reason
  )
  VALUES (
    v_tenant, v_secret.id, v_next, p_data_key_id, 'AES-256-GCM',
    p_ciphertext, p_nonce, p_auth_tag, p_aad,
    p_reuse_hmac, p_strength_score, p_plaintext_length,
    helm.current_actor_id(), helm.current_actor_type()::actor_type, p_rotation_reason
  );

  UPDATE secret
  SET current_version  = v_next,
      last_rotated_at  = CASE WHEN v_next > 1 THEN now() ELSE last_rotated_at END,
      -- Denormalised so v_secret_metadata needs no read on secret_version.
      current_strength_score     = p_strength_score,
      current_plaintext_length   = p_plaintext_length,
      current_version_created_at = now(),
      updated_by       = helm.current_actor_id(),
      updated_at       = now()
  WHERE id = v_secret.id;

  v_event := helm.audit(
    CASE WHEN v_next = 1 THEN 'secret.created' ELSE 'secret.rotated' END,
    'secret', v_secret.id, 'success',
    v_secret.organization_id, v_secret.id, p_rotation_reason,
    jsonb_build_object(
      'version', v_next,
      'kind', v_secret.kind,
      'sensitivity', v_secret.sensitivity,
      'data_key_id', p_data_key_id,
      'strength_score', p_strength_score));

  RETURN QUERY SELECT v_next, v_event;
END;
$body$;

-- -----------------------------------------------------------------------------
-- The view, with no path to secret_version.
-- -----------------------------------------------------------------------------
DROP VIEW v_secret_metadata;

CREATE VIEW v_secret_metadata WITH (security_invoker = true, security_barrier = true) AS
SELECT
  s.id,
  s.tenant_id,
  s.organization_id,
  s.kind,
  s.sensitivity,
  s.label,
  s.current_version,
  s.requires_step_up,
  s.requires_reason,
  s.min_role_rank,
  s.rotation_interval_days,
  s.last_rotated_at,
  s.last_accessed_at,
  s.access_count,
  s.created_at,
  s.created_by,
  s.updated_at,
  CASE
    WHEN s.rotation_interval_days IS NULL THEN NULL
    ELSE coalesce(s.last_rotated_at, s.created_at)
         + (s.rotation_interval_days || ' days')::interval
  END AS rotation_due_at,
  s.current_strength_score AS strength_score,
  s.current_plaintext_length AS plaintext_length,
  s.current_version_created_at
FROM secret s
WHERE s.deleted_at IS NULL;

COMMENT ON VIEW v_secret_metadata IS
  'Listable secret surface. Reads only `secret`, never secret_version: no role '
  'holds any privilege on the table that stores ciphertext, and this view must '
  'not be the exception that quietly reintroduces one.';

GRANT SELECT ON v_secret_metadata TO helm_app, helm_auditor;

-- -----------------------------------------------------------------------------
-- Guard: the invariant, stated as a property of the catalog rather than of the
-- grant list. No runtime role may hold SELECT on any column of secret_version.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  v_role   text;
  v_column text;
  v_leak   text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['helm_app', 'helm_auth', 'helm_auditor', 'helm_key_admin', 'helm_worker'] LOOP
    FOR v_column IN
      SELECT attname FROM pg_attribute
      WHERE attrelid = 'secret_version'::regclass AND attnum > 0 AND NOT attisdropped
    LOOP
      IF has_column_privilege(v_role, 'secret_version', v_column, 'SELECT') THEN
        v_leak := coalesce(v_leak || ', ', '') || v_role || '.' || v_column;
      END IF;
    END LOOP;
  END LOOP;

  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'helm: a runtime role can read secret_version columns (%) — the audit '
      'guarantee of helm.reveal_secret() depends on this being impossible', v_leak;
  END IF;
END
$guard$;

-- Prove the view works, rather than trusting the grant list.
DO $smoke$
DECLARE
  v_count bigint;
BEGIN
  SET LOCAL ROLE helm_app;
  -- No tenant context, so RLS returns zero rows. Zero rows is the pass
  -- condition; a privilege error is the failure this is looking for.
  SELECT count(*) INTO v_count FROM v_secret_metadata;
  RESET ROLE;

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'helm: v_secret_metadata returned % rows with no tenant context', v_count;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RESET ROLE;
  RAISE EXCEPTION 'helm: helm_app still cannot read v_secret_metadata';
END
$smoke$;
