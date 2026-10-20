-- =============================================================================
-- 0970 — what changed on an entry, by whom, and when
--
-- The audit log answers "who revealed this password". It did not answer "who
-- changed this firewall's IP last Tuesday, and what was it before" — an edit
-- left no trace beyond updated_at. entity_change is that trace: one row per
-- save, holding only the fields that changed, each as [before, after].
--
-- CAPTURED BY TRIGGER, on the entry tables themselves, so every path that
-- writes — the forms, the API, an import, a sync — is recorded the same way and
-- none can forget to. The trigger is SECURITY DEFINER so that recording never
-- fails a write: a sync worker or a technician whose role could not otherwise
-- INSERT here still gets their change written down. Nothing else can write it;
-- helm_app has SELECT only.
--
-- WHAT IS NOT RECORDED. Bookkeeping (updated_at and friends), what a probe or
-- a sync observes rather than what a person set (last_checked_at, observed_*,
-- last_seen_at), and anything that points at a secret (*_secret_id). Secret
-- VALUES never live in these tables to begin with; a rotation is in the audit
-- log as secret.rotated. Long text is cut to 500 characters.
--
-- WHO MAY READ IT is whoever may read the entry: the row carries the entry's
-- client and internal-only flag, and RLS applies to it as it does to the entry.
-- =============================================================================

SET search_path = public, extensions;

CREATE TABLE entity_change (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,
  -- 'asset', 'contact' or 'site'. An asset's detail table records under its
  -- node, so a configuration's history is one list.
  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  is_internal_only boolean NOT NULL DEFAULT false,
  -- 'created', 'updated', 'archived', 'restored'.
  kind             text NOT NULL,
  -- { "column": [before, after], … }
  changes          jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id         uuid,
  actor_type       text,
  changed_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT entity_change_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT entity_change_type_ck CHECK (entity_type IN ('asset', 'contact', 'site')),
  CONSTRAINT entity_change_kind_ck CHECK (kind IN ('created', 'updated', 'archived', 'restored')),
  CONSTRAINT entity_change_changes_ck CHECK (jsonb_typeof(changes) = 'object')
);
CREATE INDEX entity_change_entity_idx ON entity_change (entity_id, changed_at DESC);
CREATE INDEX entity_change_org_idx ON entity_change (tenant_id, organization_id, changed_at DESC);

COMMENT ON TABLE entity_change IS
  'One row per save of an asset, contact or location (0970): the fields that '
  'changed as [before, after]. Written by trigger only.';

SELECT helm.apply_tenant_rls('entity_change', true, 40, 'is_internal_only');
REVOKE ALL ON entity_change FROM PUBLIC, helm_app, helm_auth, helm_worker;
GRANT SELECT ON entity_change TO helm_app;
GRANT SELECT ON entity_change TO helm_auditor;

