-- =============================================================================
-- 0900_seed_system_data.sql — roles and permissions
--
-- Reference data, not tenant data: it ships with the schema because the RLS
-- policies in 0200 name these permission keys directly. A deployment missing
-- 'secret:reveal' does not degrade gracefully, it denies everything.
-- =============================================================================

SET search_path = public, extensions;

INSERT INTO permission (key, category, description, msp_only) VALUES
  -- Organisations and documentation
  ('organization:read',    'organization', 'View client organisations', false),
  ('organization:write',   'organization', 'Create and edit client organisations', true),
  ('organization:delete',  'organization', 'Delete a client organisation', true),
  ('asset:read',           'asset',        'View assets and documentation', false),
  ('asset:write',          'asset',        'Create and edit assets', false),
  ('asset:delete',         'asset',        'Delete assets', false),
  ('asset:link',           'asset',        'Create and remove relationships between assets', false),

  -- Secrets. Reveal, export and rotation are deliberately separate: an account
  -- that can read one password on screen should not implicitly be able to walk
  -- out with every password in the tenant.
  ('secret:read',          'secret',       'See that a credential exists and its metadata', false),
  ('secret:reveal',        'secret',       'Decrypt and view secret material', false),
  ('secret:write',         'secret',       'Create and rotate secrets', false),
  ('secret:delete',        'secret',       'Delete secrets', true),
  ('secret:export',        'secret',       'Include secret material in an export', true),
  ('secret:audit',         'secret',       'Run vault-wide analyses such as reuse detection', true),

  -- Flexible assets and SOPs
  ('flexible_type:manage', 'schema',       'Create and publish flexible asset schemas', true),
  ('sop:read',             'sop',          'View procedures', false),
  ('sop:write',            'sop',          'Author and edit procedures', false),
  ('sop:execute',          'sop',          'Start and complete checklist runs', false),

  -- Platform
  ('user:read',            'identity',     'View users and memberships', false),
  ('user:write',           'identity',     'Invite, modify and revoke memberships', true),
  ('tenant:write',         'identity',     'Change tenant-level settings', true),
  ('integration:read',     'integration',  'View integration configuration and sync history', true),
  ('integration:manage',   'integration',  'Configure integrations and webhooks', true),
  ('audit:read',           'audit',        'Read the audit log', false),
  ('audit:verify',         'audit',        'Verify audit chain integrity', true),
  ('export:create',        'export',       'Request an export', false),
  ('export:approve',       'export',       'Approve a secret-bearing export', true),
  ('key:rotate',           'security',     'Rotate tenant data encryption keys', true),
  ('alert:manage',         'alert',        'Configure expiry alert rules', true);

INSERT INTO app_role (key, name, description, rank, is_tenant_wide, is_system) VALUES
  ('super_admin', 'Super Administrator',
   'Full control of the MSP tenant including keys, schemas and integrations.', 100, true, true),
  ('tier3', 'Tier 3 Engineer',
   'Senior engineer. Manages schemas, integrations and elevated credentials.', 80, true, true),
  ('tier2', 'Tier 2 Technician',
   'Full documentation and credential access across all clients.', 60, true, true),
  ('tier1', 'Tier 1 Technician',
   'Day-to-day support. Credential reveal is permitted but audited and gated.', 40, true, true),
  ('client_admin', 'Client Administrator',
   'Client-side administrator. Their own organisation only.', 30, false, true),
  ('client_read_only', 'Client Read Only',
   'Co-managed read access. Cannot reveal secrets.', 20, false, true),
  ('api_service', 'API Service Account',
   'Machine identity. Effective permissions are the intersection of this role and the token scopes.', 10, true, true);

-- super_admin: everything.
INSERT INTO role_permission (role_key, permission_key)
SELECT 'super_admin', key FROM permission;

-- tier3: everything except deleting organisations and approving their own exports.
INSERT INTO role_permission (role_key, permission_key)
SELECT 'tier3', key FROM permission
WHERE key NOT IN ('organization:delete', 'tenant:write', 'key:rotate');

