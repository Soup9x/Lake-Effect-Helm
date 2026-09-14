-- =============================================================================
-- 0200_rls_policies.sql — row level security
--
-- Three layers of isolation, in order of how much you should trust them:
--
--   1. STRUCTURAL. Composite (id, tenant_id) foreign keys make a cross-tenant
--      reference impossible regardless of policy. This survives someone
--      dropping every policy in this file.
--   2. RLS. Every tenant-scoped table filters on helm.current_tenant_id() and
--      helm.org_in_scope(). Fails closed with no context.
--   3. APPLICATION. Drizzle query helpers add tenant predicates. Convenience
--      and query performance — never the security boundary.
--
-- Policy conventions used throughout:
--   * Separate policies per command. A single FOR ALL policy applies its USING
--     clause as the WITH CHECK for writes, which quietly permits an UPDATE that
--     moves a row *out* of your tenant.
--   * USING uses current_tenant_id() (unset -> no rows). WITH CHECK uses
--     require_tenant_id() (unset -> exception). Reads fail quiet, writes fail
--     loud.
--   * FORCE ROW LEVEL SECURITY everywhere, so the table owner is also subject.
--     Without it, a migration or a job connecting as the owner sees everything.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Bulk application of the standard policy set.
--
-- Written as a loop over the catalog rather than 200 hand-written statements:
-- the failure mode of hand-writing them is one table quietly missing a policy,
-- and that table is the breach. The catalog cannot forget a table.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.apply_tenant_rls(
  p_table       text,
  p_org_scoped  boolean DEFAULT true,
  p_write_rank  integer DEFAULT 40
) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_read_predicate  text;
  v_write_predicate text;
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);

  IF p_org_scoped THEN
    v_read_predicate := 'tenant_id = helm.current_tenant_id() '
                     || 'AND helm.org_in_scope(organization_id)';
    v_write_predicate := 'tenant_id = helm.require_tenant_id() '
                      || 'AND helm.org_in_scope(organization_id) '
                      || format('AND helm.current_role_rank() >= %s', p_write_rank);
  ELSE
    -- Tenant-scoped but not organisation-scoped: settings, type definitions,
    -- integration connections. Only tenant-wide actors may see these at all.
    v_read_predicate := 'tenant_id = helm.current_tenant_id() '
                     || 'AND helm.is_tenant_wide()';
    v_write_predicate := 'tenant_id = helm.require_tenant_id() '
                      || 'AND helm.is_tenant_wide() '
                      || format('AND helm.current_role_rank() >= %s', p_write_rank);
  END IF;

  EXECUTE format(
    'CREATE POLICY %I ON %I FOR SELECT USING (%s)',
    p_table || '_rls_select', p_table, v_read_predicate);

  EXECUTE format(
    'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)',
    p_table || '_rls_insert', p_table, v_write_predicate);

  -- UPDATE needs both: USING decides which rows you may target, WITH CHECK
  -- decides what they may become. Omitting WITH CHECK lets an UPDATE rewrite
  -- tenant_id and launder a row into another tenant.
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',
    p_table || '_rls_update', p_table, v_read_predicate, v_write_predicate);

  EXECUTE format(
    'CREATE POLICY %I ON %I FOR DELETE USING (%s)',
    p_table || '_rls_delete', p_table, v_write_predicate);
END;
$$;

-- -----------------------------------------------------------------------------
-- Organisation-scoped tables.
-- -----------------------------------------------------------------------------
SELECT helm.apply_tenant_rls('site', true, 40);
SELECT helm.apply_tenant_rls('contact', true, 40);
SELECT helm.apply_tenant_rls('asset_node', true, 40);
SELECT helm.apply_tenant_rls('sop_run', true, 40);
SELECT helm.apply_tenant_rls('expiration', true, 40);
SELECT helm.apply_tenant_rls('attachment', true, 40);
SELECT helm.apply_tenant_rls('note', true, 40);
SELECT helm.apply_tenant_rls('export_job', true, 60);
SELECT helm.apply_tenant_rls('search_document', true, 40);
SELECT helm.apply_tenant_rls('secret', true, 40);

