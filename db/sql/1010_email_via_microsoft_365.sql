-- =============================================================================
-- 1010 — sending Helm's mail through Microsoft 365 instead of an SMTP relay
--
-- Until now every message Helm sends went through the relay 0690 configures.
-- An MSP whose own mail is Microsoft 365 had to stand up SMTP AUTH or a
-- connector for it, which Microsoft discourages and many tenants switch off.
-- This adds a second delivery: the Graph sendMail call, made with the app
-- registration the MSP already connected for its OWN organisation under
-- Microsoft 365 (0990), from a mailbox in that tenant.
--
-- ONE SETTING, TWO DELIVERIES. smtp_setting stays the tenant's one email
-- setting: whether mail is on, who it comes from, and which domains it may go
-- to are the same questions whichever way it leaves, and every gate that
-- already reads them — the recipient allow-list, the reminder queues, "can an
-- email destination be added" — keeps working unchanged. `delivery` says
-- which way. Switching to Microsoft 365 leaves the relay's fields where they
-- are, so switching back does not mean typing them again.
--
-- ONLY THE MSP'S OWN CONNECTION. Notifications name clients and their
-- credentials, so they leave from the MSP's mailbox or not at all. A client's
-- connection is refused here, in the function, whatever the form offered.
--
-- THE CLIENT SECRET STAYS WHERE 0990 PUT IT. The worker opens it the way the
-- sync does, through the secret service with purpose 'integration', AS THE
-- SYNC'S OWN IDENTITY (system_sync): that is the service account integration
-- credentials are opened by, and the email jobs' identity (system_alerts) is
-- given no reveal it never needed. Each batch of mail is one audited access.
-- Nothing new is stored.
--
-- WHAT THE APP NEEDS. The Mail.Send APPLICATION permission, admin-consented.
-- On its own that lets the app send as ANY mailbox in the tenant; the remedy
-- is Exchange's (an application access policy, or RBAC for Applications,
-- limiting it to the sending mailbox), and the settings page says so.
-- =============================================================================

SET search_path = public, extensions;

CREATE TYPE email_delivery AS ENUM ('smtp', 'microsoft_graph');

ALTER TABLE smtp_setting
  ADD COLUMN delivery email_delivery NOT NULL DEFAULT 'smtp',
  ADD COLUMN graph_connection_id uuid,
  -- Removing the Microsoft 365 connection leaves email pointing at nothing,
  -- not the connection undeletable: the next send fails and says why.
  ADD CONSTRAINT smtp_graph_connection_fk FOREIGN KEY (graph_connection_id, tenant_id)
    REFERENCES integration_connection (id, tenant_id) ON DELETE SET NULL (graph_connection_id),
  -- A tenant that only ever sent through Microsoft 365 has no relay to name.
  ALTER COLUMN host DROP NOT NULL;

ALTER TABLE smtp_setting DROP CONSTRAINT smtp_host_present;
ALTER TABLE smtp_setting ADD CONSTRAINT smtp_host_present CHECK (
  delivery <> 'smtp' OR length(trim(coalesce(host, ''))) > 0
);

COMMENT ON COLUMN smtp_setting.delivery IS
  'How mail leaves: the relay below (smtp), or Graph sendMail through the MSP''s own '
  'Microsoft 365 connection (microsoft_graph). See 1010.';
COMMENT ON COLUMN smtp_setting.graph_connection_id IS
  'The microsoft_graph integration_connection on the MSP''s internal organisation '
  'that sends, when delivery is microsoft_graph.';

-- Display columns: helm_app reads them like every other non-envelope column.
GRANT SELECT (delivery, graph_connection_id) ON smtp_setting TO helm_app;

