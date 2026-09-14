-- =============================================================================
-- 0220_grants.sql — privilege separation
--
-- RLS decides which ROWS a role can see. Grants decide which TABLES it can
-- touch at all. Both are needed: RLS on a table the application should never
-- open is one dropped policy away from exposure, and a grant without RLS gives
-- every tenant every row.
--
-- The four-role split in one sentence each:
--   helm_app       serves requests. No auth tokens, no ciphertext, no key writes.
--   helm_auth      serves logins. No tenant data at all.
--   helm_key_admin rotates keys and maintains partitions. No documentation.
--   helm_auditor   reads audit history. Writes nothing, anywhere.
-- =============================================================================

SET search_path = public, extensions;

-- Start from nothing. Default PUBLIC privileges on future objects are a
-- recurring source of accidental exposure.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA helm FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- helm_app
-- -----------------------------------------------------------------------------
DO $grants$
DECLARE
  r record;
  -- Tables helm_app must never open directly.
  v_denied text[] := ARRAY[
    'auth_account', 'auth_session', 'auth_verification_token', 'auth_authenticator',
    'secret_version',   -- reachable only via helm.reveal_secret()
    'audit_chain_head'  -- read via policy below, never written
  ];
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT (c.relname = ANY (v_denied))
      -- Audit partitions inherit the parent's grants.
      AND c.relname NOT LIKE 'audit_log\_2%'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO helm_app', r.relname);
  END LOOP;
END
$grants$;

-- Append-only tables: take the write verbs back.
REVOKE UPDATE, DELETE ON audit_log FROM helm_app;
REVOKE INSERT ON audit_log FROM helm_app;          -- helm.audit() only
REVOKE UPDATE, DELETE ON sop_version FROM helm_app;
REVOKE UPDATE, DELETE ON export_download FROM helm_app;

-- Reference data is read-only at runtime; changing a role's permissions is a
-- migration, not a request.
REVOKE INSERT, UPDATE, DELETE ON app_role, permission, role_permission FROM helm_app;
GRANT SELECT ON app_role, permission, role_permission TO helm_app;

-- Key material: read the wrapped blob, never write it.
REVOKE INSERT, UPDATE, DELETE ON tenant_data_key FROM helm_app;
GRANT SELECT ON tenant_data_key TO helm_app;

-- Tenant rows are created by provisioning, not by the request path.
REVOKE INSERT, DELETE ON tenant FROM helm_app;

GRANT SELECT ON audit_log, audit_chain_head TO helm_app;
GRANT SELECT ON v_secret_metadata, v_asset_edge, v_asset_edge_stored,
                v_asset_edge_labelled, v_expiration_dashboard, v_sop_run_progress
  TO helm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO helm_app;

-- -----------------------------------------------------------------------------
-- helm schema functions.
--
-- The blanket REVOKE above removed PUBLIC's default EXECUTE on everything in
-- `helm`, including the pure helpers that views and policies call
-- (expiration_severity, inverse_relation, normalise_terms). Without a grant,
-- selecting from v_expiration_dashboard fails with "permission denied for
-- function expiration_severity".
--
-- Rather than maintaining a list that will drift, the runtime roles get EXECUTE
-- on every IMMUTABLE or STABLE function that is not SECURITY DEFINER. That
-- split is exactly the right boundary:
--   * SECURITY DEFINER functions carry privilege and are granted one by one,
--     where they are defined, so adding one is a deliberate act.
--   * VOLATILE non-definer functions are the DDL and maintenance routines
--     (apply_tenant_rls, maintain_audit_partitions, rebuild_expirations) which
--     the request path has no business calling.
--   * What is left is pure computation, which is safe to expose and necessary
--     for the views to work at all.
-- -----------------------------------------------------------------------------
DO $helpers$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm'
      AND NOT p.prosecdef
      AND p.provolatile IN ('i', 's')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO helm_app, helm_auditor, helm_key_admin', r.sig);
  END LOOP;
END
$helpers$;

-- -----------------------------------------------------------------------------
-- helm_auth — the Auth.js adapter. Login tables and nothing else.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app_user, auth_account, auth_session, auth_verification_token, auth_authenticator
  TO helm_auth;
