-- =============================================================================
-- 1020 — contacts at a location, and copying an entry
--
-- CONTACTS AT A LOCATION. contact.site_id has been in the schema since 0010
-- and the contact routes accept it, but nothing on screen set it. The form now
-- does, and this makes the one rule the composite foreign key cannot: the
-- location must belong to the SAME client as the contact. The FK carries
-- tenant_id, so it stops another MSP's site; it does not stop Acme's
-- receptionist being filed at Globex's head office.
--
-- COPYING AN ENTRY. helm.copy_asset() makes a new entry from an existing one:
-- the shared fields (client, location, description, notes, status, tags,
-- criticality, internal-only) and the kind's own row, under a new name.
--
--   NO SECRET IS COPIED. A password, a TOTP seed or a certificate's private
--   key is a secret with its own audit chain; pointing two entries at one
--   would mean rotating "the copy" rotates the original, and silently
--   duplicating the plaintext would be a reveal nobody asked for. Columns
--   named secret_id or *_secret_id, and the seed's totp_* parameters, are left
--   behind; the copy's page offers "Set password".
--
--   WHAT WAS OBSERVED IS NOT COPIED. The external check's machinery
--   (next_check_at, last_check_*, registry_*, observed_*) describes the
--   original domain or certificate as somebody else's server saw it.
--
--   A DOMAIN TAKES ITS NEW NAME AS ITS DOMAIN NAME, because domain names are
--   unique per tenant and a domain is called by its name (see the create form).
--
--   NOT PROCEDURES OR CUSTOM RECORDS. A procedure is versions and steps, and a
--   custom record keeps secret pointers inside its data; copying either
--   properly is its own feature, so both are refused rather than half-copied.
--
-- SECURITY INVOKER: it runs as the caller, so RLS decides which entries can be
-- read and where a new one may be written, exactly as for a typed insert.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- A contact's location is one of its own client's.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.guard_contact_site() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM site s
    WHERE s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id
      AND s.organization_id = NEW.organization_id AND s.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'helm: that location belongs to a different client'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contact_site_guard
  BEFORE INSERT OR UPDATE OF site_id, organization_id ON contact
  FOR EACH ROW EXECUTE FUNCTION helm.guard_contact_site();

-- -----------------------------------------------------------------------------
-- Copying an entry.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.copy_asset(p_node_id uuid, p_name text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_src   asset_node;
  v_new   uuid;
  v_table text;
  v_cols  text;
  -- A domain's name column is written from the new name, not copied: domain
  -- names are unique per tenant, so copying it first would collide.
  v_named text;
  v_actor uuid := helm.current_actor_id();
BEGIN
  IF coalesce(btrim(p_name), '') = '' THEN
    RAISE EXCEPTION 'helm: a copy needs a name' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_src FROM asset_node WHERE id = p_node_id AND archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: no such entry' USING ERRCODE = 'check_violation';
  END IF;
  IF v_src.node_type IN ('sop', 'flexible_asset') THEN
    RAISE EXCEPTION 'helm: procedures and custom records cannot be copied yet'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO asset_node (
    tenant_id, organization_id, site_id, node_type, name, description, notes,
    status, tags, is_internal_only, criticality, created_by, updated_by
  )
  VALUES (
    v_src.tenant_id, v_src.organization_id, v_src.site_id, v_src.node_type,
    left(btrim(p_name), 200), v_src.description, v_src.notes,
    v_src.status, v_src.tags, v_src.is_internal_only, v_src.criticality, v_actor, v_actor
  )
  RETURNING id INTO v_new;

  -- The kind's own row: every column but the keys, the secrets, and what an
  -- external check observed. Read from the catalogue so a column added later
  -- is copied without anybody remembering to list it here.
  v_table := v_src.node_type::text;
  v_named := CASE WHEN v_src.node_type = 'domain' THEN 'domain_name' END;
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_cols
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = v_table
    AND c.is_generated = 'NEVER'
    AND c.column_name NOT IN ('id', 'tenant_id', 'node_type', 'secret_id', 'next_check_at')
    AND c.column_name NOT LIKE '%\_secret\_id'
    AND c.column_name NOT LIKE 'totp\_%'
    AND c.column_name NOT LIKE 'last\_check%'
    AND c.column_name NOT LIKE 'registry\_%'
    AND c.column_name NOT LIKE 'observed\_%'
    AND c.column_name IS DISTINCT FROM v_named;

  IF v_named IS NULL THEN
    EXECUTE format(
      'INSERT INTO %1$I (id, tenant_id, node_type%2$s) SELECT $1, tenant_id, node_type%2$s FROM %1$I WHERE id = $2',
      v_table, coalesce(', ' || v_cols, '')
    ) USING v_new, p_node_id;
  ELSE
    EXECUTE format(
      'INSERT INTO %1$I (id, tenant_id, node_type, %3$I%2$s) SELECT $1, tenant_id, node_type, $3%2$s FROM %1$I WHERE id = $2',
      v_table, coalesce(', ' || v_cols, ''), v_named
    ) USING v_new, p_node_id, lower(btrim(p_name));
  END IF;

  RETURN v_new;
END;
$$;

COMMENT ON FUNCTION helm.copy_asset(uuid, text) IS
  'A new entry from an existing one, under a new name: shared fields and the kind''s row, '
  'never its secrets or what an external check observed. Not procedures or custom records. See 1020.';

REVOKE ALL ON FUNCTION helm.copy_asset(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.copy_asset(uuid, text) TO helm_app;