-- organization is scoped by its OWN id rather than by an organization_id
-- column, so it gets bespoke policies instead of the generic set.
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_rls_select ON organization FOR SELECT
  USING (tenant_id = helm.current_tenant_id() AND helm.org_in_scope(id));
-- Creating a client is an MSP-side act; a client-scoped actor can never
-- conjure a new organisation (and could not see it if they did).
CREATE POLICY organization_rls_insert ON organization FOR INSERT
  WITH CHECK (tenant_id = helm.require_tenant_id()
              AND helm.is_tenant_wide()
              AND helm.has_permission('organization:write'));
CREATE POLICY organization_rls_update ON organization FOR UPDATE
  USING (tenant_id = helm.current_tenant_id() AND helm.org_in_scope(id))
  WITH CHECK (tenant_id = helm.require_tenant_id()
              AND helm.org_in_scope(id)
              AND helm.has_permission('organization:write'));
CREATE POLICY organization_rls_delete ON organization FOR DELETE
  USING (tenant_id = helm.current_tenant_id()
         AND helm.is_tenant_wide()
         AND helm.has_permission('organization:delete'));

-- -----------------------------------------------------------------------------
-- Tenant-scoped, MSP-only tables.
-- -----------------------------------------------------------------------------
SELECT helm.apply_tenant_rls('flexible_asset_type', false, 80);
SELECT helm.apply_tenant_rls('flexible_asset_type_version', false, 80);
SELECT helm.apply_tenant_rls('integration_connection', false, 80);
SELECT helm.apply_tenant_rls('integration_sync_run', false, 80);
SELECT helm.apply_tenant_rls('external_identity', false, 80);
SELECT helm.apply_tenant_rls('webhook_endpoint', false, 80);
SELECT helm.apply_tenant_rls('webhook_delivery', false, 80);
SELECT helm.apply_tenant_rls('alert_rule', false, 60);
SELECT helm.apply_tenant_rls('alert_event', false, 60);
SELECT helm.apply_tenant_rls('service_account', false, 80);
SELECT helm.apply_tenant_rls('api_token', false, 80);
SELECT helm.apply_tenant_rls('browser_extension_install', false, 40);

-- -----------------------------------------------------------------------------
-- Subtype tables: visibility follows the parent node.
--
-- They have no organization_id of their own, and denormalising one would be a
-- second source of truth that can disagree with asset_node. An EXISTS against
-- asset_node is the correct predicate; asset_node's own policy then applies to
-- that lookup, so the check composes rather than duplicating the scoping rules.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.apply_node_subtype_rls(
  p_table      text,
  p_write_rank integer DEFAULT 40
) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_read text := format(
    'tenant_id = helm.current_tenant_id() AND EXISTS ('
    'SELECT 1 FROM asset_node n WHERE n.id = %I.id '
    'AND n.tenant_id = helm.current_tenant_id() '
    'AND helm.org_in_scope(n.organization_id))', p_table);
  v_write text := format(
    'tenant_id = helm.require_tenant_id() AND helm.current_role_rank() >= %s AND EXISTS ('
    'SELECT 1 FROM asset_node n WHERE n.id = %I.id '
    'AND n.tenant_id = helm.current_tenant_id() '
    'AND helm.org_in_scope(n.organization_id))', p_write_rank, p_table);
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)',
                 p_table || '_rls_select', p_table, v_read);
  EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)',
                 p_table || '_rls_insert', p_table, v_write);
  EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',
                 p_table || '_rls_update', p_table, v_read, v_write);
  EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)',
                 p_table || '_rls_delete', p_table, v_write);
END;
$$;

SELECT helm.apply_node_subtype_rls('device', 40);
SELECT helm.apply_node_subtype_rls('network', 40);
SELECT helm.apply_node_subtype_rls('ip_address', 40);
SELECT helm.apply_node_subtype_rls('domain', 60);
SELECT helm.apply_node_subtype_rls('ssl_certificate', 60);
SELECT helm.apply_node_subtype_rls('application', 40);
SELECT helm.apply_node_subtype_rls('directory_service', 60);
SELECT helm.apply_node_subtype_rls('contract', 60);
SELECT helm.apply_node_subtype_rls('license', 40);
SELECT helm.apply_node_subtype_rls('isp_circuit', 40);
SELECT helm.apply_node_subtype_rls('vendor', 40);
SELECT helm.apply_node_subtype_rls('credential', 40);
SELECT helm.apply_node_subtype_rls('sop', 60);
SELECT helm.apply_node_subtype_rls('flexible_asset_record', 40);

