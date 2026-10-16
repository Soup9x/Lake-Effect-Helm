-- =============================================================================
-- 0790  A contact has as many emails and phone numbers as they have
-- =============================================================================
--
-- 0010 gave a contact one email, one phone and one mobile. People have a work
-- address and a personal one, a desk line with an extension, a mobile and a
-- fax that still matters to the accounts department. Two child tables hold
-- the lot, each entry labelled and one per kind marked primary.
--
-- THE OLD COLUMNS STAY, AND STAY TRUE. contact.email, phone and mobile are
-- read by the client page, the contacts list, the "who to call" widget, the
-- exports and the search index, and nothing that reads them has to learn the
-- new tables: a trigger on each child table rewrites the three columns from
-- the primary entries, so they are now a projection rather than a source.
-- Writing them directly still works — the import route does — because a
-- contact inserted with the columns and no entries seeds its entries from
-- them. Existing rows are backfilled the same way below.
--
-- SCOPED LIKE THE CONTACT. Neither child has a reason to carry an
-- organization_id except that RLS scopes by it, so a trigger copies the
-- contact's and apply_tenant_rls() does the rest. A client-side actor sees the
-- numbers of their own client's people and nobody else's, exactly as they see
-- the contacts.
-- =============================================================================

CREATE TABLE contact_email (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,
  contact_id       uuid NOT NULL,
  address          citext NOT NULL,
  label            text NOT NULL DEFAULT 'work',
  is_primary       boolean NOT NULL DEFAULT false,
  position         smallint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contact_email_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT contact_email_contact_fk FOREIGN KEY (contact_id, tenant_id)
    REFERENCES contact (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT contact_email_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT contact_email_label_ck CHECK (label IN ('work', 'personal', 'other')),
  CONSTRAINT contact_email_address_ck CHECK (length(address) BETWEEN 1 AND 320),
  CONSTRAINT contact_email_one_each UNIQUE (contact_id, address)
);
CREATE INDEX contact_email_contact_idx ON contact_email (tenant_id, contact_id);
CREATE INDEX contact_email_address_idx ON contact_email (tenant_id, address);
CREATE UNIQUE INDEX contact_email_one_primary ON contact_email (contact_id) WHERE is_primary;

CREATE TABLE contact_phone (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,
  contact_id       uuid NOT NULL,
  number           text NOT NULL,
  extension        text,
  label            text NOT NULL DEFAULT 'work',
  is_primary       boolean NOT NULL DEFAULT false,
  position         smallint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contact_phone_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT contact_phone_contact_fk FOREIGN KEY (contact_id, tenant_id)
    REFERENCES contact (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT contact_phone_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT contact_phone_label_ck CHECK (label IN ('work', 'mobile', 'home', 'fax', 'other')),
  CONSTRAINT contact_phone_number_ck CHECK (length(number) BETWEEN 1 AND 40),
  CONSTRAINT contact_phone_extension_ck CHECK (extension IS NULL OR length(extension) BETWEEN 1 AND 16)
);
CREATE INDEX contact_phone_contact_idx ON contact_phone (tenant_id, contact_id);
CREATE UNIQUE INDEX contact_phone_one_primary ON contact_phone (contact_id) WHERE is_primary;

COMMENT ON TABLE contact_email IS
  'A contact''s email addresses, labelled, one marked primary. contact.email is '
  'projected from the primary by helm.sync_contact_channels().';
COMMENT ON TABLE contact_phone IS
  'A contact''s phone numbers, labelled, one marked primary. contact.phone is the '
  'primary and contact.mobile the first mobile, by helm.sync_contact_channels().';

-- -----------------------------------------------------------------------------
-- The organisation comes from the contact; nobody passes it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.contact_channel_bind_organization() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  SELECT c.organization_id INTO NEW.organization_id
  FROM contact c WHERE c.id = NEW.contact_id AND c.tenant_id = NEW.tenant_id;
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'helm: no such contact' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contact_email_bind_organization
  BEFORE INSERT OR UPDATE OF contact_id ON contact_email
  FOR EACH ROW EXECUTE FUNCTION helm.contact_channel_bind_organization();
CREATE TRIGGER contact_phone_bind_organization
  BEFORE INSERT OR UPDATE OF contact_id ON contact_phone
  FOR EACH ROW EXECUTE FUNCTION helm.contact_channel_bind_organization();

-- -----------------------------------------------------------------------------
-- The three old columns, kept as a projection of the entries.
--
-- email  = the primary address, else the first.
-- phone  = the primary number (any label), else the first, with its extension.
-- mobile = the first number labelled mobile.
--
-- The UPDATE fires contact_touch and helm.index_contact(), so updated_at and
-- the search index follow every change to an entry without a second trigger.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.sync_contact_channels() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_contact uuid := coalesce(NEW.contact_id, OLD.contact_id);
BEGIN
  UPDATE contact c SET
    email = (SELECT e.address FROM contact_email e WHERE e.contact_id = c.id
             ORDER BY e.is_primary DESC, e.position, e.created_at LIMIT 1),
    phone = (SELECT p.number || CASE WHEN p.extension IS NULL THEN '' ELSE ' x' || p.extension END
             FROM contact_phone p WHERE p.contact_id = c.id
             ORDER BY p.is_primary DESC, p.position, p.created_at LIMIT 1),
    mobile = (SELECT p.number FROM contact_phone p WHERE p.contact_id = c.id AND p.label = 'mobile'
              ORDER BY p.is_primary DESC, p.position, p.created_at LIMIT 1)
  WHERE c.id = v_contact;
  RETURN NULL;
END;
$$;

CREATE TRIGGER contact_email_sync AFTER INSERT OR UPDATE OR DELETE ON contact_email
  FOR EACH ROW EXECUTE FUNCTION helm.sync_contact_channels();
CREATE TRIGGER contact_phone_sync AFTER INSERT OR UPDATE OR DELETE ON contact_phone
  FOR EACH ROW EXECUTE FUNCTION helm.sync_contact_channels();

-- -----------------------------------------------------------------------------
-- A contact written the old way — the import route, a script, a psql session
-- — seeds its entries from the columns, so the two shapes cannot disagree.
-- Only on INSERT: an UPDATE of the columns is the sync trigger's own doing.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.seed_contact_channels() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.email IS NOT NULL THEN
    INSERT INTO contact_email (tenant_id, contact_id, address, label, is_primary)
    VALUES (NEW.tenant_id, NEW.id, NEW.email, 'work', true)
    ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.phone IS NOT NULL THEN
    INSERT INTO contact_phone (tenant_id, contact_id, number, extension, label, is_primary, position)
    VALUES (NEW.tenant_id, NEW.id, NEW.phone, NEW.extension, 'work', true, 0);
  END IF;
  IF NEW.mobile IS NOT NULL AND NEW.mobile IS DISTINCT FROM NEW.phone THEN
    INSERT INTO contact_phone (tenant_id, contact_id, number, label, is_primary, position)
    VALUES (NEW.tenant_id, NEW.id, NEW.mobile, 'mobile', NEW.phone IS NULL, 1);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER contact_seed_channels AFTER INSERT ON contact
  FOR EACH ROW EXECUTE FUNCTION helm.seed_contact_channels();

-- Existing rows, the same way.
INSERT INTO contact_email (tenant_id, contact_id, address, label, is_primary)
SELECT c.tenant_id, c.id, c.email, 'work', true FROM contact c WHERE c.email IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO contact_phone (tenant_id, contact_id, number, extension, label, is_primary, position)
SELECT c.tenant_id, c.id, c.phone, c.extension, 'work', true, 0 FROM contact c WHERE c.phone IS NOT NULL;
INSERT INTO contact_phone (tenant_id, contact_id, number, label, is_primary, position)
SELECT c.tenant_id, c.id, c.mobile, 'mobile', c.phone IS NULL, 1 FROM contact c
WHERE c.mobile IS NOT NULL AND c.mobile IS DISTINCT FROM c.phone;

-- -----------------------------------------------------------------------------
-- Search: every address and number, not just the first of each.
-- 0380's body, with the entries unioned into the identifiers.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.index_contact() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.deleted_at IS NOT NULL THEN
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

-- -----------------------------------------------------------------------------
-- RLS and grants: as the contact.
-- -----------------------------------------------------------------------------
SELECT helm.apply_tenant_rls('contact_email', true, 40, NULL);
SELECT helm.apply_tenant_rls('contact_phone', true, 40, NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_email, contact_phone TO helm_app;
GRANT SELECT ON contact_email, contact_phone TO helm_auditor;

-- -----------------------------------------------------------------------------
-- Guard.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'contact_email')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'contact_phone') THEN
    RAISE EXCEPTION '0790: a contact channel table has no RLS policy';
  END IF;
  IF EXISTS (
    SELECT 1 FROM contact c
    WHERE c.email IS NOT NULL AND c.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM contact_email e WHERE e.contact_id = c.id)
  ) THEN
    RAISE EXCEPTION '0790: a contact with an email has no email entry';
  END IF;
END $$;
