-- =============================================================================
-- 1110 — Proxmox VE: hosts, virtual machines and containers
--
-- One connection PER PROXMOX CLUSTER (or standalone host), provider 'proxmox',
-- and each belongs to ONE CLIENT (organization_id set): the client whose
-- servers they are. Several clusters may import to the same client; they are
-- told apart by display_name. Everything a connection imports goes to its
-- client, which is the only way a VM can arrive in Helm at all — there is no
-- name matching across clients and no default.
--
-- AUTHENTICATION is a Proxmox API token: an id like helm@pve!helm in config,
-- its secret in `secret` like every other credential. A read-only token (the
-- PVEAuditor role) reads everything this needs except a guest agent's view of
-- a VM's addresses and operating system, which Proxmox gates separately.
--
-- WHAT IS IMPORTED
--
--   Each Proxmox host (node) becomes a configuration of type hypervisor: its
--   name, CPU, memory, address and Proxmox version.
--
--   Each VM and container becomes a configuration of type virtual_machine:
--   hostname, operating system, vCPUs, memory, disk, address and MAC, and the
--   host it runs on (device.parent_device_id, which the dependency map already
--   draws as "hosted on"). Templates are not machines and are not imported.
--
--   What is not a column — status, disks, network interfaces, snapshots, the
--   last backup, tags, pool, a host's storage — goes in external_identity.
--   profile and shows read-only on the configuration, as NinjaOne's does
--   (1080).
--
-- WHAT A SYNC MAY CHANGE, and what it may not, is NinjaOne's rule (0980): only
-- the observed columns named in helm.upsert_proxmox_machine(), and of those
-- only a field still holding what the sync last wrote. A VM somebody moved to
-- another host by hand, renamed, or retyped stays as they left it.
--
-- A MACHINE ALREADY DOCUMENTED — by hand or by NinjaOne — is adopted rather
-- than doubled: a configuration of the same client with the same MAC, or the
-- same hostname or name, that this connection has not already claimed. Its
-- fields keep the values they have, because they were not written by this
-- sync; the profile and anything still empty are filled in.
--
-- WHERE THE SECRET MAY GO. Proxmox is self-hosted, so unlike NinjaOne there is
-- no list of hosts to hold the address to. What holds instead:
--
--   * the address is an https origin, nothing more;
--   * the token secret is an API key kept in the MSP's own organisation;
--   * the address and the certificate pin cannot change WITHOUT THE SECRET
--     CHANGING TOO. A stored token can therefore never be pointed at another
--     host by editing the row: whoever moves it has to know the secret
--     already, so moving it gives them nothing. The route asks for the secret
--     again for the same reason, and this trigger is what makes that hold
--     however the row is written.
--
-- SELF-SIGNED CERTIFICATES are the normal case for Proxmox. config.tls_sha256
-- pins the one certificate a connection accepts, as UniFi does (0430):
-- interception is still detected, where turning verification off would not.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Permission: its own scope, for the reason 0430 gives for the network one.
-- -----------------------------------------------------------------------------
INSERT INTO permission (key, category, description, msp_only) VALUES
  ('integration:hypervisor:manage', 'integration',
   'Connect Proxmox clusters, their API tokens, and the client each imports to', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permission (role_key, permission_key)
SELECT r.key, 'integration:hypervisor:manage'
FROM app_role r WHERE r.key IN ('super_admin', 'tier3')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- What a Proxmox connection's row may hold.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.proxmox_base_url_ok(p_url text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT coalesce(p_url ~ '^https://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$', false);
$$;

CREATE OR REPLACE FUNCTION helm.guard_proxmox_connection() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_secret text;
BEGIN
  IF NEW.provider <> 'proxmox' THEN
    RETURN NEW;
  END IF;

  -- A run recording its outcome, or a change of interval, touches none of it.
  IF TG_OP = 'UPDATE'
     AND NEW.provider = OLD.provider
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.base_url IS NOT DISTINCT FROM OLD.base_url
     AND NEW.config ->> 'token_id' IS NOT DISTINCT FROM OLD.config ->> 'token_id'
     AND NEW.config ->> 'tls_sha256' IS NOT DISTINCT FROM OLD.config ->> 'tls_sha256'
     AND NEW.credential_secret_ids = OLD.credential_secret_ids THEN
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'helm: a Proxmox connection belongs to one client'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT helm.proxmox_base_url_ok(NEW.base_url) THEN
    RAISE EXCEPTION 'helm: % is not an https address with no path', coalesce(NEW.base_url, 'no address')
      USING ERRCODE = 'check_violation', HINT = 'Like https://pve.example.com:8006.';
  END IF;

  IF coalesce(NEW.config ->> 'token_id', '') !~ '^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z][A-Za-z0-9._-]*$' THEN
    RAISE EXCEPTION 'helm: % is not a Proxmox API token id', coalesce(NEW.config ->> 'token_id', 'nothing')
      USING ERRCODE = 'check_violation', HINT = 'Like helm@pve!helm: user@realm!token.';
  END IF;

  IF NEW.config ? 'tls_sha256' AND coalesce(NEW.config ->> 'tls_sha256', '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'helm: a certificate pin is 64 lowercase hex characters'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (NEW.base_url IS DISTINCT FROM OLD.base_url
          OR NEW.config ->> 'tls_sha256' IS DISTINCT FROM OLD.config ->> 'tls_sha256')
     AND NEW.credential_secret_ids = OLD.credential_secret_ids THEN
    RAISE EXCEPTION 'helm: a Proxmox connection''s address or certificate changes only with its token secret'
      USING ERRCODE = 'check_violation',
            HINT = 'Enter the token secret again, so the stored one is never sent somewhere new.';
  END IF;

  IF NOT (NEW.credential_secret_ids ? 'token_secret') THEN
    RAISE EXCEPTION 'helm: a Proxmox connection needs its token secret'
      USING ERRCODE = 'check_violation';
  END IF;

  FOR v_secret IN SELECT value FROM jsonb_each_text(NEW.credential_secret_ids) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM secret s
      JOIN organization o ON o.id = s.organization_id AND o.tenant_id = s.tenant_id
      WHERE s.id::text = v_secret AND s.tenant_id = NEW.tenant_id
        AND s.kind = 'api_key' AND o.is_msp_internal AND s.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'helm: a Proxmox connection may only use an API key kept in the MSP''s own organisation'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION helm.guard_proxmox_connection() FROM PUBLIC;

CREATE TRIGGER integration_connection_proxmox_guard
  BEFORE INSERT OR UPDATE ON integration_connection
  FOR EACH ROW EXECUTE FUNCTION helm.guard_proxmox_connection();

-- -----------------------------------------------------------------------------
-- helm.set_proxmox_connection — connect a cluster, or change its connection.
--
-- p_connection_id NULL adds one. An absent secret keeps the stored one, which
-- the trigger refuses when the address or pin changed. A changed address, pin,
-- token or secret clears the failure count and makes the connection due now.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_proxmox_connection(
  p_connection_id    uuid,
  p_organization_id  uuid,
  p_name             text,
  p_base_url         text,
  p_token_id         text,
  p_secret_id        uuid,
  p_tls_sha256       text,
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
  v_config   jsonb;
  v_name     text := left(btrim(coalesce(p_name, '')), 120);
  v_url      text := rtrim(btrim(coalesce(p_base_url, '')), '/');
  v_pin      text := nullif(lower(replace(btrim(coalesce(p_tls_sha256, '')), ':', '')), '');
  v_changed  boolean;
BEGIN
  IF NOT helm.has_permission('integration:hypervisor:manage') THEN
    RAISE EXCEPTION 'helm: connecting Proxmox requires integration:hypervisor:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM organization WHERE id = p_organization_id AND tenant_id = v_tenant AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'helm: no such client' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_name = '' THEN v_name := 'Proxmox'; END IF;

  IF p_connection_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM integration_connection
    WHERE id = p_connection_id AND tenant_id = v_tenant AND provider = 'proxmox'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'helm: no such Proxmox connection' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  v_secrets := CASE
    WHEN p_secret_id IS NOT NULL THEN jsonb_build_object('token_secret', p_secret_id::text)
    ELSE coalesce(v_existing.credential_secret_ids, '{}'::jsonb) END;

  v_config := (coalesce(v_existing.config, '{}'::jsonb) - 'tls_sha256')
    || jsonb_build_object('token_id', btrim(p_token_id))
    || CASE WHEN v_pin IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('tls_sha256', v_pin) END;

  IF v_existing.id IS NULL THEN
    INSERT INTO integration_connection (
      tenant_id, organization_id, provider, display_name, status, direction, base_url, config,
      credential_secret_ids, sync_enabled, sync_interval_minutes, created_by)
    VALUES (
      v_tenant, p_organization_id, 'proxmox', v_name,
      CASE WHEN p_sync_enabled THEN 'configured' ELSE 'disabled' END::integration_status,
      'inbound', v_url, v_config, v_secrets, p_sync_enabled, p_interval_minutes,
      (SELECT id FROM app_user WHERE id = v_actor))
    RETURNING * INTO v_existing;
  ELSE
    v_changed := v_existing.base_url IS DISTINCT FROM v_url
      OR v_existing.config ->> 'token_id' IS DISTINCT FROM btrim(p_token_id)
      OR v_existing.config ->> 'tls_sha256' IS DISTINCT FROM v_pin
      OR v_existing.organization_id IS DISTINCT FROM p_organization_id
      OR p_secret_id IS NOT NULL;

    UPDATE integration_connection SET
      organization_id = p_organization_id,
      display_name = v_name,
      base_url = v_url,
      config = v_config,
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
    'integration.hypervisor_connection_saved', 'integration_connection', v_existing.id, 'success',
    p_organization_id, NULL, NULL,
    jsonb_build_object(
      'provider', 'proxmox',
      'name', v_name,
      'base_url', v_url,
      'token_id', btrim(p_token_id),
      'tls_pinned', v_pin IS NOT NULL,
      'secret_changed', p_secret_id IS NOT NULL,
      'sync_enabled', p_sync_enabled,
      'interval_minutes', p_interval_minutes));

  RETURN v_existing.id;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.forget_proxmox_connection — disconnect a cluster. The hosts and VMs it
-- imported stay, as the client's documentation; only the links back go.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.forget_proxmox_connection(p_connection_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_org    uuid;
BEGIN
  IF NOT helm.has_permission('integration:hypervisor:manage') THEN
    RAISE EXCEPTION 'helm: disconnecting Proxmox requires integration:hypervisor:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM integration_connection
  WHERE id = p_connection_id AND tenant_id = v_tenant AND provider = 'proxmox'
  RETURNING organization_id INTO v_org;
  IF v_org IS NULL THEN RETURN false; END IF;

  PERFORM helm.audit('integration.hypervisor_connection_removed', 'integration_connection', p_connection_id,
                     'success', v_org);
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.request_proxmox_sync — "Sync now"; the worker runs it within a minute.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.request_proxmox_sync(p_connection_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_org    uuid;
BEGIN
  IF NOT helm.has_permission('integration:hypervisor:manage') THEN
    RAISE EXCEPTION 'helm: running a Proxmox sync requires integration:hypervisor:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE integration_connection SET last_sync_at = NULL
  WHERE id = p_connection_id AND tenant_id = v_tenant AND provider = 'proxmox'
    AND sync_enabled AND disabled_at IS NULL
  RETURNING organization_id INTO v_org;
  IF v_org IS NULL THEN RETURN false; END IF;

  PERFORM helm.audit('integration.hypervisor_sync_requested', 'integration_connection', p_connection_id,
                     'success', v_org);
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.upsert_proxmox_machine — one host or guest, as the sync worker, under RLS.
--
-- p_kind is 'node' or 'guest'; the external id is the node's name or the
-- guest's VMID, which Proxmox keeps unique across a cluster. The client is the
-- connection's, read here rather than passed, so the worker has no way to name
-- another. A client somebody archived or deleted imports nothing.
--
-- p_values holds only what Proxmox reported, by device column name.
-- p_host_external_id names a guest's host; the host is imported first, and its
-- configuration becomes the guest's parent_device_id by the same edit rule as
-- every other field. p_profile is the read-only rest, rewritten every run.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.upsert_proxmox_machine(
  p_connection_id    uuid,
  p_kind             text,
  p_external_id      text,
  p_payload_sha256   bytea,
  p_name             text,
  p_device_type      device_type,
  p_values           jsonb,
  p_host_external_id text,
  p_profile          jsonb
) RETURNS TABLE (node_id uuid, outcome text)
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant   uuid := helm.require_tenant_id();
  v_type     text;
  v_org      uuid;
  v_respect  boolean;
  v_identity external_identity%ROWTYPE;
  v_node     uuid;
  v_created  boolean := false;
  v_values   jsonb := coalesce(p_values, '{}'::jsonb);
  v_current  jsonb;
  v_writes   jsonb := '{}'::jsonb;
  v_applied  jsonb;
  v_key      text;
  v_new      jsonb;
  v_now_val  jsonb;
  v_host     uuid;
  v_allowed  text[] := ARRAY['hostname', 'operating_system', 'os_version', 'cpu', 'memory_gb',
                             'storage_gb', 'primary_ip', 'primary_mac', 'parent_device_id'];
BEGIN
  IF p_kind NOT IN ('node', 'guest') THEN
    RAISE EXCEPTION 'helm: a Proxmox machine is a node or a guest' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_type := 'proxmox_' || p_kind;

  SELECT c.organization_id, c.respect_manual_edits INTO v_org, v_respect
  FROM integration_connection c
  JOIN organization o ON o.id = c.organization_id
  WHERE c.id = p_connection_id AND c.tenant_id = v_tenant AND c.provider = 'proxmox'
    AND o.deleted_at IS NULL AND o.archived_at IS NULL;
  IF v_org IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, 'skipped'::text;
    RETURN;
  END IF;

  -- The host, as this connection imported it. Not one of another client's.
  IF p_kind = 'guest' AND p_host_external_id IS NOT NULL THEN
    SELECT ei.node_id INTO v_host FROM external_identity ei
    JOIN asset_node n ON n.id = ei.node_id
    WHERE ei.connection_id = p_connection_id AND ei.external_type = 'proxmox_node'
      AND ei.external_id = p_host_external_id AND n.organization_id = v_org;
    IF v_host IS NOT NULL THEN
      v_values := v_values || jsonb_build_object('parent_device_id', v_host::text);
    END IF;
  END IF;

  SELECT ei.* INTO v_identity FROM external_identity ei
  WHERE ei.connection_id = p_connection_id AND ei.external_type = v_type
    AND ei.external_id = p_external_id;

  -- Imported to another client before the connection was moved: that one
  -- stays the old client's documentation, and this client gets its own.
  IF v_identity.id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM asset_node n WHERE n.id = v_identity.node_id AND n.organization_id = v_org) THEN
    DELETE FROM external_identity WHERE id = v_identity.id;
    v_identity := NULL;
  END IF;

  IF v_identity.id IS NOT NULL THEN
    v_node := v_identity.node_id;
    IF v_identity.payload_sha256 IS NOT DISTINCT FROM p_payload_sha256 THEN
      UPDATE external_identity SET last_synced_at = now(), profile = p_profile WHERE id = v_identity.id;
      RETURN QUERY SELECT v_node, 'unchanged'::text;
      RETURN;
    END IF;
  ELSE
    SELECT n.id INTO v_node FROM asset_node n
    JOIN device d ON d.id = n.id
    WHERE n.tenant_id = v_tenant AND n.organization_id = v_org
      AND (
        (nullif(v_values ->> 'primary_mac', '') IS NOT NULL
         AND d.primary_mac = (v_values ->> 'primary_mac')::macaddr)
        OR lower(d.hostname::text) = lower(coalesce(v_values ->> 'hostname', p_name))
        OR lower(btrim(n.name)) = lower(btrim(p_name)))
      AND NOT EXISTS (
        SELECT 1 FROM external_identity x
        WHERE x.connection_id = p_connection_id AND x.node_id = n.id AND x.external_type LIKE 'proxmox\_%')
    ORDER BY (nullif(v_values ->> 'primary_mac', '') IS NOT NULL
              AND d.primary_mac = (v_values ->> 'primary_mac')::macaddr) DESC,
             n.created_at
    LIMIT 1;

    IF v_node IS NULL THEN
      INSERT INTO asset_node (tenant_id, organization_id, node_type, name, status)
      VALUES (v_tenant, v_org, 'device', left(btrim(p_name), 200), 'active')
      RETURNING id INTO v_node;
      INSERT INTO device (id, tenant_id, node_type, device_type)
      VALUES (v_node, v_tenant, 'device', p_device_type);
      v_created := true;
    END IF;

    INSERT INTO external_identity (tenant_id, connection_id, node_id, external_id, external_type)
    VALUES (v_tenant, p_connection_id, v_node, p_external_id, v_type)
    RETURNING * INTO v_identity;
  END IF;

  SELECT to_jsonb(d) INTO v_current FROM device d WHERE d.id = v_node;
  v_applied := v_identity.applied;

  FOR v_key IN SELECT jsonb_object_keys(v_values) LOOP
    CONTINUE WHEN NOT (v_key = ANY (v_allowed));
    v_new := v_values -> v_key;
    CONTINUE WHEN v_new IS NULL OR jsonb_typeof(v_new) = 'null';
    CONTINUE WHEN v_key = 'parent_device_id' AND v_new #>> '{}' = v_node::text;
    v_now_val := v_current -> v_key;
    CONTINUE WHEN v_now_val = v_new;

    IF NOT v_respect
       OR v_now_val IS NULL OR jsonb_typeof(v_now_val) = 'null'
       OR v_now_val = v_applied -> v_key THEN
      v_writes := v_writes || jsonb_build_object(v_key, v_new);
    END IF;
  END LOOP;

  IF v_writes <> '{}'::jsonb THEN
    -- Every column named, and nothing a person owns among them; the guard at
    -- the end of this file fails if one is added.
    UPDATE device d SET
      hostname         = CASE WHEN v_writes ? 'hostname' THEN (v_writes ->> 'hostname')::citext ELSE d.hostname END,
      operating_system = CASE WHEN v_writes ? 'operating_system' THEN v_writes ->> 'operating_system' ELSE d.operating_system END,
      os_version       = CASE WHEN v_writes ? 'os_version' THEN v_writes ->> 'os_version' ELSE d.os_version END,
      cpu              = CASE WHEN v_writes ? 'cpu' THEN v_writes ->> 'cpu' ELSE d.cpu END,
      memory_gb        = CASE WHEN v_writes ? 'memory_gb' THEN (v_writes ->> 'memory_gb')::numeric ELSE d.memory_gb END,
      storage_gb       = CASE WHEN v_writes ? 'storage_gb' THEN (v_writes ->> 'storage_gb')::numeric ELSE d.storage_gb END,
      primary_ip       = CASE WHEN v_writes ? 'primary_ip' THEN (v_writes ->> 'primary_ip')::inet ELSE d.primary_ip END,
      primary_mac      = CASE WHEN v_writes ? 'primary_mac' THEN (v_writes ->> 'primary_mac')::macaddr ELSE d.primary_mac END,
      parent_device_id = CASE WHEN v_writes ? 'parent_device_id' THEN (v_writes ->> 'parent_device_id')::uuid ELSE d.parent_device_id END
    WHERE d.id = v_node;

    -- As the column reads it back, so the next comparison is like for like.
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

REVOKE ALL ON FUNCTION helm.proxmox_base_url_ok(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_proxmox_connection(uuid, uuid, text, text, text, uuid, text, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.forget_proxmox_connection(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.request_proxmox_sync(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.upsert_proxmox_machine(uuid, text, text, bytea, text, device_type, jsonb, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.proxmox_base_url_ok(text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_proxmox_connection(uuid, uuid, text, text, text, uuid, text, boolean, integer) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.forget_proxmox_connection(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.request_proxmox_sync(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.upsert_proxmox_machine(uuid, text, text, bytea, text, device_type, jsonb, text, jsonb) TO helm_app;

-- -----------------------------------------------------------------------------
-- Guard: the machine upsert names no column a person owns.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  v_src  text;
  v_col  text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE oid = 'helm.upsert_proxmox_machine(uuid, text, text, bytea, text, device_type, jsonb, text, jsonb)'::regprocedure;

  FOREACH v_col IN ARRAY ARRAY[
    'device_type', 'asset_tag', 'contact_id', 'notes', 'backup_policy', 'management_url',
    'warranty_expires_at', 'purchased_at', 'end_of_life_at', 'os_notes', 'serial_number'
  ] LOOP
    IF v_src ~ ('\m' || v_col || '\s*=') THEN
      RAISE EXCEPTION '1110: helm.upsert_proxmox_machine assigns %, which a person owns', v_col;
    END IF;
  END LOOP;
END
$guard$;