-- -----------------------------------------------------------------------------
-- The diff. Columns compared as jsonb; an object value (a flexible record's
-- data) is compared one level down, so one changed field reads as one field.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.change_value(p jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN jsonb_typeof(p) = 'string' AND length(p #>> '{}') > 500
              THEN to_jsonb(left(p #>> '{}', 500) || '…')
              ELSE p END;
$$;

CREATE OR REPLACE FUNCTION helm.row_changes(p_old jsonb, p_new jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_out  jsonb := '{}'::jsonb;
  v_key  text;
  v_sub  text;
  v_old  jsonb;
  v_new  jsonb;
BEGIN
  FOR v_key IN SELECT jsonb_object_keys(coalesce(p_new, '{}'::jsonb) || coalesce(p_old, '{}'::jsonb)) LOOP
    CONTINUE WHEN v_key IN (
      'id', 'tenant_id', 'node_type', 'created_at', 'created_by', 'updated_at', 'updated_by',
      'deleted_at', 'archived_at', 'last_checked_at', 'next_check_at', 'last_check_status',
      'last_check_error', 'observed_not_after', 'observed_fingerprint_sha256', 'last_seen_at',
      'validated_at', 'needs_migration', 'type_version_id', 'version', 'latitude', 'longitude')
      OR v_key LIKE '%secret_id'
      OR v_key LIKE '%tsv' OR v_key LIKE 'search_%';

    v_old := p_old -> v_key;
    v_new := p_new -> v_key;
    CONTINUE WHEN v_old IS NOT DISTINCT FROM v_new;

    IF jsonb_typeof(v_old) = 'object' OR jsonb_typeof(v_new) = 'object' THEN
      FOR v_sub IN SELECT jsonb_object_keys(coalesce(v_new, '{}'::jsonb) || coalesce(v_old, '{}'::jsonb)) LOOP
        CONTINUE WHEN (v_old -> v_sub) IS NOT DISTINCT FROM (v_new -> v_sub);
        v_out := v_out || jsonb_build_object(v_key || '.' || v_sub,
          jsonb_build_array(helm.change_value(v_old -> v_sub), helm.change_value(v_new -> v_sub)));
      END LOOP;
    ELSE
      v_out := v_out || jsonb_build_object(v_key,
        jsonb_build_array(helm.change_value(v_old), helm.change_value(v_new)));
    END IF;
  END LOOP;
  RETURN v_out;
END;
$$;

-- -----------------------------------------------------------------------------
-- The recorder. TG_ARGV[0] is the entity type; for an asset's detail table the
-- client and internal flag are the node's.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_entity_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_type     text := TG_ARGV[0];
  v_old      jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  v_new      jsonb := to_jsonb(NEW);
  v_changes  jsonb;
  v_kind     text;
  v_org      uuid;
  v_internal boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A detail row is inserted alongside its node, which already said
    -- 'created'; only the node, a contact and a site record their creation.
    IF TG_TABLE_NAME NOT IN ('asset_node', 'contact', 'site') THEN
      RETURN NULL;
    END IF;
    v_kind := 'created';
    v_changes := '{}'::jsonb;
  ELSE
    v_changes := helm.row_changes(v_old, v_new);
    v_kind := CASE
      WHEN (v_old ->> 'archived_at') IS NULL AND (v_new ->> 'archived_at') IS NOT NULL THEN 'archived'
      WHEN (v_old ->> 'archived_at') IS NOT NULL AND (v_new ->> 'archived_at') IS NULL THEN 'restored'
      ELSE 'updated' END;
    IF v_kind = 'updated' AND v_changes = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_TABLE_NAME IN ('contact', 'site') THEN
    v_org := NEW.organization_id;
  ELSIF TG_TABLE_NAME = 'asset_node' THEN
    v_org := NEW.organization_id;
    v_internal := NEW.is_internal_only;
  ELSE
    SELECT n.organization_id, n.is_internal_only INTO v_org, v_internal
    FROM asset_node n WHERE n.id = NEW.id;
    IF v_org IS NULL THEN RETURN NULL; END IF;
  END IF;

  INSERT INTO entity_change (
    tenant_id, organization_id, entity_type, entity_id, is_internal_only,
    kind, changes, actor_id, actor_type)
  VALUES (
    NEW.tenant_id, v_org, v_type, NEW.id, coalesce(v_internal, false),
    v_kind, v_changes, helm.current_actor_id(), helm.current_actor_type());
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION helm.record_entity_change() FROM PUBLIC;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'asset_node', 'device', 'network', 'domain', 'ssl_certificate', 'application',
    'directory_service', 'contract', 'license', 'isp_circuit', 'credential', 'vendor',
    'flexible_asset_record', 'sop'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION helm.record_entity_change(%L)',
      v_table || '_history', v_table, 'asset');
  END LOOP;
END
$$;

CREATE TRIGGER contact_history AFTER INSERT OR UPDATE ON contact
  FOR EACH ROW EXECUTE FUNCTION helm.record_entity_change('contact');
CREATE TRIGGER site_history AFTER INSERT OR UPDATE ON site
  FOR EACH ROW EXECUTE FUNCTION helm.record_entity_change('site');

-- An entry's history follows it when it is made internal-only, so a client
-- user cannot read the history of what they can no longer see.
CREATE OR REPLACE FUNCTION helm.entity_change_follow_visibility() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE entity_change SET is_internal_only = NEW.is_internal_only
  WHERE entity_id = NEW.id AND entity_type = 'asset';
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION helm.entity_change_follow_visibility() FROM PUBLIC;

CREATE TRIGGER asset_node_history_visibility
  AFTER UPDATE OF is_internal_only ON asset_node
  FOR EACH ROW WHEN (OLD.is_internal_only IS DISTINCT FROM NEW.is_internal_only)
  EXECUTE FUNCTION helm.entity_change_follow_visibility();

DO $$
BEGIN
  IF has_table_privilege('helm_app', 'entity_change', 'INSERT')
     OR has_table_privilege('helm_app', 'entity_change', 'UPDATE')
     OR has_table_privilege('helm_app', 'entity_change', 'DELETE') THEN
    RAISE EXCEPTION '0970: helm_app can write change history directly';
  END IF;
END
$$;