-- -----------------------------------------------------------------------------
-- Tables scoped through a parent row rather than through asset_node.
-- -----------------------------------------------------------------------------
ALTER TABLE asset_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_link FORCE ROW LEVEL SECURITY;

-- Both endpoints must be visible. A link whose far end is out of scope would
-- leak the existence of another client's asset through the dependency map.
CREATE POLICY asset_link_rls_select ON asset_link FOR SELECT
  USING (
    tenant_id = helm.current_tenant_id()
    AND EXISTS (SELECT 1 FROM asset_node n WHERE n.id = asset_link.source_node_id
                AND helm.org_in_scope(n.organization_id))
    AND EXISTS (SELECT 1 FROM asset_node n WHERE n.id = asset_link.target_node_id
                AND helm.org_in_scope(n.organization_id))
  );
CREATE POLICY asset_link_rls_insert ON asset_link FOR INSERT
  WITH CHECK (
    tenant_id = helm.require_tenant_id()
    AND helm.current_role_rank() >= 40
    AND EXISTS (SELECT 1 FROM asset_node n WHERE n.id = asset_link.source_node_id
                AND helm.org_in_scope(n.organization_id))
    AND EXISTS (SELECT 1 FROM asset_node n WHERE n.id = asset_link.target_node_id
                AND helm.org_in_scope(n.organization_id))
  );
CREATE POLICY asset_link_rls_update ON asset_link FOR UPDATE
  USING (tenant_id = helm.current_tenant_id() AND helm.current_role_rank() >= 40)
  WITH CHECK (
    tenant_id = helm.require_tenant_id()
    AND EXISTS (SELECT 1 FROM asset_node n WHERE n.id = asset_link.source_node_id
                AND helm.org_in_scope(n.organization_id))
    AND EXISTS (SELECT 1 FROM asset_node n WHERE n.id = asset_link.target_node_id
                AND helm.org_in_scope(n.organization_id))
  );
CREATE POLICY asset_link_rls_delete ON asset_link FOR DELETE
  USING (
    tenant_id = helm.current_tenant_id()
    AND helm.current_role_rank() >= 40
    AND EXISTS (SELECT 1 FROM asset_node n WHERE n.id = asset_link.source_node_id
                AND helm.org_in_scope(n.organization_id))
  );

CREATE OR REPLACE FUNCTION helm.apply_child_rls(
  p_table        text,
  p_parent_table text,
  p_parent_fk    text,
  p_write_rank   integer DEFAULT 40
) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  -- The parent's own RLS applies to this EXISTS, so scoping is inherited
  -- rather than restated.
  v_pred text := format(
    'tenant_id = helm.current_tenant_id() AND EXISTS ('
    'SELECT 1 FROM %I p WHERE p.id = %I.%I)', p_parent_table, p_table, p_parent_fk);
  v_write text := format(
    'tenant_id = helm.require_tenant_id() AND helm.current_role_rank() >= %s AND EXISTS ('
    'SELECT 1 FROM %I p WHERE p.id = %I.%I)', p_write_rank, p_parent_table, p_table, p_parent_fk);
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)',
                 p_table || '_rls_select', p_table, v_pred);
  EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)',
                 p_table || '_rls_insert', p_table, v_write);
  EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',
                 p_table || '_rls_update', p_table, v_pred, v_write);
  EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)',
                 p_table || '_rls_delete', p_table, v_write);
END;
$$;

SELECT helm.apply_child_rls('sop_step', 'sop', 'sop_id', 60);
SELECT helm.apply_child_rls('sop_version', 'sop', 'sop_id', 60);
SELECT helm.apply_child_rls('sop_run_step', 'sop_run', 'run_id', 40);
SELECT helm.apply_child_rls('credential_domain', 'credential', 'credential_id', 40);
SELECT helm.apply_child_rls('flexible_asset_secret', 'flexible_asset_record', 'record_id', 40);
SELECT helm.apply_child_rls('export_download', 'export_job', 'export_job_id', 60);

