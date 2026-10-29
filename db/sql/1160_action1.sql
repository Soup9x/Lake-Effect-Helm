-- =============================================================================
-- 1160 — Action1 endpoint sync
--
-- Action1 is patch management and RMM. Like NinjaOne (0980) one Action1
-- account covers every client an MSP manages, each client being an Action1
-- "organization", so this is ONE tenant-wide integration_connection (provider
-- 'action1', organization_id NULL). It authenticates with an API credential
-- made on Action1's API Credentials page: a client id in config, the
-- client secret in `secret`, referenced from credential_secret_ids.client_secret.
--
-- WHICH CLIENT AN ENDPOINT BELONGS TO is decided by a person, once per Action1
-- organization, in action1_organization — NinjaOne's rule, for NinjaOne's
-- reason: guessing by name puts one client's machines in another's
-- documentation. "Don't import" is recorded as a decision (excluded_at) from
-- the start, as 1070 made it for NinjaOne.
--
-- WHAT A SYNC MAY CHANGE. Only what Action1 observes about a machine: its
-- hostname, operating system, manufacturer, serial, processor, memory,
-- address, MAC and when it last checked in. Never the name, notes, status,
-- site, contact or type a person gave it, and of the observed fields only one
-- still holding what this sync last wrote (external_identity.applied).
--
-- NOT device.rmm_device_id. That column is NinjaOne's id for the machine, and
-- a client on both would have the two syncs overwriting each other's. The
-- Action1 id lives in external_identity.external_id, which is where links are
-- built from.
--
-- A MACHINE ALREADY DOCUMENTED — by hand, by NinjaOne, by Proxmox — is adopted
-- rather than doubled: a configuration of the same client with the same serial
-- number, or with the same hostname where one side has no serial, that this
-- connection has not already claimed. Its fields keep what they hold, because
-- this sync did not write them; anything empty is filled in.
--
-- PROFILE. What Action1 reports beyond the device's columns — online status,
-- last user, last boot, reboot needed, missing updates, vulnerabilities, agent
-- version, disk, AD OU, public address — goes in external_identity.profile
-- (1080) and shows read-only as a "From Action1" card.
--
-- WHERE THE SECRET MAY GO. The worker posts the client secret to base_url, so
-- a trigger holds an Action1 connection to Action1's own regional hosts and to
-- API-key secrets kept in the MSP's internal organisation, as 0980 does.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Permission: the RMM one. Action1 is the same kind of integration as NinjaOne
-- and the same people configure it.
-- -----------------------------------------------------------------------------
UPDATE permission
SET description = 'Configure the RMM integrations (NinjaOne, Action1), their credentials and which clients they import'
WHERE key = 'integration:rmm:manage';

