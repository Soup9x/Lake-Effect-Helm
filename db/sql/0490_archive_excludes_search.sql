-- =============================================================================
-- 0490 — archiving a client takes its documentation out of search with it
--
-- THE DEFECT, measured on a live cluster before anything was written. The
-- fixture client has eight documents in the index: itself, two credentials and
-- five assets.
--
--   UPDATE organization SET archived_at = now() WHERE id = <acme>;
--
--   BEFORE                               AFTER
--   organization  Acme Manufacturing     (gone)
--   asset_node    ACME Domain Admin      asset_node  ACME Domain Admin
--   asset_node    ACME Guest WiFi        asset_node  ACME Guest WiFi
--   asset_node    ACME-DC01              asset_node  ACME-DC01
--   asset_node    ACME-LAN VLAN 10       asset_node  ACME-LAN VLAN 10
--   asset_node    acme-fw-01             asset_node  acme-fw-01
--   asset_node    acme.test              asset_node  acme.test
--   asset_node    wildcard acme.test     asset_node  wildcard acme.test
--
-- The client row leaves the index correctly — helm.index_organization() has
-- handled archived_at since 0380 and the trigger fires on that column. What it
-- never did was CASCADE. Archiving a client does not set archived_at on its
-- assets, so every one of them stayed indexed and findable, and a technician
-- searching "acme" still got the archived client's domain admin credential with
-- nothing to say the client was archived.
--
-- Reported as "archived clients still appear in search". What actually happens
-- is narrower and worse: the client disappears and everything underneath it
-- does not.
--
-- WHY A DENORMALISED FLAG RATHER THAN DELETING THE CHILDREN TOO. Archiving is
-- reversible. Deleting a client's documents from the index would make unarchive
-- a rebuild — re-projecting every asset, credential, site and contact from its
-- source row — and a rebuild is the kind of thing that is written once, tested
-- once, and quietly drifts from the projectors it duplicates. A flag makes both
-- directions the same single UPDATE and keeps one definition of how a document
-- is built.
--
-- WHY A TRIGGER ON search_document RATHER THAN EDITING SIX PROJECTORS. A new
-- document created under an already-archived client has to carry the flag too,
-- and there are six projector functions that insert one (asset_node,
-- organization, site, contact, attachment, flexible_asset_record). Setting it
-- in each is six places to remember and a seventh that will be added later
-- without it. Deriving it once, where the row is written, cannot be forgotten —
-- the same argument 0460 makes for reading the catalogue instead of a
-- hand-maintained list.
-- =============================================================================
SET search_path = public, extensions;

ALTER TABLE search_document
  ADD COLUMN IF NOT EXISTS organization_archived boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN search_document.organization_archived IS
  'Whether this document belongs to an archived client. Derived on write by '
  'helm.derive_search_archived(); never set by a projector. helm.search() '
  'excludes it.';

-- -----------------------------------------------------------------------------
-- helm.derive_search_archived — one definition, applied to every write.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.derive_search_archived() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  -- A document with no organisation cannot belong to an archived one. Not
  -- currently reachable — every projector sets organization_id — but a NULL
  -- here must read as "not archived" rather than making the row vanish.
  NEW.organization_archived := NEW.organization_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM organization o
    WHERE o.id = NEW.organization_id AND o.archived_at IS NOT NULL
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS search_document_archived ON search_document;
CREATE TRIGGER search_document_archived
  BEFORE INSERT OR UPDATE ON search_document
  FOR EACH ROW EXECUTE FUNCTION helm.derive_search_archived();

