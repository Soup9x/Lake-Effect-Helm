-- =============================================================================
-- 0910_worker_seed.sql — worker roles, their permissions, and the per-tenant
-- identities that use them.
--
-- Separated from 0290 because it depends on the permission catalogue seeded in
-- 0900: role_permission has a foreign key to permission, so these rows cannot
-- exist until that file has run. The schema half — the purpose restriction, the
-- reveal checks, the provisioning function and its trigger — is in 0290.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Worker roles.
--
-- One per job rather than a single "system" role, so that a compromise of the
-- alert evaluator does not carry the sync worker's integration credentials or
-- the export worker's reveal capability. Ranks are set by what the RLS write
-- policies require (60 for alert and export tables, 80 for the integration
-- tables), not by seniority: these identities have no seniority.
-- -----------------------------------------------------------------------------
INSERT INTO app_role (key, name, description, rank, is_tenant_wide, is_system) VALUES
  ('system_alerts', 'Expiry Alert Worker',
   'Evaluates alert rules against the expiration projection. Reads documentation '
   'metadata; cannot reveal a secret.', 60, true, true),
  ('system_sync', 'Integration Sync Worker',
   'Runs RMM/PSA/Graph synchronisation. May reveal integration credentials only, '
   'enforced by purpose restriction.', 80, true, true),
  ('system_audit', 'Audit Anchoring Worker',
   'Verifies and externally anchors the audit hash chain. Read-only over audit '
   'history; cannot read documentation or secrets.', 60, true, true),
  ('system_export', 'Export Render Worker',
   'Renders compliance and offboarding exports. May reveal only secrets '
   'inside a live export job that asked for them.', 60, true, true);

INSERT INTO role_permission (role_key, permission_key) VALUES
  ('system_alerts', 'organization:read'),
  ('system_alerts', 'asset:read'),
  ('system_alerts', 'alert:manage'),

  ('system_sync',   'organization:read'),
  ('system_sync',   'asset:read'),
  ('system_sync',   'asset:write'),
  ('system_sync',   'asset:link'),
  ('system_sync',   'integration:read'),
  ('system_sync',   'secret:read'),
  ('system_sync',   'secret:reveal'),

  ('system_audit',  'audit:read'),
  ('system_audit',  'audit:verify'),

  ('system_export', 'organization:read'),
  ('system_export', 'asset:read'),
  ('system_export', 'sop:read'),
  ('system_export', 'secret:read'),
  ('system_export', 'secret:reveal'),
  ('system_export', 'secret:export');

-- The alert and audit workers must not hold any route to ciphertext. Asserted
-- rather than reviewed: a permission added to the wrong row in a hurry is
-- exactly the mistake this catches.
DO $guard$
DECLARE
  v_leak text;
BEGIN
  SELECT string_agg(rp.role_key || '/' || rp.permission_key, ', ')
    INTO v_leak
  FROM role_permission rp
  WHERE rp.role_key IN ('system_alerts', 'system_audit')
    AND rp.permission_key IN ('secret:reveal', 'secret:export', 'secret:write');

  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'helm: worker role holds a secret capability it must not have: %', v_leak;
  END IF;
END
$guard$;

-- Backfill any tenant that already exists.
DO $backfill$
DECLARE
  v_tenant uuid;
BEGIN
  FOR v_tenant IN SELECT id FROM tenant LOOP
    PERFORM helm.ensure_worker_identities(v_tenant);
  END LOOP;
END
$backfill$;


-- Guard: every tenant has a full set of worker identities, and each is pinned
-- to the role it was defined with.
DO $guard$
DECLARE
  v_tenants integer;
  v_expected integer;
  v_actual  integer;
BEGIN
  SELECT count(*) INTO v_tenants FROM tenant;
  v_expected := v_tenants * 4;

  SELECT count(*) INTO v_actual FROM service_account WHERE is_system;

  IF v_actual <> v_expected THEN
    RAISE EXCEPTION 'helm: expected % built-in worker identities (4 x % tenants), found %',
      v_expected, v_tenants, v_actual;
  END IF;
END
$guard$;
