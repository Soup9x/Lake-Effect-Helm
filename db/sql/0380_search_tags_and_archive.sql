-- =============================================================================
-- 0380_search_tags_and_archive.sql — findable documentation, tags, archiving
--
-- Three things, and the first is the reason for the other two.
--
-- SEARCH DID NOT WORK. Not "worked imperfectly" — a technician searching
-- `firew` for a firewall got nothing, `acme-dc` for ACME-DC01 got nothing, and
-- `Manufacturing` for the client called Acme Manufacturing got nothing, because
-- ORGANISATIONS WERE NEVER INDEXED AT ALL. Neither were sites, nor attachments.
-- The index held asset_node rows and contacts and that was the whole of it.
--
-- Two separate faults produced that:
--
--   1. Only three projectors existed. A client, a site and an uploaded network
--      diagram were simply absent from search_document, so no query could find
--      them however it was written.
--
--   2. helm.search() matched with websearch_to_tsquery alone, which is WORD
--      matching after stemming — `firew` is not a word and stems to nothing
--      that `firewall` stems to. A documentation platform is used by somebody
--      who half-remembers a hostname, which is precisely the query full text
--      search is worst at.
--
-- So: projectors for organisation, site and attachment; notes indexed alongside
-- descriptions; and a search that matches substrings as well as words, ordered
-- so that an exact hit outranks a fragment.
--
-- TAGS. asset_node.tags has existed since 0050 and is already projected into
-- search_document.tags, so credentials — which are asset nodes — have been
-- taggable all along. Organisations were the gap, and they get the same
-- `text[]` rather than a tag table and a join: a tag here is a label somebody
-- types, not an entity with an owner and a lifecycle, and the array is what the
-- offboarding export already reads.
--
-- ARCHIVING. asset_node.archived_at has existed since 0050 and every list query
-- already filters on it, so credentials and assets have been archivable
-- forever without a way to say so. Organisations get the same column, and it is
-- DISTINCT FROM deleted_at on purpose: deleted means gone and the row is on its
-- way out; archived means "not on my screen today", and the row is whole,
-- readable, and one click from coming back.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Organisations: tags and an archived state.
-- -----------------------------------------------------------------------------
ALTER TABLE organization ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE organization ADD COLUMN archived_at timestamptz;

COMMENT ON COLUMN organization.tags IS
  'Free-form labels, same shape and meaning as asset_node.tags. Filtering and '
  'bulk selection, not taxonomy.';
COMMENT ON COLUMN organization.archived_at IS
  'Hidden from default views, fully readable, restorable. NOT deleted_at: a '
  'deleted client is on its way out of the system, an archived one is a client '
  'the MSP no longer works with every day.';

-- Same bound as a note, and for the same reason: these are rendered back to
-- other people, and one paste should not make a row unrenderable.
ALTER TABLE organization ADD CONSTRAINT organization_tags_clean CHECK (
  array_position(tags, NULL) IS NULL
  AND array_position(tags, '') IS NULL
  AND cardinality(tags) <= 50
);

CREATE INDEX organization_tags_idx ON organization USING gin (tags);
CREATE INDEX organization_archived_idx ON organization (tenant_id, archived_at)
  WHERE archived_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- The searchable blob.
