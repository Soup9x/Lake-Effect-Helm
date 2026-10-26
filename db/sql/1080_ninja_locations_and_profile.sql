-- =============================================================================
-- 1080 — NinjaOne locations as sites, and what NinjaOne says about a device
--
-- LOCATIONS. Every NinjaOne organisation has locations, each with a name and a
-- free-text address. A location of an organisation that imports to a client
-- becomes one of that client's sites, and each device is put at the site of
-- its location. ninja_location remembers which site each location became.
--
--   An existing site of the same client with the same name is adopted rather
--   than doubled, as a hand-documented device is.
--
--   The site's name and address are NinjaOne's until somebody edits them, by
--   the same rule as a device's fields: ninja_location.applied holds what the
--   sync last wrote, and a field holding anything else is left alone. Phones,
--   access notes, security and the rest of a site are never touched.
--
--   A site somebody archived or deleted is not brought back, and devices are
--   not put at it. Deleting one sets site_id NULL with applied still holding
--   what was written, which is how "removed by a person" is told from "never
--   created".
--
--   A device's site is NinjaOne's while it is empty or still the one the sync
--   put there (external_identity.applied -> 'site_id'). Moved by hand, it stays.
--
-- PROFILE. external_identity.profile holds what an integration reports about a
-- record beyond the record's own columns: for NinjaOne, disks and free space,
-- the last user, the last boot, antivirus, pending patches and warranty. It is
-- shown read-only and rewritten on every run, and no person edits it.
-- =============================================================================

SET search_path = public, extensions;

ALTER TABLE external_identity
  ADD COLUMN profile jsonb,
  ADD CONSTRAINT external_identity_profile_object CHECK (profile IS NULL OR jsonb_typeof(profile) = 'object');

COMMENT ON COLUMN external_identity.profile IS
  'What the integration reports beyond the record''s own columns, shown read-only (1080).';