-- -----------------------------------------------------------------------------
-- helm.search, with the filter added. The body below is the live
-- pg_get_functiondef() output with one conjunct inserted; retyping a query this
-- size by hand is how a tier or an RLS-adjacent guard goes missing in the copy.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.search(p_query text, p_organization_id uuid DEFAULT NULL::uuid, p_kinds text[] DEFAULT NULL::text[], p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS TABLE(kind text, entity_type text, entity_id uuid, organization_id uuid, site_id uuid, node_id uuid, title text, subtitle text, tags text[], match_tier integer, rank real, headline text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog', 'pg_temp'
AS $function$
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
      -- Everything belonging to an archived client leaves the results with it.
      -- The client's own document is removed from the index outright by
      -- helm.index_organization(); its assets, credentials, sites and contacts
      -- are not, because archiving a client does not archive them individually.
      -- Without this they stayed findable and the archive looked like it had
      -- done nothing.
      AND NOT d.organization_archived
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
$function$

;

-- -----------------------------------------------------------------------------
-- The cascade. helm.index_organization() is rebuilt from its live definition
-- with the child UPDATE appended to both branches.
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

  /*
   * THE CASCADE, and it runs on every firing rather than only when archived_at
   * changed. The trigger fires on twelve columns; working out which of them
   * moved in order to skip a single indexed UPDATE would be a correctness risk
   * taken to save nothing. Re-deriving is idempotent — the BEFORE trigger on
   * search_document computes the value from `organization` either way — so this
   * is also self-healing for any row that got out of step.
   */
  UPDATE search_document
     SET organization_archived = (NEW.archived_at IS NOT NULL)
   WHERE organization_id = NEW.id;

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
    helm.normalise_terms(ARRAY[NEW.slug, NEW.website, NEW.psa_company_id, NEW.rmm_organization_id]),
    helm.normalise_terms(NEW.tags),
    false, true, now()
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE
  SET tenant_id       = EXCLUDED.tenant_id,
      organization_id = EXCLUDED.organization_id,
      kind            = EXCLUDED.kind,
      title           = EXCLUDED.title,
      subtitle        = EXCLUDED.subtitle,
      body            = EXCLUDED.body,
      identifiers     = EXCLUDED.identifiers,
      tags            = EXCLUDED.tags,
      client_visible  = EXCLUDED.client_visible,
      updated_at      = now();

  RETURN NEW;
END;
$$;

-- Backfill, for the clients already archived when this migration runs. Their
-- documents have been findable the whole time.
UPDATE search_document d
   SET organization_archived = true
  FROM organization o
 WHERE o.id = d.organization_id
   AND o.archived_at IS NOT NULL
   AND NOT d.organization_archived;

-- Partial, because the filter only ever excludes and the excluded set is small:
-- an index over the common `false` would be most of the table.
CREATE INDEX IF NOT EXISTS search_document_archived_idx
  ON search_document (organization_id)
  WHERE organization_archived;

-- =============================================================================
-- Guards
-- =============================================================================
DO $search_archive_guard$
DECLARE
  v_search text := (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
                    JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'helm' AND p.proname = 'search');
  v_org    text := (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
                    JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'helm' AND p.proname = 'index_organization');
  v_leaked bigint;
BEGIN
  -- 1. THE QUERY FILTERS. Without it the column is bookkeeping and the results
  --    are unchanged, which is precisely the state this file found.
  IF v_search !~ 'NOT d\.organization_archived' THEN
    RAISE EXCEPTION 'helm: helm.search() no longer excludes archived clients';
  END IF;

  -- 2. AND IT STILL WITHHOLDS INTERNAL-ONLY DOCUMENTATION. helm.search() was
  --    rebuilt from a transformed copy of itself, and this is the conjunct
  --    whose loss would be silent and serious.
  IF v_search !~ 'client_visible OR helm\.is_tenant_wide\(\)' THEN
    RAISE EXCEPTION 'helm: helm.search() lost its internal-only filter';
  END IF;

  -- 3. THE CASCADE IS THERE. The column and the filter without it would hide
  --    nothing, because no child row would ever be marked.
  IF v_org !~ 'organization_archived' THEN
    RAISE EXCEPTION 'helm: index_organization() no longer cascades to its documents';
  END IF;

  -- 4. THE DERIVATION FIRES ON BOTH COMMANDS AND ALL COLUMNS, so a projector
  --    added later cannot insert an unflagged document under an archived
  --    client.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'search_document'::regclass
      AND tgname = 'search_document_archived'
      AND NOT tgisinternal
      AND (tgtype & 2) <> 0 AND (tgtype & 4) <> 0 AND (tgtype & 16) <> 0
      AND tgattr = ''::int2vector
  ) THEN
    RAISE EXCEPTION
      'helm: search_document_archived must fire BEFORE INSERT OR UPDATE on all columns';
  END IF;

  -- 5. NOTHING IS LEFT BEHIND by the backfill.
  SELECT count(*) INTO v_leaked
  FROM search_document d JOIN organization o ON o.id = d.organization_id
  WHERE o.archived_at IS NOT NULL AND NOT d.organization_archived;
  IF v_leaked > 0 THEN
    RAISE EXCEPTION 'helm: % documents of archived clients are still unflagged', v_leaked;
  END IF;
END;
$search_archive_guard$;
