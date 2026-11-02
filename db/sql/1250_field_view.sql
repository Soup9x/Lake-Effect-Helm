-- =============================================================================
-- 1250 — Field view: a read-only phone session, and the policy that shapes it
-- =============================================================================
--
-- Field view (/m) is the phone interface: look up a client's logins and basic
-- details at a client site. Its security rests on ONE column, not on which
-- pages it happens to link to:
--
--   auth_session.field_mode   A session signed in through Field view. The API
--                             layer refuses every write on it except the
--                             audited reveal/copy/code reads, step-up, the
--                             upgrade and sign-out (src/lib/auth/field-session.ts).
--                             Leaving Field view for the full site is the
--                             upgrade, and it takes the password (and the
--                             authenticator code when one is enrolled) again.
--
-- The column lives on auth_session, which only helm_auth can reach (0350), so
-- the browser cannot clear it and helm_app cannot read or write it.
--
-- field_view_policy is the Administration → Mobile access card: whether Field
-- view is offered, how long a phone session may sit idle or live at all, what
-- happens to a critical credential on a phone, and which sections show.
-- Reached only through the functions below, as session_policy is (0890).
-- =============================================================================

SET search_path = public, extensions;

ALTER TABLE auth_session ADD COLUMN field_mode boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN auth_session.field_mode IS
  'Signed in through Field view (1250): read-only until upgraded with the '
  'password again. Held to field_view_policy''s idle and absolute limits as '
  'well as session_policy''s.';

CREATE TABLE field_view_policy (
  tenant_id         uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  -- Offer Field view at all. Off: phones get the full (responsive) site.
  enabled           boolean NOT NULL DEFAULT true,
  -- A phone session ends after this long untouched...
  idle_minutes      integer NOT NULL DEFAULT 10,
  -- ...and after this long whatever happens.
  absolute_hours    integer NOT NULL DEFAULT 12,
  -- A credential marked critical, on a phone: the usual step-up and reason,
  -- or not at all.
  critical_on_phone text    NOT NULL DEFAULT 'step_up',
  -- The tabs a client shows in Field view, in this order.
  sections          text[]  NOT NULL DEFAULT ARRAY['logins', 'devices', 'contacts', 'locations', 'vault'],
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  CONSTRAINT field_view_policy_idle_ck CHECK (idle_minutes BETWEEN 2 AND 240),
  CONSTRAINT field_view_policy_absolute_ck CHECK (absolute_hours BETWEEN 1 AND 72),
  CONSTRAINT field_view_policy_critical_ck CHECK (critical_on_phone IN ('step_up', 'block')),
  CONSTRAINT field_view_policy_sections_ck CHECK (
    sections <@ ARRAY['logins', 'devices', 'contacts', 'locations', 'vault']
  )
);

COMMENT ON TABLE field_view_policy IS
  'Field view (phone) settings a tenant administrator sets (1250). A person in '
  'several tenants is held to the strictest limits of them.';

SELECT helm.apply_tenant_rls('field_view_policy', false, 100, NULL);
REVOKE ALL ON field_view_policy FROM PUBLIC, helm_app, helm_auth;

-- -----------------------------------------------------------------------------
-- For the sign-in role: the limits a person's phone sessions are held to, the
-- strictest across their tenants, and whether every one of them offers Field
-- view. A tenant that never saved a policy counts with the defaults.
-- -----------------------------------------------------------------------------
CREATE FUNCTION helm.field_policy_for_user(p_user_id uuid)
RETURNS TABLE (enabled boolean, idle_minutes integer, absolute_hours integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT
    coalesce(bool_and(coalesce(p.enabled, true)), true),
    coalesce(min(coalesce(p.idle_minutes, 10)), 10),
    coalesce(min(coalesce(p.absolute_hours, 12)), 12)
  FROM membership m
  LEFT JOIN field_view_policy p ON p.tenant_id = m.tenant_id
  WHERE m.user_id = p_user_id
    AND m.status = 'active'
    AND m.revoked_at IS NULL
    AND (m.expires_at IS NULL OR m.expires_at > now());
$$;

-- -----------------------------------------------------------------------------
-- For the application: this tenant's policy, with the defaults when none was
-- saved. Every member may read it — Field view itself needs the sections and
-- the critical rule — and none of it is sensitive.
-- -----------------------------------------------------------------------------
CREATE FUNCTION helm.field_view_policy()
RETURNS TABLE (
  enabled           boolean,
  idle_minutes      integer,
  absolute_hours    integer,
  critical_on_phone text,
  sections          text[],
  updated_at        timestamptz
)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT coalesce(p.enabled, true),
         coalesce(p.idle_minutes, 10),
         coalesce(p.absolute_hours, 12),
         coalesce(p.critical_on_phone, 'step_up'),
         coalesce(p.sections, ARRAY['logins', 'devices', 'contacts', 'locations', 'vault']),
         p.updated_at
  FROM (SELECT helm.require_tenant_id() AS tenant_id) t
  LEFT JOIN field_view_policy p ON p.tenant_id = t.tenant_id;
$$;

CREATE FUNCTION helm.set_field_view_policy(
  p_enabled           boolean,
  p_idle_minutes      integer,
  p_absolute_hours    integer,
  p_critical_on_phone text,
  p_sections          text[]
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
BEGIN
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: changing the Field view policy requires tenant:write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO field_view_policy (
    tenant_id, enabled, idle_minutes, absolute_hours, critical_on_phone, sections, updated_by)
  VALUES (v_tenant, p_enabled, p_idle_minutes, p_absolute_hours, p_critical_on_phone,
          p_sections, v_actor)
  ON CONFLICT (tenant_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    idle_minutes = EXCLUDED.idle_minutes,
    absolute_hours = EXCLUDED.absolute_hours,
    critical_on_phone = EXCLUDED.critical_on_phone,
    sections = EXCLUDED.sections,
    updated_at = now(),
    updated_by = v_actor;

  PERFORM helm.audit(
    'field_view_policy.updated', 'tenant', v_tenant, 'success', NULL, NULL, NULL,
    jsonb_build_object(
      'enabled', p_enabled, 'idleMinutes', p_idle_minutes,
      'absoluteHours', p_absolute_hours, 'criticalOnPhone', p_critical_on_phone,
      'sections', to_jsonb(p_sections)));
END;
$$;

REVOKE ALL ON FUNCTION helm.field_policy_for_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.field_view_policy() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_field_view_policy(boolean, integer, integer, text, text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.field_policy_for_user(uuid) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.field_view_policy() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_field_view_policy(boolean, integer, integer, text, text[]) TO helm_app;

DO $$
BEGIN
  IF has_table_privilege('helm_app', 'field_view_policy', 'SELECT')
     OR has_table_privilege('helm_app', 'field_view_policy', 'UPDATE')
     OR has_table_privilege('helm_auth', 'field_view_policy', 'SELECT') THEN
    RAISE EXCEPTION '1250: an application role can reach field_view_policy directly';
  END IF;
  -- The read-only flag is only as good as helm_app's distance from it.
  IF has_column_privilege('helm_app', 'auth_session', 'field_mode', 'UPDATE')
     OR has_table_privilege('helm_app', 'auth_session', 'SELECT') THEN
    RAISE EXCEPTION '1250: helm_app can reach auth_session';
  END IF;
END
$$;