-- -----------------------------------------------------------------------------
-- ninja_location — NinjaOne's locations, and the site each became.
-- -----------------------------------------------------------------------------
CREATE TABLE ninja_location (
  tenant_id          uuid NOT NULL,
  connection_id      uuid NOT NULL,
  ninja_location_id  text NOT NULL,
  ninja_org_id       text,
  name               text NOT NULL,
  -- NULL: not created yet, or (with applied non-empty) removed by a person.
  site_id            uuid,
  applied            jsonb NOT NULL DEFAULT '{}'::jsonb,
  seen_at            timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (connection_id, ninja_location_id),
  CONSTRAINT ninja_location_connection_fk FOREIGN KEY (connection_id, tenant_id)
    REFERENCES integration_connection (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT ninja_location_site_fk FOREIGN KEY (site_id, tenant_id)
    REFERENCES site (id, tenant_id) ON DELETE SET NULL (site_id),
  CONSTRAINT ninja_location_applied_object CHECK (jsonb_typeof(applied) = 'object')
);

CREATE INDEX ninja_location_site_idx ON ninja_location (site_id) WHERE site_id IS NOT NULL;

SELECT helm.apply_tenant_rls('ninja_location', false, 80, NULL);

CREATE TRIGGER ninja_location_touch BEFORE UPDATE ON ninja_location
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- -----------------------------------------------------------------------------
-- helm.upsert_ninja_location — one location, as the sync worker, under RLS.
-- Returns the site its devices go to, or NULL for none.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.upsert_ninja_location(
  p_connection_id   uuid,
  p_organization_id uuid,
  p_location_id     text,
  p_ninja_org_id    text,
  p_name            text,
  p_address         text
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_respect boolean;
  v_row     ninja_location%ROWTYPE;
  v_site    site%ROWTYPE;
  v_applied jsonb := '{}'::jsonb;
  v_name    text := left(btrim(p_name), 200);
  v_address text := nullif(left(btrim(coalesce(p_address, '')), 500), '');
BEGIN
  SELECT respect_manual_edits INTO v_respect FROM integration_connection
  WHERE id = p_connection_id AND tenant_id = v_tenant AND provider = 'ninja_one';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: no such NinjaOne connection' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT * INTO v_row FROM ninja_location
  WHERE connection_id = p_connection_id AND ninja_location_id = p_location_id
  FOR UPDATE;

  IF FOUND THEN
    UPDATE ninja_location SET name = v_name, ninja_org_id = p_ninja_org_id, seen_at = now()
    WHERE connection_id = p_connection_id AND ninja_location_id = p_location_id;

    -- Deleted by a person: stays deleted.
    IF v_row.site_id IS NULL AND v_row.applied <> '{}'::jsonb THEN RETURN NULL; END IF;

    IF v_row.site_id IS NOT NULL THEN
      SELECT * INTO v_site FROM site WHERE id = v_row.site_id;
      -- Archived or deleted by a person: left that way.
      IF v_site.deleted_at IS NOT NULL OR v_site.archived_at IS NOT NULL THEN RETURN NULL; END IF;
      IF v_site.organization_id = p_organization_id THEN
        v_applied := v_row.applied;
      ELSE
        -- The NinjaOne organisation now imports to another client: that
        -- client gets a site of its own, and the old one stays the old
        -- client's documentation.
        v_site := NULL;
      END IF;
    END IF;
  END IF;

  IF v_site.id IS NULL THEN
    SELECT s.* INTO v_site FROM site s
    WHERE s.tenant_id = v_tenant AND s.organization_id = p_organization_id
      AND s.deleted_at IS NULL AND s.archived_at IS NULL
      AND lower(btrim(s.name)) = lower(v_name)
      AND NOT EXISTS (
        SELECT 1 FROM ninja_location l
        WHERE l.connection_id = p_connection_id AND l.site_id = s.id
          AND l.ninja_location_id <> p_location_id)
    ORDER BY s.created_at LIMIT 1;

    IF v_site.id IS NULL THEN
      INSERT INTO site (tenant_id, organization_id, name, address_line1)
      VALUES (v_tenant, p_organization_id, v_name, v_address)
      RETURNING * INTO v_site;
      v_applied := jsonb_build_object('name', v_name, 'address_line1', v_address);
    END IF;
  END IF;

  -- NinjaOne's while empty or as the sync left it.
  IF v_site.name IS DISTINCT FROM v_name
     AND (NOT v_respect OR v_site.name = v_applied ->> 'name') THEN
    UPDATE site SET name = v_name WHERE id = v_site.id;
    v_applied := v_applied || jsonb_build_object('name', v_name);
  END IF;
  IF v_address IS NOT NULL AND v_site.address_line1 IS DISTINCT FROM v_address
     AND (NOT v_respect OR v_site.address_line1 IS NULL
          OR v_site.address_line1 = v_applied ->> 'address_line1') THEN
    UPDATE site SET address_line1 = v_address WHERE id = v_site.id;
    v_applied := v_applied || jsonb_build_object('address_line1', v_address);
  END IF;

  INSERT INTO ninja_location (tenant_id, connection_id, ninja_location_id, ninja_org_id, name, site_id, applied)
  VALUES (v_tenant, p_connection_id, p_location_id, p_ninja_org_id, v_name, v_site.id, v_applied)
  ON CONFLICT (connection_id, ninja_location_id) DO UPDATE SET
    site_id = EXCLUDED.site_id, applied = EXCLUDED.applied, seen_at = now();

  RETURN v_site.id;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.annotate_ninja_device — after helm.upsert_ninja_device, in the same
-- transaction: the device's site, and the profile NinjaOne reports for it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.annotate_ninja_device(
  p_connection_id uuid,
  p_external_id   text,
  p_site_id       uuid,
  p_profile       jsonb
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_identity external_identity%ROWTYPE;
  v_node     asset_node%ROWTYPE;
  v_moved    boolean := false;
BEGIN
  SELECT * INTO v_identity FROM external_identity
  WHERE connection_id = p_connection_id AND external_type = 'ninja_device' AND external_id = p_external_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_site_id IS NOT NULL THEN
    SELECT * INTO v_node FROM asset_node WHERE id = v_identity.node_id;
    IF v_node.site_id IS DISTINCT FROM p_site_id
       AND (v_node.site_id IS NULL OR v_node.site_id::text = v_identity.applied ->> 'site_id')
       AND EXISTS (SELECT 1 FROM site s WHERE s.id = p_site_id AND s.organization_id = v_node.organization_id) THEN
      UPDATE asset_node SET site_id = p_site_id WHERE id = v_node.id;
      v_identity.applied := v_identity.applied || jsonb_build_object('site_id', p_site_id::text);
      v_moved := true;
    END IF;
  END IF;

  IF v_moved OR v_identity.profile IS DISTINCT FROM p_profile THEN
    UPDATE external_identity SET applied = v_identity.applied, profile = p_profile
    WHERE id = v_identity.id;
  END IF;
  RETURN v_moved;
END;
$$;

REVOKE ALL ON FUNCTION helm.upsert_ninja_location(uuid, uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.annotate_ninja_device(uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.upsert_ninja_location(uuid, uuid, text, text, text, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.annotate_ninja_device(uuid, text, uuid, jsonb) TO helm_app;
