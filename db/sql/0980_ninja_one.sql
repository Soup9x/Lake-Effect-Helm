-- =============================================================================
-- 0980 — NinjaOne device sync
--
-- One NinjaOne instance covers every client an MSP manages, so this is ONE
-- tenant-wide integration_connection (provider 'ninja_one', organization_id
-- NULL), reached with an OAuth client-credentials app: a client id in config,
-- the client secret in `secret` like every other credential, referenced from
-- credential_secret_ids.client_secret.
--
-- WHICH CLIENT A DEVICE BELONGS TO is decided by a person, once per NinjaOne
-- organisation, in ninja_organization. An organisation nobody has mapped is
-- listed and not imported — guessing by name would put one client's servers in
-- another's documentation, and that is not a mistake anybody notices quickly.
--
-- WHAT A SYNC MAY CHANGE. Only what NinjaOne observes about a machine: its
-- hostname, DNS name, operating system, make, model, serial, processor, memory,
-- address, MAC, when it last checked in and its NinjaOne id. Never the name,
-- notes, status, location, contact or type a person gave it — the function
-- below does not name those columns in its UPDATE at all.
--
-- AND NOT EVEN THOSE, once a person has edited one. external_identity.applied
-- remembers what the sync last wrote to each field. A field still holding that
-- value (or empty) is the sync's to update; a field holding anything else was
-- changed by somebody, and stays as they left it. That is what
-- integration_connection.respect_manual_edits has always promised; turning it
-- off makes NinjaOne authoritative for these fields.
--
-- WHERE THE SECRET MAY GO. The worker reveals the client secret and posts it to
-- base_url. A row pointing base_url somewhere else, or credential_secret_ids at
-- some other secret, would be a way to post a credential to a host of one's
-- choosing — so a trigger holds a NinjaOne connection to NinjaOne's own regional
-- hosts and to API-key secrets kept in the MSP's internal organisation, whoever
-- writes the row and however.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Permission: its own scope, like integration:network:manage and for the same
-- reason — configuring the RMM is not the same act as configuring sign-in.
-- -----------------------------------------------------------------------------
INSERT INTO permission (key, category, description, msp_only) VALUES
  ('integration:rmm:manage', 'integration',
   'Configure the RMM integration (NinjaOne), its credentials and which clients it imports', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permission (role_key, permission_key)
SELECT r.key, 'integration:rmm:manage'
FROM app_role r WHERE r.key IN ('super_admin', 'tier3')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- What the sync last wrote, per field. See the header.
-- -----------------------------------------------------------------------------
ALTER TABLE external_identity
  ADD COLUMN applied jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT external_identity_applied_object CHECK (jsonb_typeof(applied) = 'object');

COMMENT ON COLUMN external_identity.applied IS
  'Field -> the value the sync last wrote (0980). A field whose current value '
  'differs was edited by a person and is left alone while respect_manual_edits.';

-- -----------------------------------------------------------------------------
-- ninja_organization — NinjaOne's organisations, and the client each imports to.
-- -----------------------------------------------------------------------------
CREATE TABLE ninja_organization (
  tenant_id        uuid NOT NULL,
  connection_id    uuid NOT NULL,
  ninja_org_id     text NOT NULL,
  name             text NOT NULL,
  -- NULL: listed, not imported.
  organization_id  uuid,
  device_count     integer,
  seen_at          timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (connection_id, ninja_org_id),
  CONSTRAINT ninja_organization_connection_fk FOREIGN KEY (connection_id, tenant_id)
    REFERENCES integration_connection (id, tenant_id) ON DELETE CASCADE,
  -- SET NULL names its column, so deleting a client un-maps it rather than
  -- nulling tenant_id along with it.
  CONSTRAINT ninja_organization_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE SET NULL (organization_id),
  CONSTRAINT ninja_organization_count_ck CHECK (device_count IS NULL OR device_count >= 0)
);

SELECT helm.apply_tenant_rls('ninja_organization', false, 80, NULL);

CREATE TRIGGER ninja_organization_touch BEFORE UPDATE ON ninja_organization
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- -----------------------------------------------------------------------------
-- The hosts a NinjaOne connection may talk to.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.ninja_base_url_allowed(p_url text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT p_url IN (
    'https://app.ninjarmm.com', 'https://us2.ninjarmm.com', 'https://eu.ninjarmm.com',
    'https://ca.ninjarmm.com', 'https://oc.ninjarmm.com');
$$;

CREATE OR REPLACE FUNCTION helm.guard_ninja_connection() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_secret text;
BEGIN
  IF NEW.provider <> 'ninja_one' THEN
    RETURN NEW;
  END IF;

  -- A run recording its outcome changes neither, and must not be refused over
  -- a secret somebody has since deleted: the next run fails on that instead.
  IF TG_OP = 'UPDATE'
     AND NEW.provider = OLD.provider
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.base_url IS NOT DISTINCT FROM OLD.base_url
     AND NEW.credential_secret_ids = OLD.credential_secret_ids THEN
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NOT NULL THEN
    RAISE EXCEPTION 'helm: a NinjaOne connection covers every client and has no organisation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.base_url IS NULL OR NOT helm.ninja_base_url_allowed(NEW.base_url) THEN
    RAISE EXCEPTION 'helm: % is not a NinjaOne region', coalesce(NEW.base_url, 'no address')
      USING ERRCODE = 'check_violation',
            HINT = 'One of app, us2, eu, ca or oc .ninjarmm.com.';
  END IF;

  FOR v_secret IN SELECT value FROM jsonb_each_text(NEW.credential_secret_ids) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM secret s
      JOIN organization o ON o.id = s.organization_id AND o.tenant_id = s.tenant_id
      WHERE s.id::text = v_secret AND s.tenant_id = NEW.tenant_id
        AND s.kind = 'api_key' AND o.is_msp_internal AND s.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'helm: a NinjaOne connection may only use an API key kept in the MSP''s own organisation'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION helm.guard_ninja_connection() FROM PUBLIC;

CREATE TRIGGER integration_connection_ninja_guard
  BEFORE INSERT OR UPDATE ON integration_connection
  FOR EACH ROW EXECUTE FUNCTION helm.guard_ninja_connection();

-- -----------------------------------------------------------------------------
-- helm.set_ninja_connection — create or change the one connection.
--
-- An absent secret keeps the stored one, so changing the interval does not mean
-- pasting the secret again. A changed region, client id or secret clears the
-- failure count and makes the connection due now: what the last run proved no
-- longer applies.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_ninja_connection(
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
    RAISE EXCEPTION 'helm: configuring NinjaOne requires integration:rmm:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_existing FROM integration_connection
  WHERE tenant_id = v_tenant AND provider = 'ninja_one' AND organization_id IS NULL
  ORDER BY created_at LIMIT 1;

  v_secrets := CASE
    WHEN p_secret_id IS NOT NULL THEN jsonb_build_object('client_secret', p_secret_id::text)
    ELSE coalesce(v_existing.credential_secret_ids, '{}'::jsonb) END;

  IF p_sync_enabled AND NOT (v_secrets ? 'client_secret') THEN
    RAISE EXCEPTION 'helm: NinjaOne cannot sync without a client secret'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_existing.id IS NULL THEN
    INSERT INTO integration_connection (
      tenant_id, organization_id, provider, display_name, status, direction, base_url, config,
      credential_secret_ids, sync_enabled, sync_interval_minutes, created_by)
    VALUES (
      v_tenant, NULL, 'ninja_one', 'NinjaOne',
      CASE WHEN p_sync_enabled THEN 'configured' ELSE 'disabled' END::integration_status,
      'inbound', btrim(p_base_url),
      jsonb_build_object('client_id', btrim(p_client_id)),
      v_secrets, p_sync_enabled, p_interval_minutes,
      (SELECT id FROM app_user WHERE id = v_actor))
    RETURNING * INTO v_existing;
    v_changed := true;
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
      'provider', 'ninja_one',
      'base_url', btrim(p_base_url),
      'client_id', btrim(p_client_id),
      'secret_changed', p_secret_id IS NOT NULL,
      'sync_enabled', p_sync_enabled,
      'interval_minutes', p_interval_minutes));

  RETURN v_existing.id;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.record_ninja_organizations — the list NinjaOne returned.
--
-- Names and counts only; which client an organisation imports to is never
-- touched here. Runs as the caller, under RLS: the sync worker, or somebody
-- saving the connection, who sees the list straight away.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_ninja_organizations(p_connection_id uuid, p_orgs jsonb)
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

  INSERT INTO ninja_organization (tenant_id, connection_id, ninja_org_id, name, device_count, seen_at)
  SELECT v_tenant, p_connection_id, o ->> 'id', left(coalesce(nullif(btrim(o ->> 'name'), ''), 'Organisation ' || (o ->> 'id')), 200),
         (o ->> 'deviceCount')::integer, now()
  FROM jsonb_array_elements(p_orgs) AS o
  WHERE nullif(o ->> 'id', '') IS NOT NULL
  ON CONFLICT (connection_id, ninja_org_id) DO UPDATE SET
    name = EXCLUDED.name,
    device_count = coalesce(EXCLUDED.device_count, ninja_organization.device_count),
    seen_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.map_ninja_organization — which client a NinjaOne organisation imports to.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.map_ninja_organization(
  p_connection_id   uuid,
  p_ninja_org_id    text,
  p_organization_id uuid
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_before uuid;
  v_name   text;
BEGIN
  IF NOT helm.has_permission('integration:rmm:manage') THEN
    RAISE EXCEPTION 'helm: choosing what NinjaOne imports requires integration:rmm:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_organization_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM organization
    WHERE id = p_organization_id AND tenant_id = v_tenant AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'helm: no such client' USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT organization_id, name INTO v_before, v_name FROM ninja_organization
  WHERE tenant_id = v_tenant AND connection_id = p_connection_id AND ninja_org_id = p_ninja_org_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_before IS NOT DISTINCT FROM p_organization_id THEN RETURN true; END IF;

  UPDATE ninja_organization SET organization_id = p_organization_id
  WHERE tenant_id = v_tenant AND connection_id = p_connection_id AND ninja_org_id = p_ninja_org_id;

  PERFORM helm.audit(
    'integration.rmm_organization_mapped', 'integration_connection', p_connection_id, 'success',
    p_organization_id, NULL, NULL,
    jsonb_build_object('ninja_org_id', p_ninja_org_id, 'ninja_org_name', v_name,
                       'from', v_before, 'to', p_organization_id));
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.request_ninja_sync — "Sync now". Makes the connection due; the worker
-- picks it up on its next tick. Running the sync inside an HTTP request would
-- hold a transaction open for as long as NinjaOne takes to page every device.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.request_ninja_sync() RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_id     uuid;
BEGIN
  IF NOT helm.has_permission('integration:rmm:manage') THEN
    RAISE EXCEPTION 'helm: running a NinjaOne sync requires integration:rmm:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE integration_connection SET last_sync_at = NULL
  WHERE tenant_id = v_tenant AND provider = 'ninja_one' AND sync_enabled AND disabled_at IS NULL
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RETURN false; END IF;

  PERFORM helm.audit('integration.rmm_sync_requested', 'integration_connection', v_id, 'success');
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.upsert_ninja_device — one device, as the sync worker, under RLS.
--
-- p_values holds only the fields NinjaOne reported, by device column name; a
-- field it did not report is absent and nothing is cleared. Matching, in order:
-- the identity this connection already holds; else an existing configuration
-- of the same client carrying this NinjaOne id or this serial number, so a
-- machine somebody documented by hand is adopted rather than duplicated; else a
-- new configuration.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.upsert_ninja_device(
  p_connection_id   uuid,
  p_organization_id uuid,
  p_external_id     text,
  p_payload_sha256  bytea,
  p_name            text,
  p_device_type     device_type,
  p_values          jsonb
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
  -- Always NinjaOne's to set: they describe NinjaOne's view, not the machine.
  v_observed text[] := ARRAY['last_seen_at', 'rmm_device_id'];
  v_allowed  text[] := ARRAY['hostname', 'fqdn', 'operating_system', 'os_version', 'manufacturer',
                             'model', 'serial_number', 'cpu', 'memory_gb', 'primary_ip',
                             'primary_mac', 'last_seen_at', 'rmm_device_id'];
BEGIN
  SELECT respect_manual_edits INTO v_respect FROM integration_connection
  WHERE id = p_connection_id AND tenant_id = v_tenant AND provider = 'ninja_one';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: no such NinjaOne connection' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT ei.* INTO v_identity FROM external_identity ei
  WHERE ei.connection_id = p_connection_id AND ei.external_type = 'ninja_device'
    AND ei.external_id = p_external_id;

  IF v_identity.id IS NOT NULL THEN
    v_node := v_identity.node_id;
    -- Nothing NinjaOne reports has changed since last time: only the check-in.
    IF v_identity.payload_sha256 IS NOT DISTINCT FROM p_payload_sha256 THEN
      UPDATE device d SET last_seen_at = (p_values ->> 'last_seen_at')::timestamptz
      WHERE d.id = v_node AND p_values ? 'last_seen_at'
        AND d.last_seen_at IS DISTINCT FROM (p_values ->> 'last_seen_at')::timestamptz;
      UPDATE external_identity SET last_synced_at = now() WHERE id = v_identity.id;
      RETURN QUERY SELECT v_node, 'unchanged'::text;
      RETURN;
    END IF;
  ELSE
    SELECT n.id INTO v_node FROM asset_node n
    JOIN device d ON d.id = n.id
    WHERE n.tenant_id = v_tenant AND n.organization_id = p_organization_id
      AND (d.rmm_device_id = p_external_id
           OR (nullif(p_values ->> 'serial_number', '') IS NOT NULL
               AND lower(d.serial_number) = lower(p_values ->> 'serial_number')))
      AND NOT EXISTS (
        SELECT 1 FROM external_identity x
        WHERE x.connection_id = p_connection_id AND x.node_id = n.id AND x.external_type = 'ninja_device')
    ORDER BY (d.rmm_device_id = p_external_id) DESC NULLS LAST, n.created_at
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
    VALUES (v_tenant, p_connection_id, v_node, p_external_id, 'ninja_device')
    RETURNING * INTO v_identity;
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
       OR v_key = ANY (v_observed)
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
      fqdn             = CASE WHEN v_writes ? 'fqdn' THEN (v_writes ->> 'fqdn')::citext ELSE d.fqdn END,
      operating_system = CASE WHEN v_writes ? 'operating_system' THEN v_writes ->> 'operating_system' ELSE d.operating_system END,
      os_version       = CASE WHEN v_writes ? 'os_version' THEN v_writes ->> 'os_version' ELSE d.os_version END,
      manufacturer     = CASE WHEN v_writes ? 'manufacturer' THEN v_writes ->> 'manufacturer' ELSE d.manufacturer END,
      model            = CASE WHEN v_writes ? 'model' THEN v_writes ->> 'model' ELSE d.model END,
      serial_number    = CASE WHEN v_writes ? 'serial_number' THEN v_writes ->> 'serial_number' ELSE d.serial_number END,
      cpu              = CASE WHEN v_writes ? 'cpu' THEN v_writes ->> 'cpu' ELSE d.cpu END,
      memory_gb        = CASE WHEN v_writes ? 'memory_gb' THEN (v_writes ->> 'memory_gb')::numeric ELSE d.memory_gb END,
      primary_ip       = CASE WHEN v_writes ? 'primary_ip' THEN (v_writes ->> 'primary_ip')::inet ELSE d.primary_ip END,
      primary_mac      = CASE WHEN v_writes ? 'primary_mac' THEN (v_writes ->> 'primary_mac')::macaddr ELSE d.primary_mac END,
      last_seen_at     = CASE WHEN v_writes ? 'last_seen_at' THEN (v_writes ->> 'last_seen_at')::timestamptz ELSE d.last_seen_at END,
      rmm_device_id    = CASE WHEN v_writes ? 'rmm_device_id' THEN v_writes ->> 'rmm_device_id' ELSE d.rmm_device_id END
    WHERE d.id = v_node;

    -- Stored as the column now reads it back, so the next comparison is like
    -- for like: 16 GB written as 16 reads back as 16.00.
    SELECT v_applied || (SELECT jsonb_object_agg(k, to_jsonb(d) -> k)
                         FROM jsonb_object_keys(v_writes) AS k)
    INTO v_applied FROM device d WHERE d.id = v_node;
  END IF;

  UPDATE external_identity SET
    payload_sha256 = p_payload_sha256,
    applied = v_applied,
    last_synced_at = now()
  WHERE id = v_identity.id;

  RETURN QUERY SELECT v_node,
    CASE WHEN v_created THEN 'created'
         WHEN v_writes - 'last_seen_at' <> '{}'::jsonb THEN 'updated'
         ELSE 'unchanged' END;
END;
$$;

-- -----------------------------------------------------------------------------
-- Grants. helm_app (and so helm_worker) runs these; the SECURITY DEFINER ones
-- check integration:rmm:manage themselves.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION helm.set_ninja_connection(text, text, uuid, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_ninja_organizations(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.map_ninja_organization(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.request_ninja_sync() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.upsert_ninja_device(uuid, uuid, text, bytea, text, device_type, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.set_ninja_connection(text, text, uuid, boolean, integer) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.record_ninja_organizations(uuid, jsonb) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.map_ninja_organization(uuid, text, uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.request_ninja_sync() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.upsert_ninja_device(uuid, uuid, text, bytea, text, device_type, jsonb) TO helm_app;

-- -----------------------------------------------------------------------------
-- Guard: the device upsert names no column a person owns.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  v_src  text;
  v_col  text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE oid = 'helm.upsert_ninja_device(uuid, uuid, text, bytea, text, device_type, jsonb)'::regprocedure;

  FOREACH v_col IN ARRAY ARRAY[
    'device_type', 'asset_tag', 'contact_id', 'notes', 'backup_policy', 'management_url',
    'warranty_expires_at', 'purchased_at', 'end_of_life_at', 'os_notes'
  ] LOOP
    IF v_src ~ ('\m' || v_col || '\s*=') THEN
      RAISE EXCEPTION '0980: helm.upsert_ninja_device assigns %, which a person owns', v_col;
    END IF;
  END LOOP;
END
$guard$;
