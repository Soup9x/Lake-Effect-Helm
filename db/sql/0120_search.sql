-- =============================================================================
-- 0120_search.sql — global full-text search across all documentation
--
-- One denormalised index table rather than tsvector columns scattered across
-- fifteen source tables. A technician searching "Buffalo firewall" wants one
-- ranked list, not a UNION of fifteen differently-weighted queries.
--
-- The hard rule, enforced by the projector and re-stated in every trigger:
-- SECRET MATERIAL NEVER ENTERS THIS TABLE. The search index is the least
-- protected copy of the data — it is denormalised, widely read, cached, and a
-- prime candidate for mirroring into Meilisearch. A password that reaches it
-- has escaped the entire key hierarchy.
--
-- What IS indexed for a credential: its label, username, type and URL. Those
-- are what makes it findable. The material stays behind helm.reveal_secret().
-- =============================================================================

SET search_path = public, extensions;

-- Lowercases, trims and drops empty/NULL entries so an array is safe for
-- array_to_tsvector and matches what websearch_to_tsquery produces.
CREATE OR REPLACE FUNCTION helm.normalise_terms(p_terms text[])
  RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(
    array_agg(DISTINCT t ORDER BY t),
    '{}'::text[]
  )
  FROM unnest(coalesce(p_terms, '{}'::text[])) AS raw
  CROSS JOIN LATERAL (SELECT lower(btrim(raw)) AS t) norm
  WHERE raw IS NOT NULL AND btrim(raw) <> '';
$$;

CREATE TABLE search_document (
  -- One row per indexed entity.
  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,
  site_id          uuid,

  title            text NOT NULL,
  subtitle         text,
  body             text,
  -- Exact-match handles: hostnames, serials, IPs, ticket refs. Kept apart from
  -- `body` so they can be weighted higher and matched without stemming.
  identifiers      text[] NOT NULL DEFAULT '{}',
  tags             text[] NOT NULL DEFAULT '{}',

  node_id          uuid,
  is_internal_only boolean NOT NULL DEFAULT false,
  -- Client-side roles only ever see rows where this is true.
  client_visible   boolean NOT NULL DEFAULT false,

  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- array_to_tsvector rather than to_tsvector(array_to_string(...)): the latter
  -- is not immutable (array_to_string is STABLE) and so cannot back a generated
  -- column. It is also the better semantics here — identifiers are handles, not
  -- prose, and must not be stemmed. "srv-dc01" should match "srv-dc01", not
  -- whatever the English stemmer decides it is a form of.
  --
  -- Projectors lowercase identifiers and tags before writing, because
  -- array_to_tsvector does not normalise while websearch_to_tsquery does.
  tsv tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')),    'A')
   || setweight(array_to_tsvector(identifiers),                 'A')
   || setweight(to_tsvector('english', coalesce(subtitle, '')), 'B')
   || setweight(array_to_tsvector(tags),                        'B')
   || setweight(to_tsvector('english', coalesce(body, '')),     'D')
  ) STORED,

  PRIMARY KEY (entity_type, entity_id),
  CONSTRAINT search_document_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  -- array_to_tsvector rejects NULL and empty elements at runtime; refusing them
  -- at write time turns a generated-column failure deep inside a sync job into
  -- an obvious constraint violation at the insert.
  CONSTRAINT search_document_identifiers_clean CHECK (
    array_position(identifiers, NULL) IS NULL AND array_position(identifiers, '') IS NULL
  ),
  CONSTRAINT search_document_tags_clean CHECK (
    array_position(tags, NULL) IS NULL AND array_position(tags, '') IS NULL
  )
);

-- btree_gin lets one index serve "within this tenant, matching these terms",
-- which is every query this table ever receives.
CREATE INDEX search_document_tsv_idx ON search_document
  USING gin (tenant_id, tsv);
CREATE INDEX search_document_org_idx ON search_document (tenant_id, organization_id);
CREATE INDEX search_document_node_idx ON search_document (node_id) WHERE node_id IS NOT NULL;
CREATE INDEX search_document_title_trgm_idx ON search_document
  USING gin (title gin_trgm_ops);