--
-- One lowercased string per document holding everything worth matching, so a
-- substring query is ONE trigram lookup rather than five ORed LIKEs across five
-- columns.
--
-- IMMUTABLE, and that is a claim worth defending rather than a keyword copied
-- from the function above it. array_to_string() is marked STABLE in the catalog
-- because in general it must call the element type's output function, which for
-- an arbitrary type may be stable. This function only ever receives `text[]`,
-- whose output function is textout, which is immutable; `lower()`, `coalesce()`
-- and `||` on text are immutable outright. So the declaration is true for this
-- signature, and a generated column may rely on it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.search_blob(
  p_title       text,
  p_subtitle    text,
  p_body        text,
  p_identifiers text[],
  p_tags        text[]
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT lower(
    coalesce(p_title, '')    || ' ' ||
    coalesce(p_subtitle, '') || ' ' ||
    coalesce(p_body, '')     || ' ' ||
    coalesce(array_to_string(p_identifiers, ' '), '') || ' ' ||
    coalesce(array_to_string(p_tags, ' '), '')
  );
$$;

-- Escape a fragment for use inside a LIKE pattern.
--
-- Backslash FIRST: escaping it after % and _ would escape the escapes. A query
-- containing % would otherwise be a wildcard, so searching for "50%" would
-- return every document in the tenant — which reads as a broken search rather
-- than as a feature nobody asked for.
CREATE OR REPLACE FUNCTION helm.like_escape(p_value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT replace(replace(replace(coalesce(p_value, ''), '\', '\\'), '%', '\%'), '_', '\_');
$$;
ALTER TABLE search_document
  ADD COLUMN search_text text GENERATED ALWAYS AS (
    helm.search_blob(title, subtitle, body, identifiers, tags)
  ) STORED;

-- The index that makes `%firew%` cost something reasonable. btree_gin puts
-- tenant_id in the same index, because every query this table receives is
-- "within this tenant, matching this fragment" — the tenant half comes from
-- RLS and the planner should not have to bitmap-AND two indexes to use it.
CREATE INDEX search_document_text_trgm_idx ON search_document
  USING gin (tenant_id, search_text gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- `kind` — what a result IS, for grouping.
--
-- entity_type says which TABLE a row came from, which is why every asset looked
-- identical in the results list: a credential, a firewall and a procedure are
-- all 'asset_node'. `kind` is the answer to "which heading does this go under",
-- and it is a stored column rather than a CASE in the query so the API can
-- filter on it and an index can serve it.
-- -----------------------------------------------------------------------------
ALTER TABLE search_document ADD COLUMN kind text NOT NULL DEFAULT 'asset';
ALTER TABLE search_document ADD CONSTRAINT search_document_kind_known CHECK (
  kind IN ('client', 'site', 'credential', 'document', 'asset', 'contact')
);
CREATE INDEX search_document_kind_idx ON search_document (tenant_id, kind);

-- A node's kind follows from its type. Credentials and procedures are the two
-- worth separating: one is what you came for in an incident, the other is what
-- you read before starting.
CREATE OR REPLACE FUNCTION helm.node_search_kind(p_node_type node_type) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE p_node_type
    WHEN 'credential' THEN 'credential'
    WHEN 'sop'        THEN 'document'
    ELSE 'asset'
  END;
$$;

-- =============================================================================
-- Projectors
-- =============================================================================

-- -----------------------------------------------------------------------------
-- asset_node, replaced: notes are indexed, and the row carries its kind.
--
-- `body` becomes description AND notes. 0370 added notes precisely because
-- description says what a thing is and notes say what you need to know about
-- it — and the second is far more often what somebody half-remembers and
-- searches for.
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
    entity_type, entity_id, tenant_id, organization_id, site_id, kind,
    title, subtitle, body, tags, node_id, is_internal_only, client_visible, updated_at
  )
  VALUES (
    'asset_node', NEW.id, NEW.tenant_id, NEW.organization_id, NEW.site_id,
    helm.node_search_kind(NEW.node_type),
    NEW.name, NEW.node_type::text,
    concat_ws(E'\n', NEW.description, NEW.notes),
    helm.normalise_terms(NEW.tags), NEW.id,
    NEW.is_internal_only, NOT NEW.is_internal_only, now()
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE
  SET tenant_id        = EXCLUDED.tenant_id,
      organization_id  = EXCLUDED.organization_id,
      site_id          = EXCLUDED.site_id,
      kind             = EXCLUDED.kind,
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

-- The trigger has to fire on `notes` too, or a note saved through the interface
-- is written to the row and never reaches the index.
DROP TRIGGER asset_node_search ON asset_node;
CREATE TRIGGER asset_node_search
  AFTER INSERT OR UPDATE OF name, description, notes, tags, archived_at,
                            is_internal_only, organization_id, site_id
  OR DELETE ON asset_node
  FOR EACH ROW EXECUTE FUNCTION helm.index_asset_node();

-- -----------------------------------------------------------------------------
-- organization — the projector that did not exist.
--
-- organization_id is the client's OWN id. That is what makes the existing RLS
-- policy work unchanged: a client administrator's org_scope contains their
-- organisation, so they find their own client row and nobody else's.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.index_organization() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_document WHERE entity_type = 'organization' AND entity_id = OLD.id;
    RETURN OLD;
  END IF;

  -- Deleted or archived: out of the index. Archived documentation should not
  -- surface in a search for live work, and the archive view is where it is
  -- found instead.
  IF NEW.deleted_at IS NOT NULL OR NEW.archived_at IS NOT NULL THEN
    DELETE FROM search_document WHERE entity_type = 'organization' AND entity_id = NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO search_document (
    entity_type, entity_id, tenant_id, organization_id, kind,
    title, subtitle, body, identifiers, tags, is_internal_only, client_visible, updated_at
  )
  VALUES (
    'organization', NEW.id, NEW.tenant_id, NEW.id, 'client',
    NEW.name, NEW.legal_name,
    concat_ws(E'\n', NEW.notes, NEW.quick_notes, NEW.industry),
    -- The slug and the PSA/RMM keys are handles somebody pastes from another
    -- system, which is exactly what the identifier weighting is for.
    helm.normalise_terms(ARRAY[NEW.slug, NEW.website, NEW.psa_company_id, NEW.rmm_organization_id]),
    helm.normalise_terms(NEW.tags),
    false, true, now()
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE
  SET title       = EXCLUDED.title,
      subtitle    = EXCLUDED.subtitle,
      body        = EXCLUDED.body,
      identifiers = EXCLUDED.identifiers,
      tags        = EXCLUDED.tags,
      updated_at  = now();

  RETURN NEW;
END;
$$;

CREATE TRIGGER organization_search
  AFTER INSERT OR UPDATE OF name, legal_name, slug, website, industry, notes,
                            quick_notes, tags, psa_company_id, rmm_organization_id,
                            deleted_at, archived_at
  OR DELETE ON organization
  FOR EACH ROW EXECUTE FUNCTION helm.index_organization();

-- -----------------------------------------------------------------------------
-- site — including the address, which is how people actually look for one.
--
-- "the Buffalo office" and "412 Main" are both things somebody types. The
-- address goes in `body` rather than in identifiers because it is prose to be
-- matched loosely, not a handle to be matched exactly.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.index_site() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_document WHERE entity_type = 'site' AND entity_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN
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
    -- The site code is what somebody says on a call: "BUF-HQ".
    helm.normalise_terms(ARRAY[NEW.code, NEW.postal_code, NEW.main_phone]),
    -- access_notes describe how to get into the building. Not a co-managed
    -- client's business, and the reason this row is not client_visible.
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

CREATE TRIGGER site_search
  AFTER INSERT OR UPDATE OF name, code, address_line1, address_line2, city, region,
                            postal_code, country, main_phone, notes, access_notes,
                            deleted_at, organization_id
  OR DELETE ON site
  FOR EACH ROW EXECUTE FUNCTION helm.index_site();

-- -----------------------------------------------------------------------------
-- attachment — the filename, which is the only thing anybody remembers.
--
-- Nobody remembers that the network diagram is attached to the firewall. They
-- remember it was called something like "acme-network". The filename goes in
-- BOTH title and identifiers: as a title it is what the result displays, and as
-- an identifier it is matched unstemmed, so "acme-network-2024.vsdx" is found
-- by "vsdx" and by "2024".
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.index_attachment() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_document WHERE entity_type = 'attachment' AND entity_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM search_document WHERE entity_type = 'attachment' AND entity_id = NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO search_document (
    entity_type, entity_id, tenant_id, organization_id, node_id, kind,
    title, subtitle, identifiers, is_internal_only, client_visible, updated_at
  )
  VALUES (
    'attachment', NEW.id, NEW.tenant_id, NEW.organization_id, NEW.node_id, 'document',
    NEW.filename, NEW.content_type,
    -- Split on the punctuation filenames are actually made of, so each part is
    -- separately matchable. The whole name is kept as well.
    helm.normalise_terms(
      ARRAY[NEW.filename] || string_to_array(regexp_replace(NEW.filename, '[._\-]+', ' ', 'g'), ' ')),
    NEW.is_internal_only, NOT NEW.is_internal_only, now()
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE
  SET organization_id  = EXCLUDED.organization_id,
      node_id          = EXCLUDED.node_id,
      title            = EXCLUDED.title,
      subtitle         = EXCLUDED.subtitle,
      identifiers      = EXCLUDED.identifiers,
      is_internal_only = EXCLUDED.is_internal_only,
      client_visible   = EXCLUDED.client_visible,
      updated_at       = now();

  RETURN NEW;
END;
$$;

CREATE TRIGGER attachment_search
  AFTER INSERT OR UPDATE OF filename, content_type, is_internal_only, deleted_at,
                            organization_id, node_id
  OR DELETE ON attachment
  FOR EACH ROW EXECUTE FUNCTION helm.index_attachment();

-- Contacts already had a projector; it just never set a kind.
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
    helm.normalise_terms(ARRAY[NEW.email::text, NEW.phone, NEW.mobile]),
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

-- =============================================================================
-- helm.search — substrings, words, and an order somebody can predict
--
-- The old signature took p_entity_types. The new one takes p_kinds, because
-- grouping is what the caller actually wants to filter on, and a parameter
-- cannot be renamed in place — hence DROP and CREATE rather than REPLACE.
-- =============================================================================
DROP FUNCTION IF EXISTS helm.search(text, uuid, text[], integer, integer);

CREATE OR REPLACE FUNCTION helm.search(
  p_query           text,
  p_organization_id uuid DEFAULT NULL,
  p_kinds           text[] DEFAULT NULL,
  p_limit           integer DEFAULT 25,
  p_offset          integer DEFAULT 0
) RETURNS TABLE (
  kind            text,
  entity_type     text,
  entity_id       uuid,
  organization_id uuid,
  site_id         uuid,
  node_id         uuid,
  title           text,
  subtitle        text,
  tags            text[],
  match_tier      integer,
  rank            real,
  headline        text
)
  LANGUAGE sql STABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  -- MATERIALIZED, so the patterns are computed once and become scan-time
  -- parameters rather than being inlined into a per-row filter.
  WITH q AS MATERIALIZED (
    SELECT
      n.needle,
      -- The whole query as a prefix pattern, for the "title starts with" tier.
      helm.like_escape(n.needle) || '%' AS prefix,
      websearch_to_tsquery('english', p_query) AS tsq,
      websearch_to_tsquery('simple',  p_query) AS tsq_exact,
      -- One LIKE pattern per whitespace-separated term.
      (SELECT array_agg('%' || helm.like_escape(t) || '%')
         FROM unnest(string_to_array(n.needle, ' ')) AS t
        WHERE t <> '') AS patterns
    FROM (SELECT lower(btrim(p_query)) AS needle) n
  ),
  matched AS (
    SELECT d.*, q.needle, q.tsq, q.tsq_exact,
      -- The tiers, highest first. Somebody who types an exact hostname wants
      -- that host at the top and is not interested in the six documents that
      -- mention it in passing; somebody who types a fragment wants everything.
      -- One ordering serves both only if exactness is ranked before relevance.
      CASE
        WHEN lower(d.title) = q.needle                             THEN 5
        WHEN q.needle = ANY (d.identifiers)
          OR q.needle = ANY (d.tags)                               THEN 4
        WHEN lower(d.title) LIKE q.prefix                          THEN 3
        WHEN lower(d.title) LIKE ALL (q.patterns)                  THEN 2
        WHEN d.tsv @@ (q.tsq || q.tsq_exact)                       THEN 1
        ELSE 0
      END AS match_tier
    FROM search_document d, q
    WHERE (
        -- Two conjuncts saying one thing, and the redundancy is measured
        -- rather than decorative. `LIKE ALL (array)` is not an indexable
        -- operator form: against a 60k-row index it read every document in the
        -- tenant — 3000 heap blocks — and filtered them in the heap. The first
        -- pattern alone, as a plain LIKE, is served by the trigram index and
        -- narrowed the identical query to 69 blocks. It is implied by the
        -- LIKE ALL beside it, so it changes no result, only the plan.
        --
        -- Every term must appear somewhere in the document, in any order. One
        -- contiguous LIKE over the whole query would fail on "acme firewall"
        -- whenever the two words are not adjacent, which is nearly always.
        (
          d.search_text LIKE q.patterns[1]
          AND d.search_text LIKE ALL (q.patterns)
        )
        OR d.tsv @@ (q.tsq || q.tsq_exact)
      )
      AND (p_organization_id IS NULL OR d.organization_id = p_organization_id)
      AND (p_kinds IS NULL OR d.kind = ANY (p_kinds))
      -- Internal-only documentation stays on the MSP side of a co-managed
      -- relationship. search_document's RLS policy scopes by organisation and
      -- says nothing about this flag, so without it a client administrator
      -- would find the internal notes about their own account — and a better
      -- search would have made that materially easier to stumble into.
      AND (d.client_visible OR helm.is_tenant_wide())
  )
  SELECT
    m.kind, m.entity_type, m.entity_id, m.organization_id, m.site_id, m.node_id,
    m.title, m.subtitle, m.tags,
    m.match_tier,
    ts_rank_cd(m.tsv, m.tsq || m.tsq_exact, 32) AS rank,
    ts_headline('english', coalesce(m.body, m.subtitle, m.title), m.tsq,
                'MaxFragments=2, MinWords=5, MaxWords=18, ShortWord=2') AS headline
  FROM matched m
  ORDER BY m.match_tier DESC,
           ts_rank_cd(m.tsv, m.tsq || m.tsq_exact, 32) DESC,
           -- A stable tie-break. Without one, two equally-ranked results swap
           -- places between page loads and the list looks broken.
           m.title,
           m.entity_id
  LIMIT least(coalesce(p_limit, 25), 200)
  OFFSET greatest(coalesce(p_offset, 0), 0);
$$;

COMMENT ON FUNCTION helm.search(text, uuid, text[], integer, integer) IS
  'Global search. Matches substrings and words; orders exact hits above '
  'fragments. Reads search_document under the caller''s RLS, and additionally '
  'withholds internal-only documents from client-side roles.';

GRANT EXECUTE ON FUNCTION helm.search(text, uuid, text[], integer, integer)
  TO helm_app, helm_auditor;

-- =============================================================================
-- Backfill
--
-- The projectors above only fire on future writes. Every organisation, site and
-- attachment that already exists has never been indexed — which is the whole
-- bug — so they are projected once here.
--
-- Written as INSERT ... SELECT rather than by touching every row to fire the
-- trigger: a no-op UPDATE on every organisation would rewrite updated_at,
-- re-run every other trigger on the table, and put a row in the audit log
-- saying somebody edited every client in the tenant during a migration.
-- =============================================================================
INSERT INTO search_document (
  entity_type, entity_id, tenant_id, organization_id, kind,
  title, subtitle, body, identifiers, tags, is_internal_only, client_visible, updated_at
)
SELECT
  'organization', o.id, o.tenant_id, o.id, 'client',
  o.name, o.legal_name,
  concat_ws(E'\n', o.notes, o.quick_notes, o.industry),
  helm.normalise_terms(ARRAY[o.slug, o.website, o.psa_company_id, o.rmm_organization_id]),
  helm.normalise_terms(o.tags),
  false, true, now()
FROM organization o
WHERE o.deleted_at IS NULL AND o.archived_at IS NULL
ON CONFLICT (entity_type, entity_id) DO NOTHING;

INSERT INTO search_document (
  entity_type, entity_id, tenant_id, organization_id, site_id, kind,
  title, subtitle, body, identifiers, is_internal_only, client_visible, updated_at
)
SELECT
  'site', s.id, s.tenant_id, s.organization_id, s.id, 'site',
  s.name,
  concat_ws(', ', s.address_line1, s.city, s.region),
  concat_ws(E'\n',
    concat_ws(', ', s.address_line1, s.address_line2, s.city, s.region,
                    s.postal_code, s.country),
    s.notes, s.access_notes),
  helm.normalise_terms(ARRAY[s.code, s.postal_code, s.main_phone]),
  true, false, now()
FROM site s
WHERE s.deleted_at IS NULL
ON CONFLICT (entity_type, entity_id) DO NOTHING;

INSERT INTO search_document (
  entity_type, entity_id, tenant_id, organization_id, node_id, kind,
  title, subtitle, identifiers, is_internal_only, client_visible, updated_at
)
SELECT
  'attachment', a.id, a.tenant_id, a.organization_id, a.node_id, 'document',
  a.filename, a.content_type,
  helm.normalise_terms(
    ARRAY[a.filename] || string_to_array(regexp_replace(a.filename, '[._\-]+', ' ', 'g'), ' ')),
  a.is_internal_only, NOT a.is_internal_only, now()
FROM attachment a
WHERE a.deleted_at IS NULL
ON CONFLICT (entity_type, entity_id) DO NOTHING;

-- Existing asset_node and contact rows predate `kind` and took the column
-- default, so a credential currently says it is an 'asset'. Corrected in place,
-- and their notes brought into the body for the first time.
UPDATE search_document d
   SET kind = helm.node_search_kind(n.node_type),
       body = concat_ws(E'\n', n.description, n.notes)
  FROM asset_node n
 WHERE d.entity_type = 'asset_node' AND d.entity_id = n.id;

UPDATE search_document SET kind = 'contact' WHERE entity_type = 'contact';

-- =============================================================================
-- Guards
-- =============================================================================
DO $$
DECLARE
  v_missing integer;
BEGIN
  -- 1. Every kind the constraint allows must have a projector that can produce
  --    it. A kind nothing writes is a heading that never appears, which reads
  --    to the person searching as "there are no clients matching this".
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'organization_search')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'site_search')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'attachment_search') THEN
    RAISE EXCEPTION 'helm: a search projector is missing';
  END IF;

  -- 2. The backfill reached every live organisation. This is the assertion that
  --    would have caught the original bug: clients existed and none of them
  --    were in the index.
  SELECT count(*) INTO v_missing
  FROM organization o
  WHERE o.deleted_at IS NULL AND o.archived_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM search_document d
      WHERE d.entity_type = 'organization' AND d.entity_id = o.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'helm: % organisation(s) are not in the search index', v_missing;
  END IF;

  SELECT count(*) INTO v_missing
  FROM site s
  WHERE s.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM search_document d
      WHERE d.entity_type = 'site' AND d.entity_id = s.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'helm: % site(s) are not in the search index', v_missing;
  END IF;

  -- 3. No document may claim a kind the API cannot group.
  IF EXISTS (
    SELECT 1 FROM search_document
    WHERE kind NOT IN ('client', 'site', 'credential', 'document', 'asset', 'contact')
  ) THEN
    RAISE EXCEPTION 'helm: a search document carries an unknown kind';
  END IF;

  -- 4. The blob is generated, not written. A plain column maintained by five
  --    projectors is one forgotten assignment away from a document that is
  --    findable by word and not by fragment, which is the hardest kind of
  --    search bug to notice.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.search_document'::regclass
      AND attname = 'search_text' AND attgenerated = 's'
  ) THEN
    RAISE EXCEPTION 'helm: search_text must be a generated column';
  END IF;

  -- 5. Archiving and deleting stay different things. A migration that made
  --    archived_at an alias for deleted_at would silently turn "hide this for
  --    now" into "remove this", and the rows it had already hidden would be
  --    indistinguishable from deleted ones afterwards.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.organization'::regclass
      AND attname = 'archived_at' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'helm: organization.archived_at is missing';
  END IF;
END;
$$;
