-- =============================================================================
-- 0830 — custom roles: a tenant builds its own, permission by permission
--
-- Until now the role catalogue was the seven built-in roles, deployment-global
-- and read-only to the request path, with membership_permission (0480) as the
-- per-person allow/deny layer on top. An MSP whose people do not fit "Tier 2"
-- had to approximate it role by role, person by person. This lets a tenant
-- define a role once — a name, an access level and an exact set of
-- permissions — and assign it like any other.
--
-- WHAT A ROLE IS, AND STAYS. A row in app_role, its permissions in
-- role_permission. set_session_context() already builds a session's
-- permissions from those two tables (plus 0480's overrides), so a custom role
-- needs no change there at all: it is a row like the others, with a tenant.
--
-- FOUR NEW RULES, each closing a hole custom roles would otherwise open.
--
-- 1. A TENANT'S ROLE BELONGS TO THAT TENANT. app_role gains tenant_id (NULL
--    for the built-in roles) and row-level security: the built-in rows are
--    visible to everybody, a custom row only inside its own tenant. Because
--    the SECURITY DEFINER functions that look roles up by key bypass RLS, a
--    trigger on membership and service_account also refuses a role from any
--    other tenant outright — the policy hides it, the trigger forbids it.
--
-- 2. NOBODY HANDS OUT A PERMISSION THEY DO NOT HOLD. 0350 compares RANK when
--    a role is granted, and with the built-in ladder rank was enough: every
--    role that can manage people holds everything the roles below it hold
--    (checked against the shipped catalogue before writing this). A custom
--    role breaks that ladder — rank 60 with tenant:write is one click to
--    define — and a tier3, who holds user:write but not tenant:write, could
--    then assign it to themselves. So granting or editing a membership or a
--    service account now also requires the actor to hold every permission
--    the role carries; creating or editing a role requires holding every
--    permission it is given.
--
-- 3. ONLY tenant:write DEFINES ROLES. Changing what a role means is a change
--    to the authority model, the same judgement 0480 made for per-user
--    overrides. In the shipped catalogue that is super_admin alone.
--
-- 4. THE ACCESS LEVEL IS BOUNDED. Rank still gates RLS writes and each
--    secret's min_role_rank, so a custom role's rank is at most the creator's
--    own, at least 40 for an MSP-staff role (Tier 1's floor), and at most 30
--    for a client-side role (Client Administrator's ceiling) — a customer
--    login must not be able to clear a rank-40 gate. Whether a role is
--    MSP-staff or client-side is fixed at creation: flipping it later would
--    strand tenant-wide memberships or msp_only grants.
--
-- The request path still cannot write app_role or role_permission directly;
-- every change goes through the three functions below, each audited.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The catalogue gains an owner
-- -----------------------------------------------------------------------------
ALTER TABLE app_role
  ADD COLUMN tenant_id  uuid REFERENCES tenant(id) ON DELETE CASCADE,
  ADD COLUMN created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Built-in rows are system rows and belong to no tenant; custom rows are the
-- reverse. Stated as a constraint so neither can drift into the other.
ALTER TABLE app_role
  ADD CONSTRAINT app_role_owner_shape CHECK ((tenant_id IS NULL) = is_system);

CREATE INDEX app_role_tenant_idx ON app_role (tenant_id) WHERE tenant_id IS NOT NULL;

ALTER TABLE app_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_role FORCE ROW LEVEL SECURITY;
CREATE POLICY app_role_rls_select ON app_role FOR SELECT TO helm_app
  USING (tenant_id IS NULL OR tenant_id = helm.current_tenant_id());

-- role_permission has no tenant column of its own; a row is visible exactly
-- when its role is. The subquery is itself subject to app_role's policy.
ALTER TABLE role_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permission FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permission_rls_select ON role_permission FOR SELECT TO helm_app
  USING (EXISTS (SELECT 1 FROM app_role r WHERE r.key = role_permission.role_key));

-- -----------------------------------------------------------------------------
-- Rules 1 and 2, for every writer of membership and service_account
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.enforce_role_assignment() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_role_tenant uuid;
  v_missing     text[];
BEGIN
  -- Read past RLS deliberately: the question is whose role this is, and a
  -- role the policy hides must still be refused by name, not as "no such row".
  SELECT r.tenant_id INTO v_role_tenant FROM app_role r WHERE r.key = NEW.role_key;
  IF v_role_tenant IS NOT NULL AND v_role_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'helm: role % belongs to another tenant', NEW.role_key
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- No actor context is bootstrap, the migrator or a seed: nothing a request
  -- can become (the runtime roles cannot write these tables without one).
  IF nullif(current_setting('helm.actor_id', true), '') IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT array_agg(rp.permission_key ORDER BY rp.permission_key) INTO v_missing
  FROM role_permission rp
  WHERE rp.role_key = NEW.role_key AND NOT helm.has_permission(rp.permission_key);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'helm: role % carries permissions you do not hold: %',
      NEW.role_key, array_to_string(v_missing, ', ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS membership_role_assignment ON membership;
CREATE TRIGGER membership_role_assignment
  BEFORE INSERT OR UPDATE ON membership
  FOR EACH ROW EXECUTE FUNCTION helm.enforce_role_assignment();

DROP TRIGGER IF EXISTS service_account_role_assignment ON service_account;
CREATE TRIGGER service_account_role_assignment
  BEFORE INSERT OR UPDATE ON service_account
  FOR EACH ROW EXECUTE FUNCTION helm.enforce_role_assignment();

-- -----------------------------------------------------------------------------
-- What this actor may assign
--
-- One definition, used by the People screen, the users API and (through the
-- wrapper below) the service-account form. Invoker rights, so app_role's
-- policy already limits it to built-in roles and this tenant's own.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.grantable_roles()
  RETURNS TABLE (
    key            text,
    name           text,
    rank           integer,
    is_tenant_wide boolean,
    is_custom      boolean,
    permissions    text[]
  )
  LANGUAGE sql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT r.key, r.name, r.rank, r.is_tenant_wide, r.tenant_id IS NOT NULL,
         coalesce((SELECT array_agg(rp.permission_key ORDER BY rp.permission_key)
                     FROM role_permission rp WHERE rp.role_key = r.key), '{}')
  FROM app_role r
  WHERE r.key NOT LIKE 'system\_%'
    AND r.rank <= helm.current_role_rank()
    AND (helm.is_tenant_wide() OR NOT r.is_tenant_wide)
    AND NOT EXISTS (
      SELECT 1 FROM role_permission rp
      WHERE rp.role_key = r.key AND NOT helm.has_permission(rp.permission_key)
    )
  ORDER BY r.rank DESC, r.name;
$$;
REVOKE ALL ON FUNCTION helm.grantable_roles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.grantable_roles() TO helm_app;

-- The service-account list was SECURITY DEFINER and read app_role past RLS,
-- so it would have offered every tenant's custom roles. Same shape as before,
-- now the one definition above. (create_service_account looks its role up the
-- same way; the trigger refuses a foreign or over-powered one.)
CREATE OR REPLACE FUNCTION helm.grantable_service_roles()
  RETURNS TABLE (
    key            text,
    name           text,
    rank           integer,
    is_tenant_wide boolean,
    permissions    text[]
  )
  LANGUAGE sql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT g.key, g.name, g.rank, g.is_tenant_wide, g.permissions FROM helm.grantable_roles() g;
$$;

-- -----------------------------------------------------------------------------
-- Defining roles
-- -----------------------------------------------------------------------------

-- Shared checks for create and update. Raises; returns nothing.
CREATE OR REPLACE FUNCTION helm.check_custom_role(
  p_key text, p_name text, p_rank integer, p_is_tenant_wide boolean, p_permissions text[]
) RETURNS void
  LANGUAGE plpgsql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_unknown text[];
  v_missing text[];
  v_msp     text[];
BEGIN
  IF helm.current_actor_type() IS DISTINCT FROM 'user' OR helm.current_actor_id() IS NULL THEN
    RAISE EXCEPTION 'helm: only a signed-in person can define roles'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF nullif(current_setting('helm.api_token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'helm: roles cannot be defined by a request that authenticated with a token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: tenant:write is required to define roles'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' OR length(btrim(p_name)) > 60 THEN
    RAISE EXCEPTION 'helm: a role needs a name of at most 60 characters'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app_role r
    WHERE lower(r.name) = lower(btrim(p_name))
      AND (r.tenant_id IS NULL OR r.tenant_id = v_tenant)
      AND r.key IS DISTINCT FROM p_key
  ) THEN
    RAISE EXCEPTION 'helm: a role called "%" already exists', btrim(p_name)
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Rule 4.
  IF p_rank IS NULL OR p_rank > helm.current_role_rank() THEN
    RAISE EXCEPTION 'helm: a role cannot have a higher access level than your own (%)', helm.current_role_rank()
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_is_tenant_wide AND p_rank < 40 THEN
    RAISE EXCEPTION 'helm: an MSP-staff role has an access level of at least 40 (Tier 1)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT p_is_tenant_wide AND (p_rank < 1 OR p_rank > 30) THEN
    RAISE EXCEPTION 'helm: a client-side role has an access level between 1 and 30 (Client Administrator)'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_unknown
  FROM unnest(coalesce(p_permissions, '{}')) k
  WHERE NOT EXISTS (SELECT 1 FROM permission p WHERE p.key = k);
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'helm: no such permission: %', array_to_string(v_unknown, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rule 2: nothing you do not hold yourself.
  SELECT array_agg(k ORDER BY k) INTO v_missing
  FROM unnest(coalesce(p_permissions, '{}')) k
  WHERE NOT helm.has_permission(k);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'helm: you cannot give a role permissions you do not hold: %', array_to_string(v_missing, ', ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 0020's trigger would refuse these too; saying so here names them all.
  IF NOT p_is_tenant_wide THEN
    SELECT array_agg(p.key ORDER BY p.key) INTO v_msp
    FROM permission p WHERE p.msp_only AND p.key = ANY (coalesce(p_permissions, '{}'));
    IF v_msp IS NOT NULL THEN
      RAISE EXCEPTION 'helm: a client-side role cannot hold MSP-only permissions: %', array_to_string(v_msp, ', ')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION helm.check_custom_role(text, text, integer, boolean, text[]) FROM PUBLIC;

CREATE OR REPLACE FUNCTION helm.create_custom_role(
  p_name text, p_description text, p_rank integer, p_is_tenant_wide boolean, p_permissions text[]
) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_key    text := 'custom_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
  v_perms  text[] := ARRAY(SELECT DISTINCT unnest(coalesce(p_permissions, '{}')) ORDER BY 1);
BEGIN
  PERFORM helm.check_custom_role(NULL, p_name, p_rank, p_is_tenant_wide, v_perms);

  INSERT INTO app_role (key, name, description, rank, is_tenant_wide, is_system, tenant_id, created_by)
  VALUES (v_key, btrim(p_name), coalesce(btrim(p_description), ''), p_rank, p_is_tenant_wide,
          false, v_tenant, helm.current_actor_id());
  INSERT INTO role_permission (role_key, permission_key)
  SELECT v_key, k FROM unnest(v_perms) k;

  PERFORM helm.audit(
    'role.created', 'app_role', NULL, 'success', NULL, NULL, NULL,
    jsonb_build_object('key', v_key, 'name', btrim(p_name), 'rank', p_rank,
                       'mspStaff', p_is_tenant_wide, 'permissions', to_jsonb(v_perms))
  );
  RETURN v_key;
END;
$$;

CREATE OR REPLACE FUNCTION helm.update_custom_role(
  p_key text, p_name text, p_description text, p_rank integer, p_permissions text[]
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_role    app_role%ROWTYPE;
  v_perms   text[] := ARRAY(SELECT DISTINCT unnest(coalesce(p_permissions, '{}')) ORDER BY 1);
  v_old     text[];
BEGIN
  SELECT * INTO v_role FROM app_role WHERE key = p_key FOR UPDATE;
  IF NOT FOUND OR v_role.tenant_id IS DISTINCT FROM v_tenant THEN
    -- Another tenant's role and a built-in role read the same: not yours to edit.
    RAISE EXCEPTION 'helm: % is not a custom role of this tenant', coalesce(p_key, '(none)')
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_role.rank > helm.current_role_rank() THEN
    RAISE EXCEPTION 'helm: % has a higher access level than your own', v_role.name
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM helm.check_custom_role(p_key, p_name, p_rank, v_role.is_tenant_wide, v_perms);

  SELECT coalesce(array_agg(permission_key ORDER BY permission_key), '{}') INTO v_old
  FROM role_permission WHERE role_key = p_key;

  UPDATE app_role
     SET name = btrim(p_name), description = coalesce(btrim(p_description), ''),
         rank = p_rank, updated_at = now()
   WHERE key = p_key;
  DELETE FROM role_permission WHERE role_key = p_key AND NOT (permission_key = ANY (v_perms));
  INSERT INTO role_permission (role_key, permission_key)
  SELECT p_key, k FROM unnest(v_perms) k
  ON CONFLICT DO NOTHING;

  PERFORM helm.audit(
    'role.updated', 'app_role', NULL, 'success', NULL, NULL, NULL,
    jsonb_build_object(
      'key', p_key, 'name', btrim(p_name),
      'rank', jsonb_build_object('from', v_role.rank, 'to', p_rank),
      'added',   to_jsonb(ARRAY(SELECT unnest(v_perms) EXCEPT SELECT unnest(v_old) ORDER BY 1)),
      'removed', to_jsonb(ARRAY(SELECT unnest(v_old) EXCEPT SELECT unnest(v_perms) ORDER BY 1))
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION helm.delete_custom_role(p_key text) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_role    app_role%ROWTYPE;
  v_people  integer;
  v_service integer;
BEGIN
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: tenant:write is required to define roles'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_role FROM app_role WHERE key = p_key FOR UPDATE;
  IF NOT FOUND OR v_role.tenant_id IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'helm: % is not a custom role of this tenant', coalesce(p_key, '(none)')
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_role.rank > helm.current_role_rank() THEN
    RAISE EXCEPTION 'helm: % has a higher access level than your own', v_role.name
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Revoked memberships count: the foreign key would refuse them anyway, and
  -- saying how many is more useful than a constraint name.
  SELECT count(*) INTO v_people  FROM membership      WHERE role_key = p_key;
  SELECT count(*) INTO v_service FROM service_account WHERE role_key = p_key;
  IF v_people + v_service > 0 THEN
    RAISE EXCEPTION 'helm: % is still held by % member(s) and % service account(s); give them another role first',
      v_role.name, v_people, v_service
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  DELETE FROM app_role WHERE key = p_key;   -- role_permission cascades
  PERFORM helm.audit(
    'role.deleted', 'app_role', NULL, 'success', NULL, NULL, NULL,
    jsonb_build_object('key', p_key, 'name', v_role.name)
  );
END;
$$;

REVOKE ALL ON FUNCTION helm.create_custom_role(text, text, integer, boolean, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.update_custom_role(text, text, text, integer, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.delete_custom_role(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.create_custom_role(text, text, integer, boolean, text[]) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.update_custom_role(text, text, text, integer, text[]) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.delete_custom_role(text) TO helm_app;

-- -----------------------------------------------------------------------------
-- Guard: the request path still cannot write the catalogue itself.
-- -----------------------------------------------------------------------------
DO $guard$
BEGIN
  IF has_table_privilege('helm_app', 'app_role', 'INSERT')
     OR has_table_privilege('helm_app', 'app_role', 'UPDATE')
     OR has_table_privilege('helm_app', 'role_permission', 'INSERT')
     OR has_table_privilege('helm_app', 'role_permission', 'DELETE') THEN
    RAISE EXCEPTION '0830: helm_app can write the role catalogue directly';
  END IF;
END
$guard$;

-- -----------------------------------------------------------------------------
-- Signing in as a custom role's holder
--
-- getServerIdentity() turns role keys into names by joining app_role BEFORE a
-- tenant is chosen. With the policy above, that join hides every custom role
-- — the holder would match no membership and be refused at the door. The
-- name comes back from this SECURITY DEFINER lookup instead, which already
-- reads the caller's own memberships past RLS and nothing else. A new return
-- column needs the function dropped and created; its grants are restored as
-- 0270 set them.
-- -----------------------------------------------------------------------------
DROP FUNCTION helm.memberships_for_user(uuid);
CREATE FUNCTION helm.memberships_for_user(p_user_id uuid)
  RETURNS TABLE (
    tenant_id    uuid,
    tenant_slug  citext,
    tenant_name  text,
    role_key     text,
    role_rank    integer,
    org_scope_all boolean,
    require_step_up boolean,
    role_name    text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT ten.id, ten.slug, ten.name, m.role_key, r.rank, m.org_scope_all, m.require_step_up, r.name
  FROM membership m
  JOIN tenant ten ON ten.id = m.tenant_id
  JOIN app_role r ON r.key = m.role_key
  JOIN app_user u ON u.id = m.user_id
  WHERE m.user_id = p_user_id
    AND m.status = 'active'
    AND m.revoked_at IS NULL
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND u.disabled_at IS NULL
    AND ten.status = 'active'
  ORDER BY ten.name;
$$;
REVOKE ALL ON FUNCTION helm.memberships_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.memberships_for_user(uuid) TO helm_app, helm_auth;
