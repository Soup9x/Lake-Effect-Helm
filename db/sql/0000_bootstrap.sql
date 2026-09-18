-- =============================================================================
-- 0000_bootstrap.sql — extensions, roles, and the RLS session-context API
--
-- Requires PostgreSQL 16+ (we rely on `security_invoker` views, which landed in
-- 15, and on 16's partition-wise behaviour for the audit log).
--
-- Must be executed by a role with CREATEROLE (on RDS: rds_superuser).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Schemas
--   public      — application tables, and nothing else
--   helm        — security helpers, SECURITY DEFINER API, maintenance routines
--   extensions  — third-party extension objects
--
-- Extensions get their own schema rather than landing in public. Two reasons,
-- and the second one bites hard:
--
--   1. `public` then contains exactly the application's own tables, which makes
--      the catalog assertions in 0200 and the schema drift check meaningful.
--   2. Privilege hygiene. Locking down `public` (0220 revokes EXECUTE on its
--      functions from PUBLIC) would otherwise strip EXECUTE from citext_eq,
--      digest() and friends — and every citext comparison in every policy and
--      constraint starts failing with "permission denied for function
--      citext_eq" for exactly the non-superuser roles the application runs as.
-- ----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS helm;
CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS pgcrypto  WITH SCHEMA extensions;  -- digest(), hmac()
CREATE EXTENSION IF NOT EXISTS citext    WITH SCHEMA extensions;  -- case-insensitive text
CREATE EXTENSION IF NOT EXISTS pg_trgm   WITH SCHEMA extensions;  -- fuzzy search
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA extensions;  -- composite GIN

-- Every session needs the extension schema on its path for DDL and for
-- SECURITY DEFINER bodies that call digest().
SET search_path = public, extensions;
COMMENT ON SCHEMA helm IS
  'Helm security kernel: session context, RLS predicates, audited secret access.';

-- Nobody creates objects in public implicitly.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- Roles
--
-- Deliberately four roles, not one. The blast radius of a compromised
-- application process should not include the auth token store or the key
-- wrapping table.
--
-- None of these are superusers and none have BYPASSRLS. That is load-bearing:
-- a role with BYPASSRLS silently disables every policy in this file.
-- Passwords are intentionally not set here — set them out of band or use
-- IAM / cert authentication.
-- ----------------------------------------------------------------------------
DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helm_migrator') THEN
    CREATE ROLE helm_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helm_app') THEN
    CREATE ROLE helm_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helm_auth') THEN
    CREATE ROLE helm_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helm_key_admin') THEN
    CREATE ROLE helm_key_admin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helm_auditor') THEN
    CREATE ROLE helm_auditor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$bootstrap$;

-- Defence in depth: if someone later grants one of these roles to a superuser
-- account by accident, FORCE ROW LEVEL SECURITY (applied in 0200) still keeps
-- table owners inside their policies.

GRANT USAGE ON SCHEMA helm       TO helm_app, helm_auth, helm_key_admin, helm_auditor;
GRANT USAGE ON SCHEMA public     TO helm_app, helm_auth, helm_key_admin, helm_auditor;
GRANT USAGE ON SCHEMA extensions TO helm_app, helm_auth, helm_key_admin, helm_auditor, helm_migrator;

-- Pin the search path per role so a runtime session resolves citext and
-- digest() without every call site qualifying them.
DO $paths$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['helm_app', 'helm_auth', 'helm_key_admin', 'helm_auditor', 'helm_migrator'] LOOP
    EXECUTE format('ALTER ROLE %I SET search_path = public, extensions', r);
  END LOOP;
  EXECUTE format('ALTER DATABASE %I SET search_path = public, extensions', current_database());
END
$paths$;

-- ----------------------------------------------------------------------------
-- Session context
--
-- Every RLS policy in Helm resolves against per-transaction GUCs that the
-- application sets with SET LOCAL at the start of each request transaction.
--
-- The design rule for all of these: AN UNSET CONTEXT MUST RESOLVE TO "NO
-- ACCESS", never to "all access". A connection that has not been through
-- helm.set_session_context() sees zero rows in every tenant table.
--
-- Threat-model note (see docs/architecture/01-security-model.md §5): GUC-based
-- RLS defends against *application logic* errors — a forgotten WHERE clause, a
-- mis-scoped join, an ORM helper that ignores the tenant. It does NOT by itself
-- defend against an attacker who can execute arbitrary SQL, because such an
-- attacker can issue their own SET. That is why helm.set_session_context()
-- derives role, rank, scope and permissions FROM THE DATABASE rather than
-- trusting the caller, and why all runtime queries are parameterised.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION helm.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT nullif(current_setting('helm.tenant_id', true), '')::uuid;
$$;
COMMENT ON FUNCTION helm.current_tenant_id() IS
  'Tenant for this transaction, or NULL when unset. NULL fails every policy closed.';

CREATE OR REPLACE FUNCTION helm.require_tenant_id() RETURNS uuid
  LANGUAGE plpgsql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('helm.tenant_id', true), '')::uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'helm: write attempted with no tenant context on this connection'
      USING ERRCODE = 'insufficient_privilege',
            HINT    = 'Call helm.set_session_context() inside the request transaction.';
  END IF;
  RETURN v_tenant;