-- -----------------------------------------------------------------------------
-- secret_version — the most sensitive table in the system.
--
-- There is NO SELECT policy. Not a restrictive one: none at all. With RLS
-- enabled and no permissive SELECT policy, every direct read returns zero rows,
-- for every role, forever.
--
-- Ciphertext is reachable only through helm.reveal_secret() (0210), which is
-- SECURITY DEFINER and writes the audit row in the same transaction as the read.
-- That is what makes "every secret read is audited" a property of the database
-- rather than a promise about application code.
-- -----------------------------------------------------------------------------
ALTER TABLE secret_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_version FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE secret_version IS
  'Ciphertext store. RLS is enabled with no SELECT policy, so direct reads '
  'return nothing regardless of role. Use helm.reveal_secret(), which cannot '
  'return material without writing an audit event in the same transaction.';

-- Writes also go through the API (helm.write_secret_version), so there is no
-- INSERT policy either. UPDATE/DELETE are additionally blocked by trigger.

-- -----------------------------------------------------------------------------
-- tenant_data_key — readable (wrapped blob only) within the tenant, writable
-- only by the rotation job.
-- -----------------------------------------------------------------------------
ALTER TABLE tenant_data_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_data_key FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_data_key_rls_select ON tenant_data_key FOR SELECT
  USING (tenant_id = helm.current_tenant_id());

CREATE POLICY tenant_data_key_rls_write ON tenant_data_key FOR INSERT
  TO helm_key_admin
  WITH CHECK (tenant_id = helm.require_tenant_id());

CREATE POLICY tenant_data_key_rls_update ON tenant_data_key FOR UPDATE
  TO helm_key_admin
  USING (tenant_id = helm.current_tenant_id())
  WITH CHECK (tenant_id = helm.require_tenant_id());

-- -----------------------------------------------------------------------------
-- audit_log — append-only, read-scoped.
--
-- Client-side actors may read audit events for their own organisation (that is
-- the co-managed transparency story) but never tenant-wide events.
-- -----------------------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_log_rls_select ON audit_log FOR SELECT
  USING (
    tenant_id = helm.current_tenant_id()
    AND helm.has_permission('audit:read')
    AND (
      helm.is_tenant_wide()
      OR (organization_id IS NOT NULL AND helm.org_in_scope(organization_id))
    )
  );

-- No INSERT policy: helm.audit() is SECURITY DEFINER and is the only writer.
-- No UPDATE or DELETE policy, and the immutability trigger backs that up.

CREATE OR REPLACE FUNCTION helm.apply_audit_partition_rls() RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'audit_log'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.relname);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = r.relname
        AND policyname = r.relname || '_rls_select'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT USING ('
        'tenant_id = helm.current_tenant_id() AND helm.has_permission(''audit:read'') '
        'AND (helm.is_tenant_wide() OR (organization_id IS NOT NULL '
        'AND helm.org_in_scope(organization_id))))',
        r.relname || '_rls_select', r.relname);
    END IF;
  END LOOP;
END;
$$;

SELECT helm.apply_audit_partition_rls();

ALTER TABLE audit_chain_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_head FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_chain_head_rls_select ON audit_chain_head FOR SELECT
  USING (tenant_id = helm.current_tenant_id() AND helm.has_permission('audit:read'));

-- -----------------------------------------------------------------------------
-- membership / step_up_verification — an actor may read their own rows.
-- -----------------------------------------------------------------------------
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_rls_select ON membership FOR SELECT
  USING (
    tenant_id = helm.current_tenant_id()
    AND (user_id = helm.current_actor_id() OR helm.has_permission('user:read'))
  );
CREATE POLICY membership_rls_write ON membership FOR INSERT
  WITH CHECK (tenant_id = helm.require_tenant_id() AND helm.has_permission('user:write'));
CREATE POLICY membership_rls_update ON membership FOR UPDATE
  USING (tenant_id = helm.current_tenant_id() AND helm.has_permission('user:write'))
  WITH CHECK (tenant_id = helm.require_tenant_id() AND helm.has_permission('user:write'));