-- Needed to answer "which tenants may this user enter?" immediately after login.
GRANT SELECT ON membership, tenant TO helm_auth;

-- -----------------------------------------------------------------------------
-- helm_key_admin — key rotation and partition maintenance.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON tenant_data_key TO helm_key_admin;
GRANT SELECT ON tenant, organization, secret TO helm_key_admin;
GRANT SELECT ON audit_log, audit_chain_head TO helm_key_admin;
-- Rotation re-encrypts existing material under a new key, which is a normal
-- (audited) secret write.
GRANT EXECUTE ON FUNCTION
  helm.write_secret_version(uuid, uuid, bytea, bytea, bytea, text, bytea, smallint, smallint, text),
  helm.reveal_secret(uuid, text, text, integer)
  TO helm_key_admin;
GRANT EXECUTE ON FUNCTION helm.set_session_context(uuid, uuid, actor_type, text, inet, text, uuid)
  TO helm_key_admin;
GRANT EXECUTE ON FUNCTION helm.ensure_audit_partition(date) TO helm_key_admin;

-- -----------------------------------------------------------------------------
-- helm_auditor — read-only compliance access.
-- -----------------------------------------------------------------------------
DO $auditor$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND c.relname NOT IN ('auth_account', 'auth_session',
                            'auth_verification_token', 'auth_authenticator',
                            'secret_version', 'tenant_data_key')
      AND c.relname NOT LIKE 'audit_log\_2%'
  LOOP
    EXECUTE format('GRANT SELECT ON %I TO helm_auditor', r.relname);
  END LOOP;
END
$auditor$;

GRANT SELECT ON v_secret_metadata, v_asset_edge, v_expiration_dashboard TO helm_auditor;

-- -----------------------------------------------------------------------------
-- Default privileges for objects created by later migrations, so a new table
-- does not silently arrive with no grants (or, worse, PUBLIC ones).
-- -----------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO helm_auditor;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO helm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA helm REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Assertions. Cheaper to fail a migration than to discover either of these in
-- a penetration test.
-- -----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_bad text;
BEGIN
  -- Nothing may hold BYPASSRLS: it silently disables every policy in 0200.
  SELECT string_agg(rolname, ', ') INTO v_bad
  FROM pg_roles
  WHERE rolbypassrls AND rolname LIKE 'helm\_%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'helm: roles hold BYPASSRLS and would ignore all policies: %', v_bad;
  END IF;

  -- helm_app must not be able to read ciphertext except through the audited API.
  IF has_table_privilege('helm_app', 'secret_version', 'SELECT') THEN
    RAISE EXCEPTION 'helm: helm_app can SELECT secret_version directly — the audit '
                    'guarantee depends on it being unable to';
  END IF;

  -- helm_app must not be able to read session or OAuth tokens.
  IF has_table_privilege('helm_app', 'auth_session', 'SELECT')
     OR has_table_privilege('helm_app', 'auth_account', 'SELECT') THEN
    RAISE EXCEPTION 'helm: helm_app can read auth tokens';
  END IF;

  -- Audit history must not be rewritable by the application.
  IF has_table_privilege('helm_app', 'audit_log', 'UPDATE')
     OR has_table_privilege('helm_app', 'audit_log', 'DELETE') THEN
    RAISE EXCEPTION 'helm: helm_app can modify audit history';
  END IF;

  -- helm_auth must not reach tenant documentation.
  IF has_table_privilege('helm_auth', 'secret', 'SELECT')
     OR has_table_privilege('helm_auth', 'asset_node', 'SELECT') THEN
    RAISE EXCEPTION 'helm: helm_auth can read tenant data';
  END IF;

  -- Conversely: helm_app must be able to call the helpers its views depend on.
  -- A missing grant here surfaces as a runtime "permission denied for function"
  -- on a dashboard query, which is a confusing way to learn about it.
  SELECT string_agg(f, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'helm.expiration_severity(timestamptz, smallint)',
    'helm.inverse_relation(link_relation)',
    'helm.normalise_terms(text[])',
    'helm.org_in_scope(uuid)',
    'helm.has_permission(text)'
  ]) AS f
  WHERE NOT has_function_privilege('helm_app', f, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'helm: helm_app cannot execute required helper functions: %', v_bad;
  END IF;
END
$verify$;
