-- =============================================================================
-- 0990 — Microsoft 365 sync
--
-- One connection PER CLIENT (provider 'microsoft_graph', organization_id set):
-- each client's Microsoft 365 is its own Entra tenant. The app that reads it is
-- an Entra app registration with application permissions — usually one
-- multi-tenant app of the MSP's, consented to in each client's tenant, so the
-- same client id and secret serve every connection; a per-client app works as
-- well. config holds the client's Entra tenant (id or domain) and the app's
-- client id; the secret is in `secret` like every credential.
--
-- WHAT IS IMPORTED, each part switchable per client:
--
--   users     enabled, licensed member accounts become the client's contacts —
--             name, job title, email, desk phone, mobile. Shared mailboxes,
--             rooms and guests are unlicensed or not members, and are left out.
--   licences  each paid subscription becomes a licence, with seats bought and
--             in use kept current.
--   domains   each verified domain becomes a domain entry (the
--             *.onmicrosoft.com one excepted).
--
-- WHAT IT NEVER DOES. Write to Microsoft 365. Delete or archive anything here
-- because it is gone there. Overwrite a field a person edited: as for NinjaOne
-- (0980), the sync remembers what it last wrote to each field, and a field now
-- holding anything else is left alone. For a contact's addresses and numbers it
-- edits only the entry it added itself, and does not put back one a person
-- removed.
--
-- Contacts are not asset nodes, so they cannot use external_identity; they get
-- m365_contact_link, which is the same idea.
-- =============================================================================

SET search_path = public, extensions;

