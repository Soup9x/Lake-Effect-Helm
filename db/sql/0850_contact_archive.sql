-- =============================================================================
-- 0850 — contacts can be archived
--
-- A contact had one way off the list: deleted_at, which nothing in the
-- interface can reverse. People leave a client and come back, and the record
-- of who they were — their numbers, whether they could authorise a change — is
-- worth keeping without them being the first name a technician sees. So a
-- contact gets the archive every asset and document already has:
--
--   archived_at set    off the list, out of search and out of the pickers;
--                      the row is whole and "Include archived" shows it, with
--                      Restore beside it.
--   deleted_at set     gone, as before — offered from the archive only.
--
-- Search follows the asset rule from 0490: an archived record is not a search
-- result. helm.index_contact() is 0790's body with that one condition added.
-- =============================================================================
ALTER TABLE contact ADD COLUMN archived_at timestamptz;

COMMENT ON COLUMN contact.archived_at IS
  'Archived: off the list, out of search and pickers, restorable. deleted_at is removal.';

CREATE OR REPLACE FUNCTION helm.index_contact() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.deleted_at IS NOT NULL OR NEW.archived_at IS NOT NULL THEN
    DELETE FROM search_document
    WHERE entity_type = 'contact' AND entity_id = coalesce(NEW.id, OLD.id);
    RETURN coalesce(NEW, OLD);
  END IF;

  INSERT INTO search_document (
    entity_type, entity_id, tenant_id, organization_id, site_id, kind,
    title, subtitle, body, identifiers, client_visible, updated_at
  )
  VALUES (
    'contact', NEW.id, NEW.tenant_id, NEW.organization_id, NEW.site_id, 'contact',
    NEW.first_name || ' ' || NEW.last_name, NEW.title, NEW.notes,
    helm.normalise_terms(
      ARRAY[NEW.email::text, NEW.phone, NEW.mobile]
      || coalesce((SELECT array_agg(e.address::text) FROM contact_email e WHERE e.contact_id = NEW.id), '{}')
      || coalesce((SELECT array_agg(p.number) FROM contact_phone p WHERE p.contact_id = NEW.id), '{}')
    ),
    true, now()
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      site_id         = EXCLUDED.site_id,
      kind            = EXCLUDED.kind,
      title           = EXCLUDED.title,
      subtitle        = EXCLUDED.subtitle,
      body            = EXCLUDED.body,
      identifiers     = EXCLUDED.identifiers,
      updated_at      = now();
  RETURN NEW;
END;
$$;
