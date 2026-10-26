-- =============================================================================
-- 1090 — the address people open NinjaOne at, for links
--
-- The API lives at a regional host (0980), but an MSP on a custom domain signs
-- in somewhere else, and a link to the regional host makes them sign in again
-- or lands on the wrong instance. config.portal_url is that address. It is
-- only ever a link a person clicks: nothing is sent to it, so it does not need
-- 0980's allow-list, only to be an https origin.
-- =============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION helm.set_ninja_portal_url(p_url text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_url    text := nullif(rtrim(btrim(coalesce(p_url, '')), '/'), '');
  v_id     uuid;
  v_before text;
BEGIN
  IF NOT helm.has_permission('integration:rmm:manage') THEN
    RAISE EXCEPTION 'helm: configuring NinjaOne requires integration:rmm:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_url IS NOT NULL AND v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' THEN
    RAISE EXCEPTION 'helm: % is not an https address', v_url
      USING ERRCODE = 'check_violation', HINT = 'Like https://yourcompany.rmmservices.net, with no path.';
  END IF;

  SELECT id, config ->> 'portal_url' INTO v_id, v_before FROM integration_connection
  WHERE tenant_id = v_tenant AND provider = 'ninja_one' AND organization_id IS NULL
  ORDER BY created_at LIMIT 1
  FOR UPDATE;
  IF v_id IS NULL THEN RETURN false; END IF;
  IF v_before IS NOT DISTINCT FROM v_url THEN RETURN true; END IF;

  UPDATE integration_connection SET config = CASE
      WHEN v_url IS NULL THEN config - 'portal_url'
      ELSE config || jsonb_build_object('portal_url', v_url) END
  WHERE id = v_id;

  PERFORM helm.audit(
    'integration.rmm_connection_saved', 'integration_connection', v_id, 'success',
    NULL, NULL, NULL,
    jsonb_build_object('provider', 'ninja_one', 'portal_url', v_url, 'from', v_before));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION helm.set_ninja_portal_url(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.set_ninja_portal_url(text) TO helm_app;