END;
$$;
COMMENT ON FUNCTION helm.require_tenant_id() IS
  'Like current_tenant_id() but raises. Used in WITH CHECK so writes fail loudly '
  'rather than silently vanishing into a filtered-out row.';

CREATE OR REPLACE FUNCTION helm.current_actor_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT nullif(current_setting('helm.actor_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION helm.current_actor_type() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(nullif(current_setting('helm.actor_type', true), ''), 'anonymous');
$$;

CREATE OR REPLACE FUNCTION helm.current_role_key() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(nullif(current_setting('helm.role_key', true), ''), 'anonymous');
$$;

-- Numeric rank makes coarse "at least a Tier 2 tech" checks cheap inside
-- policies. Fine-grained authorisation uses helm.has_permission() instead.
CREATE OR REPLACE FUNCTION helm.current_role_rank() RETURNS integer
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(nullif(current_setting('helm.role_rank', true), '')::integer, 0);
$$;

-- Organisation scoping.
--   ''    (or unset) -> no organisations visible. Fail closed.
--   '*'              -> every organisation in the current tenant (MSP staff).
--   'uuid,uuid,...'  -> exactly those organisations (co-managed client users).
CREATE OR REPLACE FUNCTION helm.org_in_scope(p_organization_id uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_organization_id IS NULL THEN false
    WHEN coalesce(current_setting('helm.org_scope', true), '') = '' THEN false
    WHEN current_setting('helm.org_scope', true) = '*' THEN true
    ELSE p_organization_id = ANY (
      string_to_array(current_setting('helm.org_scope', true), ',')::uuid[]
    )
  END;
$$;
COMMENT ON FUNCTION helm.org_in_scope(uuid) IS
  'Organisation visibility for the current actor. Unset scope means nothing is '
  'visible, so a connection that skipped set_session_context() reads no rows.';

CREATE OR REPLACE FUNCTION helm.has_permission(p_permission text) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN coalesce(current_setting('helm.permissions', true), '') = '' THEN false
    ELSE p_permission = ANY (
      string_to_array(current_setting('helm.permissions', true), ',')
    )
  END;
$$;

-- Set by the app only after a fresh re-authentication (password re-entry,
-- WebAuthn assertion, or TOTP). Gates reveal of secrets flagged
-- requires_step_up.
--
-- NOTE: this is a boolean for the life of the request, with NO expiry. An
-- earlier version of this comment named a HELM_STEP_UP_TTL_MINUTES that was
-- documented in .env.example and read by nothing — see that file.
CREATE OR REPLACE FUNCTION helm.step_up_verified() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(nullif(current_setting('helm.step_up_verified', true), ''), 'off') = 'on';
$$;

CREATE OR REPLACE FUNCTION helm.current_request_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT nullif(current_setting('helm.request_id', true), '');
$$;

CREATE OR REPLACE FUNCTION helm.current_ip() RETURNS inet
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT nullif(current_setting('helm.ip', true), '')::inet;
$$;

CREATE OR REPLACE FUNCTION helm.current_user_agent() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT nullif(current_setting('helm.user_agent', true), '');
$$;

-- Convenience predicate reused across policies: MSP-side staff, i.e. anybody
-- whose scope is the whole tenant rather than a named client organisation.
CREATE OR REPLACE FUNCTION helm.is_tenant_wide() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(current_setting('helm.org_scope', true), '') = '*';
$$;

GRANT EXECUTE ON FUNCTION
  helm.current_tenant_id(), helm.require_tenant_id(), helm.current_actor_id(),
  helm.current_actor_type(), helm.current_role_key(), helm.current_role_rank(),
  helm.org_in_scope(uuid), helm.has_permission(text), helm.step_up_verified(),
  helm.current_request_id(), helm.current_ip(), helm.current_user_agent(),
  helm.is_tenant_wide()
TO helm_app, helm_key_admin, helm_auditor;

-- ----------------------------------------------------------------------------
-- Role ranks, as constants the seed data and the application agree on.
-- ----------------------------------------------------------------------------
--   100  super_admin        MSP owner / platform administrator
--    80  tier3              senior engineer, may manage schemas and integrations
--    60  tier2              full documentation + credential access
--    40  tier1              day-to-day tech, credential reveal is audited+gated
--    30  client_admin       client-side administrator, own organisation only
--    20  client_read_only   co-managed read access, no secret reveal
--    10  api_service        machine account, permissions come from its token
-- ----------------------------------------------------------------------------
