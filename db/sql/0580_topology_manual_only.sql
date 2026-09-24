-- =============================================================================
-- 0580 — the topology designer is a drawing tool, not a view of a controller
--
-- WHY THIS IS A SEPARATE FILE AND NOT AN EDIT TO 0570
--
-- The same reason as 0440. 0570 has been applied, and helm_migration stores a
-- sha256 over the whole file, so editing it in place turns every subsequent
-- `pnpm db:migrate` into a hard failure on any environment that has already run
-- it while leaving environments that have not silently different. 0570 stays
-- byte-identical to what was applied; the change of mind lives here.
--
-- WHAT CHANGED
--
-- 0570 shipped the diagram with UniFi auto-population: a mapping could name a
-- site, a poll seeded boxes keyed by mac_blind_index, and an elaborate
-- machinery of customisation markers existed so that a poll could never undo
-- somebody's work. The feature is now manual only. A person draws the diagram;
-- nothing else writes to it.
--
-- That removes the reason for every piece of machinery below:
--
--   upsert_topology_node/link   Existed so a poll could re-run without
--                               duplicating or clobbering. Nothing re-runs.
--   mac_blind_index             The sync's identity for a box. No sync, no
--                               identity to match on; a manual node is
--                               identified by being the one somebody drew.
--   *_customised markers        Existed to answer "may a poll overwrite this
--                               field?". With no poll the answer is moot, and
--                               four booleans that are always true in spirit
--                               are worse than no booleans.
--   source                      Every row is 'manual' now. A column with one
--                               possible value is a column that misleads the
--                               next reader into thinking there are two.
--   unifi_site_mapping.site_id  A mapping fed a diagram. It no longer does, so
--                               the column, its FK, its index and the guard
--                               trigger that kept a mapping's site in the
--                               mapping's client all go.
--
-- WHAT IS DELIBERATELY KEPT
--
-- Everything a person drew: nodes, links, labels, IPs, subnets, device types
-- and — above all — positions. This migration drops columns nobody typed into.
-- A diagram that exists before 0580 looks identical after it.
--
-- topology_device_type is kept: it is the icon picker, and manual nodes use it.
-- The from/to direction on a link is kept: the pair uniqueness index is built
-- on it, and "the order it was drawn" is a harmless thing for it to mean.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The upserts. SECURITY INVOKER, so dropping them takes nothing else with them.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS helm.upsert_topology_node(
  uuid, bytea, text, text, text, topology_device_type, uuid);
DROP FUNCTION IF EXISTS helm.upsert_topology_link(uuid, uuid, uuid, text);

-- -----------------------------------------------------------------------------
-- unifi_site_mapping stops naming a site.
--
-- The trigger goes before the column: it fires on UPDATE OF site_id, and
-- dropping the column out from under a trigger that references it is a
-- needlessly interesting way to find out what Postgres does.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS unifi_mapping_site_check ON unifi_site_mapping;
DROP FUNCTION IF EXISTS helm.unifi_mapping_site_guard();

DROP INDEX IF EXISTS unifi_mapping_site_idx;
ALTER TABLE unifi_site_mapping DROP CONSTRAINT IF EXISTS unifi_mapping_site_fk;
ALTER TABLE unifi_site_mapping DROP COLUMN IF EXISTS site_id;

-- -----------------------------------------------------------------------------
-- topology_node sheds the sync's bookkeeping.
--
-- DROP COLUMN takes the constraints and indexes that mention only that column
-- with it — topology_node_mac_index_len and topology_node_device_uk go with
-- mac_blind_index, and topology_node_synced_has_identity goes with either of
-- the two columns it spans. They are named here anyway so this file reads as a
-- complete account of what 0570 built and what is left.
-- -----------------------------------------------------------------------------
ALTER TABLE topology_node DROP CONSTRAINT IF EXISTS topology_node_synced_has_identity;
ALTER TABLE topology_node DROP CONSTRAINT IF EXISTS topology_node_mac_index_len;
DROP INDEX IF EXISTS topology_node_device_uk;

ALTER TABLE topology_node DROP COLUMN IF EXISTS mac_blind_index;
ALTER TABLE topology_node DROP COLUMN IF EXISTS label_customised;
ALTER TABLE topology_node DROP COLUMN IF EXISTS device_type_customised;
ALTER TABLE topology_node DROP COLUMN IF EXISTS ip_address_customised;
ALTER TABLE topology_node DROP COLUMN IF EXISTS subnet_customised;
ALTER TABLE topology_node DROP COLUMN IF EXISTS source;

ALTER TABLE topology_link DROP COLUMN IF EXISTS source;

DROP TYPE IF EXISTS topology_source;

COMMENT ON TABLE topology_node IS
  'A box on a site network diagram, drawn by a person. Distinct from '
  'asset_link: this is physical or logical connectivity, not reliance.';
COMMENT ON TABLE topology_link IS
  'A line on a site network diagram, drawn by a person: physical or logical '
  'connectivity. NOT asset_link, which models reliance and impact.';

-- =============================================================================
-- Assertions
--
-- 0570 asserted that a sync could never move a box or overwrite an edit. Those
-- assertions were about a function that no longer exists, so they cannot carry
-- over. What replaces them is the statement that the machinery is GONE rather
-- than merely unused — a half-removed integration, where the columns survive
-- and something starts writing to them again, is the failure this guards.
-- =============================================================================
DO $assert$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(format('%s.%s', table_name, column_name), ', ' ORDER BY column_name)
    INTO v_left
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'topology_node'
          AND column_name IN ('mac_blind_index', 'source', 'label_customised',
                              'device_type_customised', 'ip_address_customised',
                              'subnet_customised'))
      OR (table_name = 'topology_link' AND column_name = 'source')
      OR (table_name = 'unifi_site_mapping' AND column_name = 'site_id'));

  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'helm: 0580 left sync columns behind: %', v_left;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'topology_source') THEN
    RAISE EXCEPTION 'helm: topology_source still exists';
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_left
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'helm' AND p.proname IN ('upsert_topology_node',
                                             'upsert_topology_link',
                                             'unifi_mapping_site_guard');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'helm: 0580 left sync functions behind: %', v_left;
  END IF;

  -- The drawing itself is untouched, and stays as protected as it was.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_left
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('topology_node', 'topology_link')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'helm: topology tables without forced RLS after 0580: %', v_left;
  END IF;

  SELECT string_agg(t.relname || ':' || t.cmds::text, ', ') INTO v_left
  FROM (
    SELECT c.relname, count(DISTINCT p.cmd) AS cmds
    FROM pg_class c
    LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = c.relname
    WHERE c.relname IN ('topology_node', 'topology_link')
    GROUP BY c.relname
  ) t
  WHERE t.cmds <> 4;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'helm: topology tables missing per-command policies: %', v_left;
  END IF;
END
$assert$;
