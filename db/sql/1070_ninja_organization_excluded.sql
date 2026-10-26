-- =============================================================================
-- 1070 — "Don't import" is a decision, not the absence of one
--
-- 0980 kept one fact per NinjaOne organisation: the client it imports to, or
-- NULL. NULL meant both "nobody has looked at this yet" and "somebody chose not
-- to import it", so a list of a hundred organisations could not say which ones
-- still need a decision, and "New client for each" would recreate a client
-- somebody had deliberately deleted.
--
-- excluded_at is set when a person chooses "Don't import", and also when the
-- client an organisation imported to is deleted: deleting a client is the
-- strongest way of saying its NinjaOne organisation should not come back.
-- Mapping it to a client clears it again. A trigger keeps that true however
-- organization_id changes, including the foreign key's ON DELETE SET NULL.
--
-- An organisation NinjaOne lists for the first time arrives with neither, so
-- "not decided yet" is organization_id IS NULL AND excluded_at IS NULL.
-- =============================================================================

SET search_path = public, extensions;

ALTER TABLE ninja_organization ADD COLUMN excluded_at timestamptz;

COMMENT ON COLUMN ninja_organization.excluded_at IS
  'When a person chose not to import this organisation, or deleted the client it '
  'imported to (1070). NULL with a NULL organization_id: nobody has decided yet.';

CREATE OR REPLACE FUNCTION helm.ninja_organization_track_exclusion() RETURNS trigger
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

CREATE TRIGGER ninja_organization_track_exclusion BEFORE UPDATE OF organization_id ON ninja_organization
  FOR EACH ROW EXECUTE FUNCTION helm.ninja_organization_track_exclusion();

-- -----------------------------------------------------------------------------
-- helm.map_ninja_organization — as 0980, except that choosing "Don't import"
-- for an organisation nobody had decided on is now a change worth recording.
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
  v_tenant   uuid := helm.require_tenant_id();
  v_before   uuid;
  v_excluded timestamptz;
  v_name     text;
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

  SELECT organization_id, excluded_at, name INTO v_before, v_excluded, v_name FROM ninja_organization
  WHERE tenant_id = v_tenant AND connection_id = p_connection_id AND ninja_org_id = p_ninja_org_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_before IS NOT DISTINCT FROM p_organization_id
     AND (p_organization_id IS NOT NULL OR v_excluded IS NOT NULL) THEN
    RETURN true;
  END IF;

  UPDATE ninja_organization SET
    organization_id = p_organization_id,
    excluded_at = CASE WHEN p_organization_id IS NULL THEN coalesce(excluded_at, now()) END
  WHERE tenant_id = v_tenant AND connection_id = p_connection_id AND ninja_org_id = p_ninja_org_id;

  PERFORM helm.audit(
    'integration.rmm_organization_mapped', 'integration_connection', p_connection_id, 'success',
    p_organization_id, NULL, NULL,
    jsonb_build_object('ninja_org_id', p_ninja_org_id, 'ninja_org_name', v_name,
                       'from', v_before, 'to', p_organization_id));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION helm.map_ninja_organization(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.map_ninja_organization(uuid, text, uuid) TO helm_app;