INSERT INTO permission (key, category, description, msp_only) VALUES
  ('integration:m365:manage', 'integration',
   'Connect clients'' Microsoft 365 tenants and choose what is imported', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permission (role_key, permission_key)
SELECT r.key, 'integration:m365:manage'
FROM app_role r WHERE r.key IN ('super_admin', 'tier3')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- m365_contact_link — a Microsoft 365 user and the contact it became.
-- -----------------------------------------------------------------------------
CREATE TABLE m365_contact_link (
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,
  connection_id    uuid NOT NULL,
  graph_user_id    text NOT NULL,
  contact_id       uuid NOT NULL,
  payload_sha256   bytea,
  applied          jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (connection_id, graph_user_id),
  CONSTRAINT m365_contact_link_contact_uk UNIQUE (connection_id, contact_id),
  CONSTRAINT m365_contact_link_connection_fk FOREIGN KEY (connection_id, tenant_id)
    REFERENCES integration_connection (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT m365_contact_link_contact_fk FOREIGN KEY (contact_id, tenant_id)
    REFERENCES contact (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT m365_contact_link_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT m365_contact_link_applied_object CHECK (jsonb_typeof(applied) = 'object'),
  CONSTRAINT m365_contact_link_sha_len CHECK (payload_sha256 IS NULL OR octet_length(payload_sha256) = 32)
);
CREATE INDEX m365_contact_link_contact_idx ON m365_contact_link (contact_id);

SELECT helm.apply_tenant_rls('m365_contact_link', true, 80, NULL);

-- -----------------------------------------------------------------------------
-- Where a Microsoft 365 connection may point, whoever writes the row.
--
-- base_url is Graph and nothing else, and the Entra tenant is a GUID or a
-- domain, because it goes into the token URL's path. The secret is an API key
-- kept either in the MSP's own organisation (the multi-tenant app) or in this
-- client's (an app of their own) — never another client's.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.guard_graph_connection() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_secret text;
BEGIN
  IF NEW.provider <> 'microsoft_graph' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.provider = OLD.provider
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.base_url IS NOT DISTINCT FROM OLD.base_url
     AND NEW.config ->> 'tenant_id' IS NOT DISTINCT FROM OLD.config ->> 'tenant_id'
     AND NEW.credential_secret_ids = OLD.credential_secret_ids THEN
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'helm: a Microsoft 365 connection belongs to one client'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.base_url IS DISTINCT FROM 'https://graph.microsoft.com' THEN
    RAISE EXCEPTION 'helm: a Microsoft 365 connection talks to https://graph.microsoft.com only'
      USING ERRCODE = 'check_violation';
  END IF;

  IF coalesce(NEW.config ->> 'tenant_id', '') !~ '^[A-Za-z0-9][A-Za-z0-9.-]{1,252}$' THEN
    RAISE EXCEPTION 'helm: % is not an Entra tenant id or domain', coalesce(NEW.config ->> 'tenant_id', 'nothing')
      USING ERRCODE = 'check_violation';
  END IF;

  FOR v_secret IN SELECT value FROM jsonb_each_text(NEW.credential_secret_ids) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM secret s
      JOIN organization o ON o.id = s.organization_id AND o.tenant_id = s.tenant_id
      WHERE s.id::text = v_secret AND s.tenant_id = NEW.tenant_id
        AND s.kind = 'api_key' AND s.deleted_at IS NULL
        AND (o.is_msp_internal OR o.id = NEW.organization_id)
    ) THEN
      RAISE EXCEPTION 'helm: a Microsoft 365 connection may only use an API key kept in the MSP''s organisation or this client''s'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION helm.guard_graph_connection() FROM PUBLIC;

CREATE TRIGGER integration_connection_graph_guard
  BEFORE INSERT OR UPDATE ON integration_connection
  FOR EACH ROW EXECUTE FUNCTION helm.guard_graph_connection();

-- -----------------------------------------------------------------------------
-- helm.set_m365_connection — connect a client, or change its connection.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_m365_connection(
  p_organization_id  uuid,
  p_entra_tenant     text,
  p_tenant_name      text,
  p_client_id        text,
  p_secret_id        uuid,
  p_sync_enabled     boolean,
  p_interval_minutes integer,
  p_sync_users       boolean,
  p_sync_licences    boolean,
  p_sync_domains     boolean
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
  v_changed  boolean;
BEGIN
  IF NOT helm.has_permission('integration:m365:manage') THEN
    RAISE EXCEPTION 'helm: connecting Microsoft 365 requires integration:m365:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM organization WHERE id = p_organization_id AND tenant_id = v_tenant AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'helm: no such client' USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT * INTO v_existing FROM integration_connection
  WHERE tenant_id = v_tenant AND provider = 'microsoft_graph' AND organization_id = p_organization_id
  ORDER BY created_at LIMIT 1;

  v_secrets := CASE
    WHEN p_secret_id IS NOT NULL THEN jsonb_build_object('client_secret', p_secret_id::text)
    ELSE coalesce(v_existing.credential_secret_ids, '{}'::jsonb) END;

  IF NOT (v_secrets ? 'client_secret') THEN
    RAISE EXCEPTION 'helm: Microsoft 365 cannot be connected without a client secret'
      USING ERRCODE = 'check_violation';
  END IF;

  v_config := coalesce(v_existing.config, '{}'::jsonb) || jsonb_build_object(
    'tenant_id', btrim(p_entra_tenant),
    'client_id', btrim(p_client_id),
    'sync_users', p_sync_users,
    'sync_licences', p_sync_licences,
    'sync_domains', p_sync_domains)
    || CASE WHEN p_tenant_name IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('tenant_name', left(btrim(p_tenant_name), 200)) END;

  IF v_existing.id IS NULL THEN
    INSERT INTO integration_connection (
      tenant_id, organization_id, provider, display_name, status, direction, base_url, config,
      credential_secret_ids, sync_enabled, sync_interval_minutes, created_by)
    VALUES (
      v_tenant, p_organization_id, 'microsoft_graph', 'Microsoft 365',
      CASE WHEN p_sync_enabled THEN 'configured' ELSE 'disabled' END::integration_status,
      'inbound', 'https://graph.microsoft.com', v_config, v_secrets,
      p_sync_enabled, p_interval_minutes, (SELECT id FROM app_user WHERE id = v_actor))
    RETURNING * INTO v_existing;
  ELSE
    v_changed := v_existing.config ->> 'tenant_id' IS DISTINCT FROM btrim(p_entra_tenant)
      OR v_existing.config ->> 'client_id' IS DISTINCT FROM btrim(p_client_id)
      OR p_secret_id IS NOT NULL;

    UPDATE integration_connection SET
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
    'integration.m365_connection_saved', 'integration_connection', v_existing.id, 'success',
    p_organization_id, NULL, NULL,
    jsonb_build_object(
      'entra_tenant', btrim(p_entra_tenant),
      'client_id', btrim(p_client_id),
      'secret_changed', p_secret_id IS NOT NULL,
      'sync_enabled', p_sync_enabled,
      'interval_minutes', p_interval_minutes,
      'users', p_sync_users, 'licences', p_sync_licences, 'domains', p_sync_domains));

  RETURN v_existing.id;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.forget_m365_connection — disconnect a client. What was imported stays:
-- the contacts, licences and domains are the client's documentation now, and
-- only the links back to Microsoft 365 go.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.forget_m365_connection(p_connection_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_org    uuid;
BEGIN
  IF NOT helm.has_permission('integration:m365:manage') THEN
    RAISE EXCEPTION 'helm: disconnecting Microsoft 365 requires integration:m365:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM integration_connection
  WHERE id = p_connection_id AND tenant_id = v_tenant AND provider = 'microsoft_graph'
  RETURNING organization_id INTO v_org;
  IF v_org IS NULL THEN RETURN false; END IF;

  PERFORM helm.audit('integration.m365_connection_removed', 'integration_connection', p_connection_id,
                     'success', v_org);
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.request_m365_sync — "Sync now"; the worker runs it within a minute.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.request_m365_sync(p_connection_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_org    uuid;
BEGIN
  IF NOT helm.has_permission('integration:m365:manage') THEN
    RAISE EXCEPTION 'helm: running a Microsoft 365 sync requires integration:m365:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE integration_connection SET last_sync_at = NULL
  WHERE id = p_connection_id AND tenant_id = v_tenant AND provider = 'microsoft_graph'
    AND sync_enabled AND disabled_at IS NULL
  RETURNING organization_id INTO v_org;
  IF v_org IS NULL THEN RETURN false; END IF;

  PERFORM helm.audit('integration.m365_sync_requested', 'integration_connection', p_connection_id,
                     'success', v_org);
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- The connection a sync is writing for, checked once per call.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.graph_connection_scope(p_connection_id uuid, OUT organization_id uuid, OUT respect boolean)
  LANGUAGE plpgsql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  SELECT c.organization_id, c.respect_manual_edits INTO organization_id, respect
  FROM integration_connection c
  WHERE c.id = p_connection_id AND c.tenant_id = helm.require_tenant_id() AND c.provider = 'microsoft_graph';
  IF organization_id IS NULL THEN
    RAISE EXCEPTION 'helm: no such Microsoft 365 connection' USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.upsert_m365_user — one Microsoft 365 user, as the client's contact.
--
-- p_values: first_name, last_name (always), title, email, phone, mobile (when
-- Microsoft 365 has them). Matching: the link this connection holds; else a
-- contact of this client with that email address, so somebody already
-- documented is adopted; else a new contact.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.upsert_m365_user(
  p_connection_id  uuid,
  p_graph_user_id  text,
  p_payload_sha256 bytea,
  p_values         jsonb
) RETURNS TABLE (contact_id uuid, outcome text)
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant   uuid := helm.require_tenant_id();
  v_scope    record;
  v_link     m365_contact_link%ROWTYPE;
  v_contact  contact%ROWTYPE;
  v_id       uuid;
  v_applied  jsonb;
  v_changed  boolean := false;
  v_key      text;
  v_new      text;
  v_old      text;
  v_cur      text;
  v_writes   jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO v_scope FROM helm.graph_connection_scope(p_connection_id);

  SELECT * INTO v_link FROM m365_contact_link l
  WHERE l.connection_id = p_connection_id AND l.graph_user_id = p_graph_user_id;

  IF v_link.contact_id IS NOT NULL THEN
    SELECT * INTO v_contact FROM contact c WHERE c.id = v_link.contact_id;
    -- Deleted here on purpose: not brought back.
    IF v_contact.deleted_at IS NOT NULL THEN
      RETURN QUERY SELECT v_contact.id, 'skipped'::text;
      RETURN;
    END IF;
    IF v_link.payload_sha256 IS NOT DISTINCT FROM p_payload_sha256 THEN
      UPDATE m365_contact_link SET last_synced_at = now()
      WHERE connection_id = p_connection_id AND graph_user_id = p_graph_user_id;
      RETURN QUERY SELECT v_contact.id, 'unchanged'::text;
      RETURN;
    END IF;
    v_applied := v_link.applied;
  ELSE
    IF nullif(p_values ->> 'email', '') IS NOT NULL THEN
      SELECT c.* INTO v_contact FROM contact c
      WHERE c.tenant_id = v_tenant AND c.organization_id = v_scope.organization_id
        AND c.deleted_at IS NULL
        AND (lower(c.email::text) = lower(p_values ->> 'email')
             OR EXISTS (SELECT 1 FROM contact_email e
                        WHERE e.contact_id = c.id AND lower(e.address::text) = lower(p_values ->> 'email')))
        AND NOT EXISTS (SELECT 1 FROM m365_contact_link x
                        WHERE x.connection_id = p_connection_id AND x.contact_id = c.id)
      ORDER BY c.created_at
      LIMIT 1;
    END IF;

    IF v_contact.id IS NULL THEN
      -- New: the channel tables are seeded from these columns (0790).
      INSERT INTO contact (tenant_id, organization_id, first_name, last_name, title, email, phone, mobile)
      VALUES (v_tenant, v_scope.organization_id,
              coalesce(p_values ->> 'first_name', ''), coalesce(p_values ->> 'last_name', ''),
              p_values ->> 'title', (p_values ->> 'email')::citext, p_values ->> 'phone',
              p_values ->> 'mobile')
      RETURNING id INTO v_id;

      INSERT INTO m365_contact_link (tenant_id, organization_id, connection_id, graph_user_id, contact_id,
                                     payload_sha256, applied)
      VALUES (v_tenant, v_scope.organization_id, p_connection_id, p_graph_user_id, v_id,
              p_payload_sha256, jsonb_strip_nulls(p_values));
      RETURN QUERY SELECT v_id, 'created'::text;
      RETURN;
    END IF;

    INSERT INTO m365_contact_link (tenant_id, organization_id, connection_id, graph_user_id, contact_id)
    VALUES (v_tenant, v_scope.organization_id, p_connection_id, p_graph_user_id, v_contact.id);
    v_applied := '{}'::jsonb;
  END IF;

  v_id := v_contact.id;

  -- Names and job title: the contact's own columns.
  FOREACH v_key IN ARRAY ARRAY['first_name', 'last_name', 'title'] LOOP
    v_new := nullif(p_values ->> v_key, '');
    CONTINUE WHEN v_new IS NULL;
    v_cur := nullif(to_jsonb(v_contact) ->> v_key, '');
    CONTINUE WHEN v_cur IS NOT DISTINCT FROM v_new;
    IF NOT v_scope.respect OR v_cur IS NULL OR v_cur = v_applied ->> v_key THEN
      v_writes := v_writes || jsonb_build_object(v_key, v_new);
    END IF;
  END LOOP;

  IF v_writes <> '{}'::jsonb THEN
    UPDATE contact c SET
      first_name = CASE WHEN v_writes ? 'first_name' THEN v_writes ->> 'first_name' ELSE c.first_name END,
      last_name  = CASE WHEN v_writes ? 'last_name'  THEN v_writes ->> 'last_name'  ELSE c.last_name END,
      title      = CASE WHEN v_writes ? 'title'      THEN v_writes ->> 'title'      ELSE c.title END
    WHERE c.id = v_id;
    v_applied := v_applied || v_writes;
    v_changed := true;
  END IF;

  -- Email: edit the entry this sync added, or add one. Not one a person
  -- removed: a value already applied and now absent was taken out on purpose.
  v_new := nullif(p_values ->> 'email', '');
  v_old := v_applied ->> 'email';
  IF v_new IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM contact_email e WHERE e.contact_id = v_id AND lower(e.address::text) = lower(v_new))
     AND v_new IS DISTINCT FROM v_old THEN
    UPDATE contact_email e SET address = v_new::citext
    WHERE e.contact_id = v_id AND v_old IS NOT NULL AND lower(e.address::text) = lower(v_old);
    IF NOT FOUND THEN
      INSERT INTO contact_email (tenant_id, contact_id, address, label, is_primary, position)
      VALUES (v_tenant, v_id, v_new::citext, 'work',
              NOT EXISTS (SELECT 1 FROM contact_email e WHERE e.contact_id = v_id AND e.is_primary),
              (SELECT coalesce(max(position) + 1, 0) FROM contact_email e WHERE e.contact_id = v_id));
    END IF;
    v_changed := true;
  END IF;
  IF v_new IS NOT NULL THEN v_applied := v_applied || jsonb_build_object('email', v_new); END IF;

  -- Desk phone and mobile, the same way, each under its own label.
  FOREACH v_key IN ARRAY ARRAY['phone', 'mobile'] LOOP
    v_new := nullif(p_values ->> v_key, '');
    v_old := v_applied ->> v_key;
    CONTINUE WHEN v_new IS NULL;
    IF NOT EXISTS (SELECT 1 FROM contact_phone p WHERE p.contact_id = v_id AND p.number = v_new)
       AND v_new IS DISTINCT FROM v_old THEN
      UPDATE contact_phone p SET number = v_new
      WHERE p.contact_id = v_id AND v_old IS NOT NULL AND p.number = v_old;
      IF NOT FOUND THEN
        INSERT INTO contact_phone (tenant_id, contact_id, number, label, is_primary, position)
        VALUES (v_tenant, v_id, v_new, CASE WHEN v_key = 'mobile' THEN 'mobile' ELSE 'work' END,
                v_key = 'phone' AND NOT EXISTS (SELECT 1 FROM contact_phone p WHERE p.contact_id = v_id AND p.is_primary),
                (SELECT coalesce(max(position) + 1, 0) FROM contact_phone p WHERE p.contact_id = v_id));
      END IF;
      v_changed := true;
    END IF;
    v_applied := v_applied || jsonb_build_object(v_key, v_new);
  END LOOP;

  UPDATE m365_contact_link SET payload_sha256 = p_payload_sha256, applied = v_applied, last_synced_at = now()
  WHERE connection_id = p_connection_id AND graph_user_id = p_graph_user_id;

  RETURN QUERY SELECT v_id, CASE WHEN v_changed THEN 'updated' ELSE 'unchanged' END;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.upsert_m365_licence — one subscription, as a licence of the client.
-- Seats are Microsoft's to report and are always kept current; the name is
-- set once and is a person's after that.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.upsert_m365_licence(
  p_connection_id   uuid,
  p_sku_id          text,
  p_name            text,
  p_seats_purchased integer,
  p_seats_used      integer
) RETURNS TABLE (node_id uuid, outcome text)
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_scope  record;
  v_node   uuid;
  v_rows   integer;
BEGIN
  SELECT * INTO v_scope FROM helm.graph_connection_scope(p_connection_id);

  SELECT ei.node_id INTO v_node FROM external_identity ei
  WHERE ei.connection_id = p_connection_id AND ei.external_type = 'm365_sku' AND ei.external_id = p_sku_id;

  IF v_node IS NULL THEN
    INSERT INTO asset_node (tenant_id, organization_id, node_type, name, status)
    VALUES (v_tenant, v_scope.organization_id, 'license', left(btrim(p_name), 200), 'active')
    RETURNING id INTO v_node;
    INSERT INTO license (id, tenant_id, node_type, license_type, seats_purchased, seats_used, auto_renew)
    VALUES (v_node, v_tenant, 'license', 'subscription', p_seats_purchased, p_seats_used, true);
    INSERT INTO external_identity (tenant_id, connection_id, node_id, external_id, external_type)
    VALUES (v_tenant, p_connection_id, v_node, p_sku_id, 'm365_sku');
    RETURN QUERY SELECT v_node, 'created'::text;
    RETURN;
  END IF;

  UPDATE license l SET seats_purchased = p_seats_purchased, seats_used = p_seats_used
  WHERE l.id = v_node
    AND (l.seats_purchased IS DISTINCT FROM p_seats_purchased OR l.seats_used IS DISTINCT FROM p_seats_used);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  UPDATE external_identity SET last_synced_at = now()
  WHERE connection_id = p_connection_id AND external_type = 'm365_sku' AND external_id = p_sku_id;

  RETURN QUERY SELECT v_node, CASE WHEN v_rows > 0 THEN 'updated' ELSE 'unchanged' END;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.upsert_m365_domain — one verified domain, as a domain entry.
--
-- Domain names are unique across the MSP, so a domain already documented for
-- this client is linked, and one documented for a DIFFERENT client is left
-- where it is and reported as a conflict for a person to look at.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.upsert_m365_domain(p_connection_id uuid, p_domain text)
  RETURNS TABLE (node_id uuid, outcome text)
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant   uuid := helm.require_tenant_id();
  v_scope    record;
  v_domain   text := lower(btrim(p_domain));
  v_node     uuid;
  v_existing uuid;
  v_org      uuid;
BEGIN
  SELECT * INTO v_scope FROM helm.graph_connection_scope(p_connection_id);

  SELECT ei.node_id INTO v_node FROM external_identity ei
  WHERE ei.connection_id = p_connection_id AND ei.external_type = 'm365_domain' AND ei.external_id = v_domain;
  IF v_node IS NOT NULL THEN
    UPDATE external_identity SET last_synced_at = now()
    WHERE connection_id = p_connection_id AND external_type = 'm365_domain' AND external_id = v_domain;
    RETURN QUERY SELECT v_node, 'unchanged'::text;
    RETURN;
  END IF;

  -- Looked for across the MSP with RLS's view, which for the sync worker is
  -- every client.
  SELECT d.id, n.organization_id INTO v_existing, v_org
  FROM domain d JOIN asset_node n ON n.id = d.id
  WHERE d.tenant_id = v_tenant AND d.domain_name = v_domain::citext;

  IF v_existing IS NOT NULL AND v_org IS DISTINCT FROM v_scope.organization_id THEN
    RETURN QUERY SELECT v_existing, 'conflict'::text;
    RETURN;
  END IF;

  IF v_existing IS NULL THEN
    INSERT INTO asset_node (tenant_id, organization_id, node_type, name, status)
    VALUES (v_tenant, v_scope.organization_id, 'domain', v_domain, 'active')
    RETURNING id INTO v_existing;
    INSERT INTO domain (id, tenant_id, node_type, domain_name)
    VALUES (v_existing, v_tenant, 'domain', v_domain::citext);
    INSERT INTO external_identity (tenant_id, connection_id, node_id, external_id, external_type)
    VALUES (v_tenant, p_connection_id, v_existing, v_domain, 'm365_domain');
    RETURN QUERY SELECT v_existing, 'created'::text;
    RETURN;
  END IF;

  INSERT INTO external_identity (tenant_id, connection_id, node_id, external_id, external_type)
  VALUES (v_tenant, p_connection_id, v_existing, v_domain, 'm365_domain');
  RETURN QUERY SELECT v_existing, 'linked'::text;
END;
$$;

-- -----------------------------------------------------------------------------
-- Grants.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION helm.set_m365_connection(uuid, text, text, text, uuid, boolean, integer, boolean, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.forget_m365_connection(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.request_m365_sync(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.graph_connection_scope(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.upsert_m365_user(uuid, text, bytea, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.upsert_m365_licence(uuid, text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.upsert_m365_domain(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.set_m365_connection(uuid, text, text, text, uuid, boolean, integer, boolean, boolean, boolean) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.forget_m365_connection(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.request_m365_sync(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.graph_connection_scope(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.upsert_m365_user(uuid, text, bytea, jsonb) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.upsert_m365_licence(uuid, text, text, integer, integer) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.upsert_m365_domain(uuid, text) TO helm_app;