CREATE POLICY membership_rls_delete ON membership FOR DELETE
  USING (tenant_id = helm.current_tenant_id() AND helm.has_permission('user:write'));

ALTER TABLE membership_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_permission FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_permission_rls_select ON membership_permission FOR SELECT
  USING (EXISTS (SELECT 1 FROM membership m WHERE m.id = membership_permission.membership_id));
CREATE POLICY membership_permission_rls_write ON membership_permission FOR INSERT
  WITH CHECK (helm.has_permission('user:write')
              AND EXISTS (SELECT 1 FROM membership m
                          WHERE m.id = membership_permission.membership_id
                            AND m.tenant_id = helm.require_tenant_id()));

ALTER TABLE step_up_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_up_verification FORCE ROW LEVEL SECURITY;
CREATE POLICY step_up_rls_select ON step_up_verification FOR SELECT
  USING (tenant_id = helm.current_tenant_id() AND user_id = helm.current_actor_id());
CREATE POLICY step_up_rls_insert ON step_up_verification FOR INSERT
  WITH CHECK (tenant_id = helm.require_tenant_id() AND user_id = helm.current_actor_id());

-- -----------------------------------------------------------------------------
-- tenant — a row is visible only from inside that tenant's own context. The
-- table has no tenant_id column (its id IS the tenant), so the catalog
-- assertion below would not have caught a missing policy here.
-- -----------------------------------------------------------------------------
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls_select ON tenant FOR SELECT
  USING (id = helm.current_tenant_id());
CREATE POLICY tenant_rls_update ON tenant FOR UPDATE
  USING (id = helm.current_tenant_id() AND helm.has_permission('tenant:write'))
  WITH CHECK (id = helm.require_tenant_id() AND helm.has_permission('tenant:write'));

-- -----------------------------------------------------------------------------
-- app_user — global table, tenant-scoped visibility.
--
-- Users are deployment-global (one login, many memberships), so there is no
-- tenant_id to filter on. Without a policy, every tenant could enumerate every
-- other tenant's staff email addresses. Visibility is therefore "shares a
-- membership with my current tenant, or is me".
--
-- helm_auth gets an unconditional policy because the Auth.js adapter must
-- resolve a user *before* any tenant context exists — that is the whole point
-- of a login. It runs on its own connection and has no access to tenant data.
-- -----------------------------------------------------------------------------
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;

CREATE POLICY app_user_rls_auth ON app_user
  TO helm_auth
  USING (true) WITH CHECK (true);

CREATE POLICY app_user_rls_select ON app_user FOR SELECT
  TO helm_app, helm_auditor, helm_migrator
  USING (
    id = helm.current_actor_id()
    OR EXISTS (
      SELECT 1 FROM membership m
      WHERE m.user_id = app_user.id
        AND m.tenant_id = helm.current_tenant_id()
        AND m.status = 'active'
    )
  );

CREATE POLICY app_user_rls_update ON app_user FOR UPDATE
  TO helm_app
  USING (id = helm.current_actor_id() OR helm.has_permission('user:write'))
  WITH CHECK (id = helm.current_actor_id() OR helm.has_permission('user:write'));

-- The RBAC vocabulary (app_role, permission, role_permission) is deliberately
-- left without RLS: it is deployment-global reference data containing no tenant
-- information, and every session needs to read it. It is protected by grants
-- instead — read-only to helm_app, writable only by helm_migrator (0220).

-- -----------------------------------------------------------------------------
-- Catalog assertion: every table carrying tenant_id must have RLS enabled AND
-- at least one policy. This is the backstop against the one failure that
-- matters — a table added later that nobody wired up.
-- -----------------------------------------------------------------------------
DO $assert$
DECLARE
  v_unprotected text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO v_unprotected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND NOT c.relrowsecurity;

  IF v_unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'helm: tables carry tenant_id but have RLS disabled: %', v_unprotected;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO v_unprotected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND NOT c.relforcerowsecurity;

  IF v_unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'helm: tables carry tenant_id without FORCE ROW LEVEL SECURITY: %', v_unprotected;
  END IF;
END
$assert$;