-- -----------------------------------------------------------------------------
-- action1_organization — Action1's organizations, and the client each imports to.
-- -----------------------------------------------------------------------------
CREATE TABLE action1_organization (
  tenant_id        uuid NOT NULL,
  connection_id    uuid NOT NULL,
  action1_org_id   text NOT NULL,
  name             text NOT NULL,
  -- NULL: listed, not imported.
  organization_id  uuid,
  -- Somebody chose "Don't import", or deleted the client it imported to.
  -- NULL with a NULL organization_id: nobody has decided yet.
  excluded_at      timestamptz,
  device_count     integer,
  seen_at          timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (connection_id, action1_org_id),
  CONSTRAINT action1_organization_connection_fk FOREIGN KEY (connection_id, tenant_id)
    REFERENCES integration_connection (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT action1_organization_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE SET NULL (organization_id),
  CONSTRAINT action1_organization_count_ck CHECK (device_count IS NULL OR device_count >= 0)
);

SELECT helm.apply_tenant_rls('action1_organization', false, 80, NULL);

CREATE TRIGGER action1_organization_touch BEFORE UPDATE ON action1_organization
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- 1070's rule: mapping clears the exclusion, and losing a mapping (the client
-- deleted, or "Don't import") sets it.
CREATE OR REPLACE FUNCTION helm.action1_organization_track_exclusion() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.organization_id IS NOT NULL THEN
    NEW.excluded_at := NULL;
  ELSIF OLD.organization_id IS NOT NULL THEN
    NEW.excluded_at := coalesce(NEW.excluded_at, now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER action1_organization_track_exclusion BEFORE UPDATE OF organization_id ON action1_organization
  FOR EACH ROW EXECUTE FUNCTION helm.action1_organization_track_exclusion();

-- -----------------------------------------------------------------------------
-- The hosts an Action1 connection may talk to: Action1's data centres, from
-- the servers list of its published API specification.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.action1_base_url_allowed(p_url text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT p_url IN (
    'https://app.action1.com', 'https://app.na-2.action1.com', 'https://app.eu.action1.com',
    'https://app.uk.action1.com', 'https://app.au.action1.com');
$$;

CREATE OR REPLACE FUNCTION helm.guard_action1_connection() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_secret text;
BEGIN
  IF NEW.provider <> 'action1' THEN
    RETURN NEW;
  END IF;

  -- A run recording its outcome changes none of these.
  IF TG_OP = 'UPDATE'
     AND NEW.provider = OLD.provider
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.base_url IS NOT DISTINCT FROM OLD.base_url
     AND NEW.credential_secret_ids = OLD.credential_secret_ids THEN
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NOT NULL THEN
    RAISE EXCEPTION 'helm: an Action1 connection covers every client and has no organisation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.base_url IS NULL OR NOT helm.action1_base_url_allowed(NEW.base_url) THEN
    RAISE EXCEPTION 'helm: % is not an Action1 region', coalesce(NEW.base_url, 'no address')
      USING ERRCODE = 'check_violation',
            HINT = 'One of app, app.na-2, app.eu, app.uk or app.au .action1.com.';
  END IF;

  FOR v_secret IN SELECT value FROM jsonb_each_text(NEW.credential_secret_ids) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM secret s
      JOIN organization o ON o.id = s.organization_id AND o.tenant_id = s.tenant_id
      WHERE s.id::text = v_secret AND s.tenant_id = NEW.tenant_id
        AND s.kind = 'api_key' AND o.is_msp_internal AND s.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'helm: an Action1 connection may only use an API key kept in the MSP''s own organisation'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION helm.guard_action1_connection() FROM PUBLIC;

CREATE TRIGGER integration_connection_action1_guard
  BEFORE INSERT OR UPDATE ON integration_connection
  FOR EACH ROW EXECUTE FUNCTION helm.guard_action1_connection();

-- -----------------------------------------------------------------------------
-- helm.set_action1_connection — create or change the one connection. As
-- helm.set_ninja_connection: an absent secret keeps the stored one, and a
-- changed region, client id or secret makes the connection due now.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_action1_connection(
  p_base_url         text,
  p_client_id        text,
  p_secret_id        uuid,
  p_sync_enabled     boolean,
  p_interval_minutes integer
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant   uuid := helm.require_tenant_id();
  v_actor    uuid := helm.current_actor_id();
  v_existing integration_connection%ROWTYPE;
  v_secrets  jsonb;
  v_changed  boolean;
BEGIN
  IF NOT helm.has_permission('integration:rmm:manage') THEN
    RAISE EXCEPTION 'helm: configuring Action1 requires integration:rmm:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_existing FROM integration_connection
  WHERE tenant_id = v_tenant AND provider = 'action1' AND organization_id IS NULL
  ORDER BY created_at LIMIT 1;

  v_secrets := CASE
    WHEN p_secret_id IS NOT NULL THEN jsonb_build_object('client_secret', p_secret_id::text)
    ELSE coalesce(v_existing.credential_secret_ids, '{}'::jsonb) END;

  IF p_sync_enabled AND NOT (v_secrets ? 'client_secret') THEN
    RAISE EXCEPTION 'helm: Action1 cannot sync without a client secret'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_existing.id IS NULL THEN
    INSERT INTO integration_connection (
      tenant_id, organization_id, provider, display_name, status, direction, base_url, config,
      credential_secret_ids, sync_enabled, sync_interval_minutes, created_by)
    VALUES (
      v_tenant, NULL, 'action1', 'Action1',
      CASE WHEN p_sync_enabled THEN 'configured' ELSE 'disabled' END::integration_status,
      'inbound', btrim(p_base_url),
      jsonb_build_object('client_id', btrim(p_client_id)),
      v_secrets, p_sync_enabled, p_interval_minutes,
      (SELECT id FROM app_user WHERE id = v_actor))
    RETURNING * INTO v_existing;
  ELSE
    v_changed := v_existing.base_url IS DISTINCT FROM btrim(p_base_url)
      OR v_existing.config ->> 'client_id' IS DISTINCT FROM btrim(p_client_id)
      OR p_secret_id IS NOT NULL;

    UPDATE integration_connection SET
      base_url = btrim(p_base_url),
      config = config || jsonb_build_object('client_id', btrim(p_client_id)),
      credential_secret_ids = v_secrets,
      sync_enabled = p_sync_enabled,
      sync_interval_minutes = p_interval_minutes,
      status = CASE WHEN NOT p_sync_enabled THEN 'disabled'::integration_status
                    WHEN v_changed OR status = 'disabled' THEN 'configured'::integration_status
                    ELSE status END,
      consecutive_failures = CASE WHEN v_changed THEN 0 ELSE consecutive_failures END,
      last_error = CASE WHEN v_changed THEN NULL ELSE last_error END,
      last_sync_at = CASE WHEN v_changed THEN NULL ELSE last_sync_at END
    WHERE id = v_existing.id;
  END IF;

  PERFORM helm.audit(
    'integration.rmm_connection_saved', 'integration_connection', v_existing.id, 'success',
    NULL, NULL, NULL,
    jsonb_build_object(
      'provider', 'action1',
      'base_url', btrim(p_base_url),
      'client_id', btrim(p_client_id),
      'secret_changed', p_secret_id IS NOT NULL,
      'sync_enabled', p_sync_enabled,
      'interval_minutes', p_interval_minutes));

  RETURN v_existing.id;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.record_action1_organizations — the list Action1 returned. Names and
-- counts only; which client each imports to is never touched here.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_action1_organizations(p_connection_id uuid, p_orgs jsonb)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_count  integer;
BEGIN
  IF jsonb_typeof(p_orgs) <> 'array' THEN
    RAISE EXCEPTION 'helm: organisations must be an array' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO action1_organization (tenant_id, connection_id, action1_org_id, name, device_count, seen_at)
  SELECT v_tenant, p_connection_id, o ->> 'id',
         left(coalesce(nullif(btrim(o ->> 'name'), ''), 'Organization ' || (o ->> 'id')), 200),
         (o ->> 'deviceCount')::integer, now()
  FROM jsonb_array_elements(p_orgs) AS o
  WHERE nullif(o ->> 'id', '') IS NOT NULL
  ON CONFLICT (connection_id, action1_org_id) DO UPDATE SET
    name = EXCLUDED.name,
    device_count = coalesce(EXCLUDED.device_count, action1_organization.device_count),
    seen_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.map_action1_organization — which client an Action1 organization
-- imports to. NULL is "Don't import", recorded as a decision.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.map_action1_organization(
  p_connection_id   uuid,
  p_action1_org_id  text,
  p_organization_id uuid
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant   uuid := helm.require_tenant_id();
  v_before   uuid;
  v_excluded timestamptz;
  v_name     text;
BEGIN
  IF NOT helm.has_permission('integration:rmm:manage') THEN
    RAISE EXCEPTION 'helm: choosing what Action1 imports requires integration:rmm:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_organization_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM organization
    WHERE id = p_organization_id AND tenant_id = v_tenant AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'helm: no such client' USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT organization_id, excluded_at, name INTO v_before, v_excluded, v_name FROM action1_organization
  WHERE tenant_id = v_tenant AND connection_id = p_connection_id AND action1_org_id = p_action1_org_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_before IS NOT DISTINCT FROM p_organization_id
     AND (p_organization_id IS NOT NULL OR v_excluded IS NOT NULL) THEN
    RETURN true;
  END IF;

  UPDATE action1_organization SET
    organization_id = p_organization_id,
    excluded_at = CASE WHEN p_organization_id IS NULL THEN coalesce(excluded_at, now()) END
  WHERE tenant_id = v_tenant AND connection_id = p_connection_id AND action1_org_id = p_action1_org_id;

  PERFORM helm.audit(
    'integration.rmm_organization_mapped', 'integration_connection', p_connection_id, 'success',
    p_organization_id, NULL, NULL,
    jsonb_build_object('provider', 'action1', 'action1_org_id', p_action1_org_id,
                       'action1_org_name', v_name, 'from', v_before, 'to', p_organization_id));
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.request_action1_sync — "Sync now": makes the connection due.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.request_action1_sync() RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_id     uuid;
BEGIN
  IF NOT helm.has_permission('integration:rmm:manage') THEN
    RAISE EXCEPTION 'helm: running an Action1 sync requires integration:rmm:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE integration_connection SET last_sync_at = NULL
  WHERE tenant_id = v_tenant AND provider = 'action1' AND sync_enabled AND disabled_at IS NULL
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RETURN false; END IF;

  PERFORM helm.audit('integration.rmm_sync_requested', 'integration_connection', v_id, 'success');
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.upsert_action1_device — one endpoint, as the sync worker, under RLS.
--
-- p_values holds only the fields Action1 reported, by device column name; a
-- field it did not report is absent and nothing is cleared. p_profile replaces
-- the read-only profile. Matching, in order: the identity this connection
-- already holds; else a configuration of the same client this connection has
-- not claimed, with the same serial number, or the same hostname where either
-- side has no serial; else a new configuration.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.upsert_action1_device(
  p_connection_id   uuid,
  p_organization_id uuid,
  p_external_id     text,
  p_payload_sha256  bytea,
  p_name            text,
  p_device_type     device_type,
  p_values          jsonb,
  p_profile         jsonb
) RETURNS TABLE (node_id uuid, outcome text)
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant   uuid := helm.require_tenant_id();
  v_respect  boolean;
  v_identity external_identity%ROWTYPE;
  v_node     uuid;
  v_created  boolean := false;
  v_current  jsonb;
  v_writes   jsonb := '{}'::jsonb;
  v_applied  jsonb;
  v_key      text;
  v_new      jsonb;
  v_now_val  jsonb;
  v_serial   text := nullif(btrim(p_values ->> 'serial_number'), '');
  v_host     text := nullif(btrim(p_values ->> 'hostname'), '');
  v_allowed  text[] := ARRAY['hostname', 'operating_system', 'os_version', 'manufacturer',
                             'serial_number', 'cpu', 'memory_gb', 'primary_ip', 'primary_mac'];
BEGIN
  SELECT respect_manual_edits INTO v_respect FROM integration_connection
  WHERE id = p_connection_id AND tenant_id = v_tenant AND provider = 'action1';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: no such Action1 connection' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT ei.* INTO v_identity FROM external_identity ei
  WHERE ei.connection_id = p_connection_id AND ei.external_type = 'action1_device'
    AND ei.external_id = p_external_id;

  IF v_identity.id IS NULL THEN
    SELECT n.id INTO v_node FROM asset_node n
    JOIN device d ON d.id = n.id
    WHERE n.tenant_id = v_tenant AND n.organization_id = p_organization_id
      AND ((v_serial IS NOT NULL AND lower(d.serial_number) = lower(v_serial))
           OR (v_host IS NOT NULL AND lower(d.hostname::text) = lower(v_host)
               AND (v_serial IS NULL OR nullif(btrim(d.serial_number), '') IS NULL)))
      AND NOT EXISTS (
        SELECT 1 FROM external_identity x
        WHERE x.connection_id = p_connection_id AND x.node_id = n.id AND x.external_type = 'action1_device')
    ORDER BY (v_serial IS NOT NULL AND lower(d.serial_number) = lower(v_serial)) DESC, n.created_at
    LIMIT 1;

    IF v_node IS NULL THEN
      INSERT INTO asset_node (tenant_id, organization_id, node_type, name, status)
      VALUES (v_tenant, p_organization_id, 'device', left(btrim(p_name), 200), 'active')
      RETURNING id INTO v_node;
      INSERT INTO device (id, tenant_id, node_type, device_type)
      VALUES (v_node, v_tenant, 'device', p_device_type);
      v_created := true;
    END IF;

    INSERT INTO external_identity (tenant_id, connection_id, node_id, external_id, external_type)
    VALUES (v_tenant, p_connection_id, v_node, p_external_id, 'action1_device')
    RETURNING * INTO v_identity;
  END IF;

  v_node := v_identity.node_id;

  -- The check-in time is Action1's view, not the machine's, so it is always
  -- this sync's to move — but only forward: on a machine NinjaOne also
  -- reports, whichever agent checked in last wins, not whichever synced last.
  IF p_values ? 'last_seen_at' THEN
    UPDATE device d SET last_seen_at = (p_values ->> 'last_seen_at')::timestamptz
    WHERE d.id = v_node
      AND (d.last_seen_at IS NULL OR d.last_seen_at < (p_values ->> 'last_seen_at')::timestamptz);
  END IF;

  -- Nothing Action1 reports about the machine has changed since last time.
  IF NOT v_created AND v_identity.payload_sha256 IS NOT DISTINCT FROM p_payload_sha256 THEN
    UPDATE external_identity SET last_synced_at = now(), profile = p_profile WHERE id = v_identity.id;
    RETURN QUERY SELECT v_node, 'unchanged'::text;
    RETURN;
  END IF;

  SELECT to_jsonb(d) INTO v_current FROM device d WHERE d.id = v_node;
  v_applied := v_identity.applied;

  FOR v_key IN SELECT jsonb_object_keys(p_values) LOOP
    CONTINUE WHEN NOT (v_key = ANY (v_allowed));
    v_new := p_values -> v_key;
    CONTINUE WHEN v_new IS NULL OR jsonb_typeof(v_new) = 'null';
    v_now_val := v_current -> v_key;
    CONTINUE WHEN v_now_val = v_new;

    IF NOT v_respect
       OR v_now_val IS NULL OR jsonb_typeof(v_now_val) = 'null'
       OR v_now_val = v_applied -> v_key THEN
      v_writes := v_writes || jsonb_build_object(v_key, v_new);
    END IF;
  END LOOP;

  IF v_writes <> '{}'::jsonb THEN
    -- Every column named. Nothing a person owns is in this list, and a guard at
    -- the end of this migration fails if one is added.
    UPDATE device d SET
      hostname         = CASE WHEN v_writes ? 'hostname' THEN (v_writes ->> 'hostname')::citext ELSE d.hostname END,
      operating_system = CASE WHEN v_writes ? 'operating_system' THEN v_writes ->> 'operating_system' ELSE d.operating_system END,
      os_version       = CASE WHEN v_writes ? 'os_version' THEN v_writes ->> 'os_version' ELSE d.os_version END,
      manufacturer     = CASE WHEN v_writes ? 'manufacturer' THEN v_writes ->> 'manufacturer' ELSE d.manufacturer END,
      serial_number    = CASE WHEN v_writes ? 'serial_number' THEN v_writes ->> 'serial_number' ELSE d.serial_number END,
      cpu              = CASE WHEN v_writes ? 'cpu' THEN v_writes ->> 'cpu' ELSE d.cpu END,
      memory_gb        = CASE WHEN v_writes ? 'memory_gb' THEN (v_writes ->> 'memory_gb')::numeric ELSE d.memory_gb END,
      primary_ip       = CASE WHEN v_writes ? 'primary_ip' THEN (v_writes ->> 'primary_ip')::inet ELSE d.primary_ip END,
      primary_mac      = CASE WHEN v_writes ? 'primary_mac' THEN (v_writes ->> 'primary_mac')::macaddr ELSE d.primary_mac END
    WHERE d.id = v_node;

    -- Stored as the column reads it back, so the next comparison is like for like.
    SELECT v_applied || (SELECT jsonb_object_agg(k, to_jsonb(d) -> k)
                         FROM jsonb_object_keys(v_writes) AS k)
    INTO v_applied FROM device d WHERE d.id = v_node;
  END IF;

  UPDATE external_identity SET
    payload_sha256 = p_payload_sha256,
    applied = v_applied,
    profile = p_profile,
    last_synced_at = now()
  WHERE id = v_identity.id;

  RETURN QUERY SELECT v_node,
    CASE WHEN v_created THEN 'created'
         WHEN v_writes <> '{}'::jsonb THEN 'updated'
         ELSE 'unchanged' END;
END;
$$;

-- -----------------------------------------------------------------------------
-- Grants. The SECURITY DEFINER ones check integration:rmm:manage themselves.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION helm.set_action1_connection(text, text, uuid, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_action1_organizations(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.map_action1_organization(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.request_action1_sync() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.upsert_action1_device(uuid, uuid, text, bytea, text, device_type, jsonb, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.set_action1_connection(text, text, uuid, boolean, integer) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.record_action1_organizations(uuid, jsonb) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.map_action1_organization(uuid, text, uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.request_action1_sync() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.upsert_action1_device(uuid, uuid, text, bytea, text, device_type, jsonb, jsonb) TO helm_app;

-- -----------------------------------------------------------------------------
-- Guard: the device upsert names no column a person owns, nor NinjaOne's id.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  v_src  text;
  v_col  text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE oid = 'helm.upsert_action1_device(uuid, uuid, text, bytea, text, device_type, jsonb, jsonb)'::regprocedure;

  FOREACH v_col IN ARRAY ARRAY[
    'device_type', 'asset_tag', 'contact_id', 'notes', 'backup_policy', 'management_url',
    'warranty_expires_at', 'purchased_at', 'end_of_life_at', 'os_notes', 'rmm_device_id', 'model'
  ] LOOP
    IF v_src ~ ('\m' || v_col || '\s*=') THEN
      RAISE EXCEPTION '1160: helm.upsert_action1_device assigns %, which it must not', v_col;
    END IF;
  END LOOP;
END
$guard$;