COMMENT ON TABLE search_document IS
  'Denormalised search index. Contains no secret material by construction — see '
  'helm.index_asset_node() and the credential projector.';

-- -----------------------------------------------------------------------------
-- Projector for asset_node-backed entities.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.index_asset_node() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_document
    WHERE entity_type = 'asset_node' AND entity_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.archived_at IS NOT NULL THEN
    DELETE FROM search_document
    WHERE entity_type = 'asset_node' AND entity_id = NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO search_document (
    entity_type, entity_id, tenant_id, organization_id, site_id,
    title, subtitle, body, tags, node_id, is_internal_only, client_visible, updated_at
  )
  VALUES (
    'asset_node', NEW.id, NEW.tenant_id, NEW.organization_id, NEW.site_id,
    NEW.name, NEW.node_type::text, NEW.description,
    helm.normalise_terms(NEW.tags), NEW.id,
    NEW.is_internal_only, NOT NEW.is_internal_only, now()
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE
  SET tenant_id        = EXCLUDED.tenant_id,
      organization_id  = EXCLUDED.organization_id,
      site_id          = EXCLUDED.site_id,
      title            = EXCLUDED.title,
      subtitle         = EXCLUDED.subtitle,
      body             = EXCLUDED.body,
      tags             = EXCLUDED.tags,
      is_internal_only = EXCLUDED.is_internal_only,
      client_visible   = EXCLUDED.client_visible,
      updated_at       = now();

  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_node_search
  AFTER INSERT OR UPDATE OF name, description, tags, archived_at, is_internal_only,
                            organization_id, site_id
  OR DELETE ON asset_node
  FOR EACH ROW EXECUTE FUNCTION helm.index_asset_node();

-- -----------------------------------------------------------------------------
-- Identifier enrichment. Exact handles live on the subtype tables, so each
-- contributes its searchable identifiers back onto the node's document.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.index_node_identifiers() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_row         jsonb;
  v_identifiers text[] := '{}';
  v_col         text;
  v_val         text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  v_row := to_jsonb(NEW);

  FOREACH v_col IN ARRAY TG_ARGV LOOP
    v_val := v_row ->> v_col;
    IF v_val IS NOT NULL AND v_val <> '' THEN
      v_identifiers := v_identifiers || lower(v_val);
    END IF;
  END LOOP;

  UPDATE search_document
  SET identifiers = v_identifiers, updated_at = now()
  WHERE entity_type = 'asset_node' AND entity_id = NEW.id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER device_search_identifiers
  AFTER INSERT OR UPDATE OF hostname, fqdn, serial_number, asset_tag, primary_mac ON device
  FOR EACH ROW EXECUTE FUNCTION helm.index_node_identifiers(
    'hostname', 'fqdn', 'serial_number', 'asset_tag', 'primary_mac');

CREATE TRIGGER ip_search_identifiers
  AFTER INSERT OR UPDATE OF address, ptr_record ON ip_address
  FOR EACH ROW EXECUTE FUNCTION helm.index_node_identifiers('address', 'ptr_record');

CREATE TRIGGER domain_search_identifiers
  AFTER INSERT OR UPDATE OF domain_name ON domain
  FOR EACH ROW EXECUTE FUNCTION helm.index_node_identifiers('domain_name');

CREATE TRIGGER ssl_search_identifiers
  AFTER INSERT OR UPDATE OF common_name, serial_number ON ssl_certificate
  FOR EACH ROW EXECUTE FUNCTION helm.index_node_identifiers('common_name', 'serial_number');

CREATE TRIGGER network_search_identifiers
  AFTER INSERT OR UPDATE OF cidr, vlan_id, ssid ON network
  FOR EACH ROW EXECUTE FUNCTION helm.index_node_identifiers('cidr', 'vlan_id', 'ssid');

-- Credentials: username and URL only. Never secret_id, never anything that
-- came out of secret_version.
CREATE TRIGGER credential_search_identifiers
  AFTER INSERT OR UPDATE OF username, url ON credential
  FOR EACH ROW EXECUTE FUNCTION helm.index_node_identifiers('username', 'url');

-- -----------------------------------------------------------------------------
-- Non-node entities worth searching.
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
    entity_type, entity_id, tenant_id, organization_id, site_id,
    title, subtitle, body, identifiers, client_visible, updated_at
  )
  VALUES (
    'contact', NEW.id, NEW.tenant_id, NEW.organization_id, NEW.site_id,
    NEW.first_name || ' ' || NEW.last_name, NEW.title, NEW.notes,
    helm.normalise_terms(ARRAY[NEW.email::text, NEW.phone, NEW.mobile]),
    true, now()
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      site_id         = EXCLUDED.site_id,
      title           = EXCLUDED.title,
      subtitle        = EXCLUDED.subtitle,
      body            = EXCLUDED.body,
      identifiers     = EXCLUDED.identifiers,
      updated_at      = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER contact_search
  AFTER INSERT OR UPDATE OR DELETE ON contact
  FOR EACH ROW EXECUTE FUNCTION helm.index_contact();

-- Flexible asset records index only the fields the schema publisher explicitly
-- marked searchable. Default is not indexed, which is the safe default for a
-- template a technician invented this morning.
CREATE OR REPLACE FUNCTION helm.index_flexible_record() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_searchable text[];
  v_secret     text[];
  v_path       text;
  v_key        text;
  v_parts      text[] := '{}';
  v_val        text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT searchable_fields, secret_fields INTO v_searchable, v_secret
  FROM flexible_asset_type_version WHERE id = NEW.type_version_id;

  FOREACH v_path IN ARRAY coalesce(v_searchable, '{}') LOOP
    -- Belt and braces: a field that is somehow in both lists is not indexed.
    CONTINUE WHEN v_path = ANY (coalesce(v_secret, '{}'));
    v_key := substring(v_path from 2);
    v_val := NEW.data ->> v_key;
    IF v_val IS NOT NULL AND v_val <> '' THEN
      v_parts := v_parts || v_val;
    END IF;
  END LOOP;

  UPDATE search_document
  SET body = array_to_string(v_parts, E'\n'), updated_at = now()
  WHERE entity_type = 'asset_node' AND entity_id = NEW.id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER flexible_record_search
  AFTER INSERT OR UPDATE OF data, type_version_id ON flexible_asset_record
  FOR EACH ROW EXECUTE FUNCTION helm.index_flexible_record();

-- -----------------------------------------------------------------------------
-- helm.search — the ranked global query.
--
-- Not SECURITY DEFINER: it reads search_document under the caller's RLS, so
-- scoping is the policy's job and cannot be forgotten here.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.search(
  p_query           text,
  p_organization_id uuid DEFAULT NULL,
  p_entity_types    text[] DEFAULT NULL,
  p_limit           integer DEFAULT 25,
  p_offset          integer DEFAULT 0
) RETURNS TABLE (
  entity_type     text,
  entity_id       uuid,
  organization_id uuid,
  title           text,
  subtitle        text,
  node_id         uuid,
  rank            real,
  headline        text
)
  LANGUAGE sql STABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  WITH q AS (
    SELECT websearch_to_tsquery('english', p_query) AS tsq,
           websearch_to_tsquery('simple',  p_query) AS tsq_exact
  )
  SELECT
    d.entity_type,
    d.entity_id,
    d.organization_id,
    d.title,
    d.subtitle,
    d.node_id,
    ts_rank_cd(d.tsv, q.tsq || q.tsq_exact, 32) AS rank,
    ts_headline('english', coalesce(d.body, d.subtitle, d.title), q.tsq,
                'MaxFragments=2, MinWords=5, MaxWords=18, ShortWord=2') AS headline
  FROM search_document d, q
  WHERE d.tsv @@ (q.tsq || q.tsq_exact)
    AND (p_organization_id IS NULL OR d.organization_id = p_organization_id)
    AND (p_entity_types IS NULL OR d.entity_type = ANY (p_entity_types))
  ORDER BY rank DESC, d.updated_at DESC
  LIMIT least(coalesce(p_limit, 25), 200)
  OFFSET greatest(coalesce(p_offset, 0), 0);
$$;

GRANT EXECUTE ON FUNCTION helm.search(text, uuid, text[], integer, integer)
  TO helm_app, helm_auditor;
