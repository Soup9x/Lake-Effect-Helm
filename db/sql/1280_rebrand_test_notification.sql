-- =============================================================================
-- 1280 — Test notifications say "Helm"
-- =============================================================================
--
-- The product is now called Helm. Migrations are immutable, so the test
-- notification text from 0420 is changed by redefining the function here. The
-- body is 0420's with only the subject text changed.
-- =============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION helm.send_test_notification(p_id uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  text := coalesce(nullif(current_setting('helm.actor_label', true), ''), 'Helm');
  v_uid    uuid := gen_random_uuid();
  v_rows   integer;
BEGIN
  IF NOT helm.has_permission('integration:manage') THEN
    RAISE EXCEPTION 'helm: sending a test notification requires integration:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO webhook_delivery (
    tenant_id, endpoint_id, event_type, event_uid, subject, payload)
  SELECT v_tenant, e.id, 'export.requested', v_uid,
         format('Test from Helm, sent by %s. If you can read this, ' ||
                'notifications reach this channel.', v_actor),
         jsonb_build_object('kind', 'test', 'format', 'none', 'include_secrets', false)
  FROM webhook_endpoint e
  WHERE e.id = p_id AND e.tenant_id = v_tenant;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'helm: no such notification destination' USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_uid;
END;
$$;