INSERT INTO role_permission (role_key, permission_key) VALUES
  ('tier2', 'organization:read'),
  ('tier2', 'organization:write'),
  ('tier2', 'asset:read'),
  ('tier2', 'asset:write'),
  ('tier2', 'asset:delete'),
  ('tier2', 'asset:link'),
  ('tier2', 'secret:read'),
  ('tier2', 'secret:reveal'),
  ('tier2', 'secret:write'),
  ('tier2', 'sop:read'),
  ('tier2', 'sop:write'),
  ('tier2', 'sop:execute'),
  ('tier2', 'user:read'),
  ('tier2', 'audit:read'),
  ('tier2', 'export:create'),
  ('tier2', 'integration:read');

-- tier1: can do the job, cannot reshape the tenant. No delete, no export of
-- secrets, no schema or integration changes.
INSERT INTO role_permission (role_key, permission_key) VALUES
  ('tier1', 'organization:read'),
  ('tier1', 'asset:read'),
  ('tier1', 'asset:write'),
  ('tier1', 'asset:link'),
  ('tier1', 'secret:read'),
  ('tier1', 'secret:reveal'),
  ('tier1', 'secret:write'),
  ('tier1', 'sop:read'),
  ('tier1', 'sop:execute'),
  ('tier1', 'user:read'),
  ('tier1', 'audit:read');

-- client_admin: their own organisation, including its audit trail. Notably
-- holds secret:read but NOT secret:reveal — they can see that an MSP-managed
-- credential exists without being able to decrypt it.
INSERT INTO role_permission (role_key, permission_key) VALUES
  ('client_admin', 'organization:read'),
  ('client_admin', 'asset:read'),
  ('client_admin', 'asset:write'),
  ('client_admin', 'secret:read'),
  ('client_admin', 'sop:read'),
  ('client_admin', 'sop:execute'),
  ('client_admin', 'audit:read'),
  ('client_admin', 'export:create');

INSERT INTO role_permission (role_key, permission_key) VALUES
  ('client_read_only', 'organization:read'),
  ('client_read_only', 'asset:read'),
  ('client_read_only', 'sop:read');

-- api_service: the widest set a token MAY be granted. Every real token narrows
-- this further through api_token.scopes.
INSERT INTO role_permission (role_key, permission_key) VALUES
  ('api_service', 'organization:read'),
  ('api_service', 'asset:read'),
  ('api_service', 'asset:write'),
  ('api_service', 'asset:link'),
  ('api_service', 'secret:read'),
  ('api_service', 'secret:reveal'),
  ('api_service', 'integration:read');

-- -----------------------------------------------------------------------------
-- Assertions on the seeded model.
-- -----------------------------------------------------------------------------
DO $seed_check$
DECLARE
  v_bad text;
BEGIN
  -- No client-side role may hold an MSP-only permission. The trigger in 0020
  -- enforces this per row; this confirms the whole seeded set.
  SELECT string_agg(rp.role_key || '/' || rp.permission_key, ', ')
    INTO v_bad
  FROM role_permission rp
  JOIN app_role r ON r.key = rp.role_key
  JOIN permission p ON p.key = rp.permission_key
  WHERE p.msp_only AND NOT r.is_tenant_wide;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'helm: client-side roles hold MSP-only permissions: %', v_bad;
  END IF;

  -- Client roles must never be able to decrypt.
  IF EXISTS (
    SELECT 1 FROM role_permission rp
    JOIN app_role r ON r.key = rp.role_key
    WHERE rp.permission_key = 'secret:reveal' AND NOT r.is_tenant_wide
  ) THEN
    RAISE EXCEPTION 'helm: a client-side role holds secret:reveal';
  END IF;

  -- Every permission named in an RLS policy must exist, or that policy denies
  -- unconditionally and the failure shows up as a mysterious empty result set.
  SELECT string_agg(needed, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'organization:write', 'organization:delete', 'user:read', 'user:write',
    'audit:read', 'secret:reveal', 'secret:write', 'secret:export',
    'secret:audit', 'tenant:write'
  ]) AS needed
  WHERE needed NOT IN (SELECT key FROM permission);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'helm: RLS policies reference permissions that do not exist: %', v_bad;
  END IF;
END
$seed_check$;
