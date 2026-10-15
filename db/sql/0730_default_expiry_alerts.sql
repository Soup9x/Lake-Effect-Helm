-- 0730_default_expiry_alerts.sql — expiry alerts that actually fire
--
-- Everything downstream of an alert rule already worked: helm.evaluate_alert_rules()
-- fires one alert per expiry per lead threshold, idempotently; the alert worker
-- queues each one as `expiration.warning` on the shared notification queue; and
-- a destination can subscribe to "Expiring soon" on the Settings page, whose own
-- description promises warnings "at your configured lead times".
--
-- What was missing was the rule. Nothing outside the test suite ever wrote an
-- alert_rule row — no route, no form, no seed — so helm.alert_backlog() listed
-- no tenant, both alert jobs reported idle on every tick, and a destination
-- subscribed to expiry warnings never received one.
--
-- So every tenant gets exactly one DEFAULT rule: every kind of expiry, every
-- organisation, at 30, 14, 7 and 1 days. It is created for existing tenants
-- here and for new ones by a trigger, the same way 0290 provisions the worker
-- identities. The Settings page edits its lead days and switches it off; the
-- table still allows further rules for a deployment that wants them.
--
-- `channel` and `target` predate the notification queue (0420) and are no
-- longer read: delivery goes to whichever destinations subscribe to
-- `expiration.warning`. The default rule records 'webhook' / 'notification-queue'
-- because both columns are NOT NULL and the channel is CHECKed, and says what
-- actually happens rather than naming an address that is not used.

ALTER TABLE alert_rule
  ADD COLUMN is_default boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN alert_rule.is_default IS
  'The tenant''s built-in rule, edited from Settings. At most one per tenant (0730).';

CREATE UNIQUE INDEX alert_rule_one_default
  ON alert_rule (tenant_id) WHERE is_default;

CREATE OR REPLACE FUNCTION helm.ensure_default_alert_rule(p_tenant_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO alert_rule (
    tenant_id, organization_id, name, kinds, lead_days, min_criticality,
    channel, target, is_active, is_default
  )
  VALUES (
    p_tenant_id, NULL, 'Expiry warnings', '{}', '{30,14,7,1}', 1,
    'webhook', 'notification-queue', true, true
  )
  ON CONFLICT (tenant_id) WHERE is_default DO NOTHING;
  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION helm.ensure_default_alert_rule(uuid) IS
  'Give a tenant its default expiry alert rule if it has none. Idempotent (0730).';

REVOKE ALL ON FUNCTION helm.ensure_default_alert_rule(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION helm.provision_default_alert_rule() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM helm.ensure_default_alert_rule(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_default_alert_rule
  AFTER INSERT ON tenant
  FOR EACH ROW EXECUTE FUNCTION helm.provision_default_alert_rule();

-- Existing tenants.
SELECT helm.ensure_default_alert_rule(id) FROM tenant;

-- ---------------------------------------------------------------------------
-- Guard
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenant t
    WHERE NOT EXISTS (SELECT 1 FROM alert_rule r WHERE r.tenant_id = t.id AND r.is_default)
  ) THEN
    RAISE EXCEPTION '0730: a tenant was left without a default expiry alert rule';
  END IF;

  IF has_function_privilege('helm_app', 'helm.ensure_default_alert_rule(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0730: helm_app must not be able to provision rules for other tenants';
  END IF;
END
$guard$;