-- -----------------------------------------------------------------------------
-- Choosing Microsoft 365.
--
-- Writes the shared fields too, because a tenant may never have configured a
-- relay and this is then the row's first write. The relay's own columns are
-- left exactly as they were.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_graph_email(
  p_enabled       boolean,
  p_connection_id uuid,
  p_from_address  text,
  p_domains       text[]
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
BEGIN
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: tenant:write is required to configure email'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM integration_connection c
    JOIN organization o ON o.id = c.organization_id AND o.tenant_id = c.tenant_id
    WHERE c.id = p_connection_id AND c.tenant_id = v_tenant
      AND c.provider = 'microsoft_graph' AND o.is_msp_internal
  ) THEN
    RAISE EXCEPTION 'helm: email can only be sent through the Microsoft 365 connection on your own organisation'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO smtp_setting AS s (
    tenant_id, enabled, delivery, graph_connection_id, host,
    from_address, allowed_recipient_domains, updated_by
  )
  VALUES (
    v_tenant, p_enabled, 'microsoft_graph', p_connection_id, NULL,
    p_from_address::citext,
    ARRAY(SELECT lower(d) FROM unnest(coalesce(p_domains, '{}')) d), v_actor
  )
  ON CONFLICT (tenant_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    delivery = 'microsoft_graph',
    graph_connection_id = EXCLUDED.graph_connection_id,
    from_address = EXCLUDED.from_address,
    allowed_recipient_domains = EXCLUDED.allowed_recipient_domains,
    -- The last result belonged to whichever way mail went before; a relay's
    -- refusal under a Microsoft 365 setting would be a wrong answer.
    last_send_at = CASE WHEN s.delivery = 'microsoft_graph' AND s.graph_connection_id = EXCLUDED.graph_connection_id
                        THEN s.last_send_at END,
    last_send_ok = CASE WHEN s.delivery = 'microsoft_graph' AND s.graph_connection_id = EXCLUDED.graph_connection_id
                        THEN s.last_send_ok END,
    last_send_error = CASE WHEN s.delivery = 'microsoft_graph' AND s.graph_connection_id = EXCLUDED.graph_connection_id
                           THEN s.last_send_error END,
    consecutive_failures = CASE WHEN s.delivery = 'microsoft_graph' AND s.graph_connection_id = EXCLUDED.graph_connection_id
                                THEN s.consecutive_failures ELSE 0 END,
    updated_at = now(),
    updated_by = v_actor;
END;
$$;

-- -----------------------------------------------------------------------------
-- Choosing the relay again. Called straight after helm.set_smtp_setting(),
-- which writes the relay and leaves `delivery` alone.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.use_smtp_delivery() RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: tenant:write is required to configure email'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE smtp_setting SET
    delivery = 'smtp',
    last_send_at = NULL, last_send_ok = NULL, last_send_error = NULL, consecutive_failures = 0
  WHERE tenant_id = helm.require_tenant_id() AND delivery <> 'smtp';
END;
$$;

-- -----------------------------------------------------------------------------
-- Reading it back, for the settings page.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.email_delivery_setting()
  RETURNS TABLE (delivery email_delivery, graph_connection_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT s.delivery, s.graph_connection_id
  FROM smtp_setting s
  WHERE s.tenant_id = helm.require_tenant_id();
$$;

-- -----------------------------------------------------------------------------
-- What the worker needs to choose a delivery. Enabled rows only, which keeps
-- 0690's rule: a tenant that has switched mail off sends nothing.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.email_delivery(p_tenant_id uuid)
  RETURNS TABLE (delivery email_delivery, graph_connection_id uuid, from_address text, sync_actor_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT s.delivery, s.graph_connection_id, s.from_address::text,
         CASE WHEN s.delivery = 'microsoft_graph' THEN helm.worker_actor(p_tenant_id, 'system_sync') END
  FROM smtp_setting s
  WHERE s.tenant_id = p_tenant_id AND s.enabled;
$$;

REVOKE ALL ON FUNCTION helm.set_graph_email(boolean, uuid, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.set_graph_email(boolean, uuid, text, text[]) TO helm_app;
REVOKE ALL ON FUNCTION helm.use_smtp_delivery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.use_smtp_delivery() TO helm_app;
REVOKE ALL ON FUNCTION helm.email_delivery_setting() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.email_delivery_setting() TO helm_app;
REVOKE ALL ON FUNCTION helm.email_delivery(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.email_delivery(uuid) TO helm_worker;

-- -----------------------------------------------------------------------------
-- Guards.
-- -----------------------------------------------------------------------------
DO $guard$
BEGIN
  IF has_function_privilege('helm_app', 'helm.email_delivery(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '1010: the worker''s delivery lookup is reachable from a request';
  END IF;
  IF has_table_privilege('helm_app', 'smtp_setting', 'UPDATE')
     OR has_table_privilege('helm_app', 'smtp_setting', 'INSERT') THEN
    RAISE EXCEPTION '1010: helm_app can write smtp_setting directly';
  END IF;
END
$guard$;
