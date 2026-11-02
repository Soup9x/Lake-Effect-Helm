-- =============================================================================
-- 1230 — integration widgets, widget widths, and a team default dashboard
--
-- The dashboard has been customisable per person since 0370, but every widget
-- on it predates the integrations. NinjaOne, Action1, Microsoft 365 and Proxmox
-- all write status Helm already stores (integration_connection's last run and
-- failure count, external_identity.profile for devices, expiration rows for
-- domains and warranties) and none of it reached the first page anybody sees.
--
-- THREE CHANGES.
--
-- 1. SIX MORE WIDGET KEYS, and the ceiling goes from 12 to 20 so somebody can
--    have every one of the fourteen on the page at once.
--
--      integration_health   every integration connection and how its last
--                           sync went
--      device_attention     synced devices that are offline, short of disk,
--                           behind on critical patches, waiting on a reboot
--      expiring_domains     domain registrations, next 90 days
--      expiring_warranties  device warranties, next 90 days
--      notifications        your unread in-app notifications
--      my_tasks             the procedure steps assigned to you
--
-- 2. user_dashboard.wide — which widgets span the whole row instead of half of
--    it. Its own column rather than a change to `widgets`' shape, so every
--    layout already stored stays valid and the validator stays one function:
--    `wide` is checked by the same dashboard_layout_valid(), because it is
--    also "an array of known widget keys, no duplicates". NULL means "never
--    chosen", and the interface then uses each widget's own default width.
--
-- 3. tenant_dashboard_default — the layout somebody starts with before they
--    have arranged their own. The same shape and the same rules as 0620's
--    tenant_sidebar_default, for the same reasons: readable by everyone in the
--    tenant (a client-side user's dashboard renders from it too), writable
--    only with tenant:write.
-- =============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION helm.dashboard_layout_valid(p_widgets jsonb)
  RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_widgets) <> 'array' THEN false
    WHEN jsonb_array_length(p_widgets) > 20 THEN false
    ELSE NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(p_widgets) AS w(key)
           WHERE w.key NOT IN (
             'favorites', 'recently_viewed', 'expirations', 'audit_activity',
             'client_health', 'quick_actions', 'usage_summary', 'sync_status',
             'integration_health', 'device_attention', 'expiring_domains',
             'expiring_warranties', 'notifications', 'my_tasks'
           )
         )
         AND (SELECT count(DISTINCT w.key) FROM jsonb_array_elements_text(p_widgets) AS w(key))
             = jsonb_array_length(p_widgets)
  END;
$$;

-- -----------------------------------------------------------------------------
-- Widths.
-- -----------------------------------------------------------------------------
ALTER TABLE user_dashboard ADD COLUMN wide jsonb;

ALTER TABLE user_dashboard ADD CONSTRAINT user_dashboard_wide_valid
  CHECK (wide IS NULL OR helm.dashboard_layout_valid(wide));

COMMENT ON COLUMN user_dashboard.wide IS
  'Widget keys this person set to full width (1230). NULL: never chosen, so '
  'each widget uses its own default width.';

-- -----------------------------------------------------------------------------
-- tenant_dashboard_default.
-- -----------------------------------------------------------------------------
CREATE TABLE tenant_dashboard_default (
  tenant_id  uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  widgets    jsonb NOT NULL,
  wide       jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT tenant_dashboard_default_layout_valid
    CHECK (helm.dashboard_layout_valid(widgets)),
  CONSTRAINT tenant_dashboard_default_wide_valid
    CHECK (wide IS NULL OR helm.dashboard_layout_valid(wide))
);

CREATE TRIGGER tenant_dashboard_default_touch BEFORE UPDATE ON tenant_dashboard_default
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

COMMENT ON TABLE tenant_dashboard_default IS
  'Optional per-tenant default dashboard for users who have not arranged their '
  'own (1230). Readable by anyone in the tenant because the dashboard renders '
  'from it; writable only with tenant:write.';

ALTER TABLE tenant_dashboard_default ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_dashboard_default FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_dashboard_default_rls_select ON tenant_dashboard_default
  FOR SELECT USING (tenant_id = helm.current_tenant_id());

CREATE POLICY tenant_dashboard_default_rls_insert ON tenant_dashboard_default
  FOR INSERT WITH CHECK (
    tenant_id = helm.require_tenant_id() AND helm.has_permission('tenant:write'));

CREATE POLICY tenant_dashboard_default_rls_update ON tenant_dashboard_default
  FOR UPDATE
  USING (tenant_id = helm.current_tenant_id() AND helm.has_permission('tenant:write'))
  WITH CHECK (
    tenant_id = helm.require_tenant_id() AND helm.has_permission('tenant:write'));

CREATE POLICY tenant_dashboard_default_rls_delete ON tenant_dashboard_default
  FOR DELETE
  USING (tenant_id = helm.current_tenant_id() AND helm.has_permission('tenant:write'));

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_dashboard_default TO helm_app;

-- =============================================================================
-- Guards, as 0530's.
-- =============================================================================
DO $widget_guard$
DECLARE
  v_key text;
BEGIN
  FOREACH v_key IN ARRAY ARRAY[
    'favorites', 'recently_viewed', 'expirations', 'audit_activity',
    'client_health', 'quick_actions', 'usage_summary', 'sync_status',
    'integration_health', 'device_attention', 'expiring_domains',
    'expiring_warranties', 'notifications', 'my_tasks'
  ] LOOP
    IF NOT helm.dashboard_layout_valid(to_jsonb(ARRAY[v_key])) THEN
      RAISE EXCEPTION 'helm: dashboard_layout_valid() refuses the widget key %', v_key;
    END IF;
  END LOOP;

  IF helm.dashboard_layout_valid('["not_a_widget"]'::jsonb) THEN
    RAISE EXCEPTION 'helm: dashboard_layout_valid() now accepts unknown keys';
  END IF;
  IF helm.dashboard_layout_valid('"favorites"'::jsonb) THEN
    RAISE EXCEPTION 'helm: dashboard_layout_valid() no longer requires an array';
  END IF;
  IF helm.dashboard_layout_valid('["favorites", "favorites"]'::jsonb) THEN
    RAISE EXCEPTION 'helm: dashboard_layout_valid() no longer rejects duplicates';
  END IF;
  IF helm.dashboard_layout_valid(
       (SELECT jsonb_agg('k' || g) FROM generate_series(1, 21) g)) THEN
    RAISE EXCEPTION 'helm: dashboard_layout_valid() no longer caps the layout length';
  END IF;
END;
$widget_guard$;
