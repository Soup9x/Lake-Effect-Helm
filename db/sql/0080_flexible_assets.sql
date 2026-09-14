-- =============================================================================
-- 0080_flexible_assets.sql — technician-defined documentation templates
--
-- Two decisions carry this module:
--
-- 1. SCHEMAS ARE VERSIONED AND IMMUTABLE ONCE USED.
--    A flexible asset type whose schema can be edited in place will eventually
--    invalidate records written years earlier — and the first time anyone
--    notices is during a compliance export, when a required field is suddenly
--    missing from four hundred records. Each record therefore pins the schema
--    version it was validated against, and published versions are read-only.
--
-- 2. SECRET FIELDS NEVER ENTER THE JSONB.
--    A field marked `x-helm-secret` in the schema is stored as a pointer in
--    flexible_asset_secret and the `data` document holds only a reference.
--    Otherwise every secret in a custom template would sit in plaintext inside
--    a jsonb column, outside the audited reveal path, and be copied into every
--    backup, every logical replica, and the search index.
-- =============================================================================

SET search_path = public, extensions;

CREATE TYPE schema_version_status AS ENUM ('draft', 'published', 'deprecated');

-- -----------------------------------------------------------------------------
-- flexible_asset_type — the template, e.g. "Backup Job", "Wireless Network".
-- -----------------------------------------------------------------------------
CREATE TABLE flexible_asset_type (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,

  key                text NOT NULL,
  name               text NOT NULL,
  description        text,
  icon               text,
  colour             text,

  -- Points at the version new records are created against.
  current_version_id uuid,
  is_active          boolean NOT NULL DEFAULT true,
  -- Whether client-side roles may see records of this type at all.
  client_visible     boolean NOT NULL DEFAULT false,

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT flexible_type_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT flexible_type_key_uk UNIQUE (tenant_id, key),
  CONSTRAINT flexible_type_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT flexible_type_colour_shape CHECK (colour IS NULL OR colour ~ '^#[0-9a-fA-F]{6}$')
);

