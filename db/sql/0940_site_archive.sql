-- =============================================================================
-- 0940 — a location can be archived and restored
--
-- A location had one way out: Remove, which set deleted_at and could not be
-- undone from the interface. That is the wrong tool for an office that closed
-- for a refit, or a site somebody removed by mistake. Locations now work as
-- contacts do (0850): ARCHIVE takes one off the list, out of search and out of
-- every picker, and RESTORE puts it back exactly as it was. Deleting — the old
-- deleted_at — is offered only from the archive, after archiving.
--
-- Nothing recorded at an archived location changes: assets and contacts keep
-- their site_id, and their pages still name it.
-- =============================================================================

SET search_path = public, extensions;

ALTER TABLE site ADD COLUMN archived_at timestamptz;
COMMENT ON COLUMN site.archived_at IS
  'Archived: off the list, out of search and pickers, restorable (0940). deleted_at is removal.';

-- Search drops an archived location, as it drops a deleted one, and picks it
-- back up on restore. 0380's indexer, with archived_at beside deleted_at.
CREATE OR REPLACE FUNCTION helm.index_site() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_document WHERE entity_type = 'site' AND entity_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.deleted_at IS NOT NULL OR NEW.archived_at IS NOT NULL THEN
    DELETE FROM search_document WHERE entity_type = 'site' AND entity_id = NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO search_document (
    entity_type, entity_id, tenant_id, organization_id, site_id, kind,
    title, subtitle, body, identifiers, is_internal_only, client_visible, updated_at
  )
  VALUES (
    'site', NEW.id, NEW.tenant_id, NEW.organization_id, NEW.id, 'site',
    NEW.name,
    concat_ws(', ', NEW.address_line1, NEW.city, NEW.region),
    concat_ws(E'\n',
      concat_ws(', ', NEW.address_line1, NEW.address_line2, NEW.city,
                      NEW.region, NEW.postal_code, NEW.country),
      NEW.notes, NEW.access_notes),
    helm.normalise_terms(ARRAY[NEW.code, NEW.postal_code, NEW.main_phone]),
    -- access_notes are not a co-managed client's business (0380).
    true, false, now()
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      title           = EXCLUDED.title,
      subtitle        = EXCLUDED.subtitle,
      body            = EXCLUDED.body,
      identifiers     = EXCLUDED.identifiers,
      updated_at      = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER site_search ON site;
CREATE TRIGGER site_search
  AFTER INSERT OR UPDATE OF name, code, address_line1, address_line2, city, region,
                            postal_code, country, main_phone, notes, access_notes,
                            deleted_at, archived_at, organization_id
  OR DELETE ON site
  FOR EACH ROW EXECUTE FUNCTION helm.index_site();