-- -----------------------------------------------------------------------------
-- flexible_asset_type_version — an immutable published schema.
-- -----------------------------------------------------------------------------
CREATE TABLE flexible_asset_type_version (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  type_id        uuid NOT NULL,
  version        integer NOT NULL,
  status         schema_version_status NOT NULL DEFAULT 'draft',

  -- JSON Schema 2020-12. Validated by the application (Ajv) on write; Postgres
  -- only guarantees it is a JSON object with the expected top-level shape.
  json_schema    jsonb NOT NULL,
  -- Rendering hints: field order, widget types, sections, help text.
  ui_schema      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Denormalised list of `x-helm-secret` field pointers, extracted at publish
  -- time so the writer does not have to re-walk the schema on every insert.
  secret_fields  text[] NOT NULL DEFAULT '{}',
  -- Fields promoted into the global search index. Explicit allow-list: a
  -- technician who adds a "Recovery Phrase" text field should not have it
  -- silently indexed.
  searchable_fields text[] NOT NULL DEFAULT '{}',

  published_at   timestamptz,
  published_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  deprecated_at  timestamptz,
  change_note    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT flexible_version_uk UNIQUE (type_id, version),
  CONSTRAINT flexible_version_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT flexible_version_type_fk FOREIGN KEY (type_id, tenant_id)
    REFERENCES flexible_asset_type (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT flexible_version_positive CHECK (version > 0),
  CONSTRAINT flexible_version_schema_object CHECK (jsonb_typeof(json_schema) = 'object'),
  CONSTRAINT flexible_version_ui_object CHECK (jsonb_typeof(ui_schema) = 'object'),
  CONSTRAINT flexible_version_schema_is_object_type CHECK (
    json_schema ->> 'type' = 'object'
  ),
  CONSTRAINT flexible_version_published_has_timestamp CHECK (
    (status = 'draft') = (published_at IS NULL)
  ),
  -- A secret field cannot also be a searchable field.
  CONSTRAINT flexible_version_secrets_not_searchable CHECK (
    NOT (secret_fields && searchable_fields)
  )
);

ALTER TABLE flexible_asset_type
  ADD CONSTRAINT flexible_type_current_version_fk
  FOREIGN KEY (current_version_id, tenant_id)
  REFERENCES flexible_asset_type_version (id, tenant_id) ON DELETE SET NULL;

-- Published schema versions are frozen. Only the lifecycle columns may move
-- (published -> deprecated); the schema body itself cannot change.
CREATE OR REPLACE FUNCTION helm.freeze_published_schema() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.json_schema IS DISTINCT FROM OLD.json_schema
     OR NEW.secret_fields IS DISTINCT FROM OLD.secret_fields
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.type_id IS DISTINCT FROM OLD.type_id THEN
    RAISE EXCEPTION 'helm: schema version % of type % is published and immutable',
      OLD.version, OLD.type_id
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Publish a new version. Records already validated against this '
                   'one must keep a schema that still describes them.';
  END IF;

  IF OLD.status = 'deprecated' AND NEW.status <> 'deprecated' THEN
    RAISE EXCEPTION 'helm: schema version % cannot leave deprecated status', OLD.version
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER flexible_version_freeze
  BEFORE UPDATE ON flexible_asset_type_version
  FOR EACH ROW EXECUTE FUNCTION helm.freeze_published_schema();

CREATE TRIGGER flexible_version_no_delete_published
  BEFORE DELETE ON flexible_asset_type_version
  FOR EACH ROW WHEN (OLD.status <> 'draft')
  EXECUTE FUNCTION helm.deny_mutation();

-- -----------------------------------------------------------------------------
-- flexible_asset_record — an instance. A first-class graph node, so custom
-- documentation participates in dependency mapping like everything else.
-- -----------------------------------------------------------------------------
CREATE TABLE flexible_asset_record (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  node_type        node_type NOT NULL DEFAULT 'flexible_asset',

  type_id          uuid NOT NULL,
  type_version_id  uuid NOT NULL,

  data             jsonb NOT NULL DEFAULT '{}'::jsonb,
  validated_at     timestamptz,
  -- Set when a schema migration leaves this record no longer conforming to its
  -- type's current version. Surfaced in the UI rather than silently tolerated.
  needs_migration  boolean NOT NULL DEFAULT false,

  CONSTRAINT flexible_record_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT flexible_record_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT flexible_record_node_type_pin CHECK (node_type = 'flexible_asset'),
  CONSTRAINT flexible_record_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT flexible_record_type_fk FOREIGN KEY (type_id, tenant_id)
    REFERENCES flexible_asset_type (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT flexible_record_version_fk FOREIGN KEY (type_version_id, tenant_id)
    REFERENCES flexible_asset_type_version (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT flexible_record_data_object CHECK (jsonb_typeof(data) = 'object')
);

CREATE INDEX flexible_record_type_idx ON flexible_asset_record (tenant_id, type_id);
CREATE INDEX flexible_record_data_idx ON flexible_asset_record USING gin (data jsonb_path_ops);
CREATE INDEX flexible_record_needs_migration_idx ON flexible_asset_record (tenant_id)
  WHERE needs_migration;

-- -----------------------------------------------------------------------------
-- flexible_asset_secret — the out-of-band store for `x-helm-secret` fields.
-- -----------------------------------------------------------------------------
CREATE TABLE flexible_asset_secret (
  record_id   uuid NOT NULL,
  tenant_id   uuid NOT NULL,
  -- JSON Pointer (RFC 6901) into the record's data document, e.g. "/api_key".
  field_path  text NOT NULL,
  secret_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (record_id, field_path),
  CONSTRAINT flexible_secret_record_fk FOREIGN KEY (record_id, tenant_id)
    REFERENCES flexible_asset_record (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT flexible_secret_secret_fk FOREIGN KEY (secret_id, tenant_id)
    REFERENCES secret (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT flexible_secret_path_shape CHECK (field_path ~ '^/[^/].*$')
);
CREATE INDEX flexible_secret_secret_idx ON flexible_asset_secret (secret_id);

-- -----------------------------------------------------------------------------
-- Structural guard: a field the schema declares secret must not appear in the
-- jsonb document with a value. The application strips it before writing; this
-- trigger makes a bug in that path fail the transaction rather than quietly
-- persist a domain admin password into a searchable jsonb column.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.reject_inline_secret_fields() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_secret_fields text[];
  v_path          text;
  v_key           text;
BEGIN
  SELECT secret_fields INTO v_secret_fields
  FROM flexible_asset_type_version
  WHERE id = NEW.type_version_id;

  IF v_secret_fields IS NULL OR cardinality(v_secret_fields) = 0 THEN
    RETURN NEW;
  END IF;

  FOREACH v_path IN ARRAY v_secret_fields LOOP
    -- secret_fields holds JSON Pointers; only top-level scalar fields may be
    -- secret, which keeps this check exact rather than approximate.
    v_key := substring(v_path from 2);
    IF NEW.data ? v_key AND jsonb_typeof(NEW.data -> v_key) <> 'null' THEN
      RAISE EXCEPTION 'helm: field % is declared secret and must not be stored inline', v_path
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'Write the value through the secret API and reference it from '
                     'flexible_asset_secret.';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE TRIGGER flexible_record_no_inline_secrets
  BEFORE INSERT OR UPDATE OF data, type_version_id ON flexible_asset_record
  FOR EACH ROW EXECUTE FUNCTION helm.reject_inline_secret_fields();

CREATE TRIGGER flexible_type_touch BEFORE UPDATE ON flexible_asset_type
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();
