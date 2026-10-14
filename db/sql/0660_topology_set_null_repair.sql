-- =============================================================================
-- 0660 — the thirty-first constraint: topology_node loses only its asset
--
-- 0510 found that thirty composite ON DELETE SET NULL keys nulled tenant_id
-- along with the reference, because Postgres's bare `SET NULL` sets EVERY
-- referencing column and tenant_id is NOT NULL. It repaired all thirty with
-- Postgres 15's column list, and db/tests/security.sql §41(g) was written to
-- stop the next one.
--
-- topology_node arrived in 0570, after that sweep, with
--
--   FOREIGN KEY (asset_node_id, tenant_id) REFERENCES asset_node (id, tenant_id)
--     ON DELETE SET NULL
--
-- and §41(g) did not notice, because the assertion was blind. Postgres reports
-- pg_constraint.confdelsetcols as NULL — not '{}' — when no column list was
-- given, so `confdelsetcols = '{}'::int2[]` evaluated to NULL, the EXISTS came
-- back false, and the check reported ok. That is fixed in the same change as
-- this file; this is the defect it immediately found.
--
-- WHAT WAS ACTUALLY BROKEN, measured rather than inferred:
--
--   DELETE FROM asset_node WHERE id = <a device on a site drawing>
--   ERROR: null value in column "tenant_id" of relation "topology_node"
--          violates not-null constraint
--
-- So deleting any asset that appears in a topology drawing failed outright —
-- and helm.delete_organization ends by deleting all of a client's asset_node
-- rows, which means **a client with a drawing could not be purged**. That is
-- the same shape of defect F1 found in sop_version one migration earlier, from
-- a different direction: a feature added after the rail was built, which the
-- rail's own test could not see.
--
-- THE INTENT IS 0570'S, UNCHANGED. Its header is explicit that a drawing is
-- client data and survives on its own: a node whose asset is deleted keeps its
-- position and label and stops pointing at anything. `SET NULL (asset_node_id)`
-- is that sentence; the bare form was never what it meant.
--
-- WHY THE DURABLE CHECK IS NOT IN THIS FILE. A DO block here runs once, at this
-- point in the sequence, and cannot see a table created by a later migration —
-- which is precisely how 0570 slipped past 0200's end-of-file assertion and how
-- this constraint slipped past §41(g). The catalogue-wide sweep therefore lives
-- in the test suite, where it runs against the finished schema on every build,
-- and the guard below only asserts this repair.
-- =============================================================================
SET search_path = public, extensions;

ALTER TABLE topology_node DROP CONSTRAINT IF EXISTS topology_node_asset_fk;
ALTER TABLE topology_node
  ADD CONSTRAINT topology_node_asset_fk FOREIGN KEY (asset_node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE SET NULL (asset_node_id);

-- =============================================================================
-- Guards
-- =============================================================================
DO $topology_fk_guard$
DECLARE
  v_setcols int2[];
  v_bad     text;
BEGIN
  -- 1. THE REPAIR LANDED, and nulls one column rather than the whole key.
  SELECT c.confdelsetcols INTO v_setcols
  FROM pg_constraint c WHERE c.conname = 'topology_node_asset_fk';

  IF v_setcols IS NULL OR v_setcols = '{}'::int2[] THEN
    RAISE EXCEPTION 'helm: topology_node_asset_fk still nulls its whole key';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(v_setcols) k
    JOIN pg_attribute a ON a.attrelid = 'topology_node'::regclass AND a.attnum = k
    WHERE a.attname <> 'asset_node_id'
  ) THEN
    RAISE EXCEPTION 'helm: topology_node_asset_fk nulls a column other than asset_node_id';
  END IF;

  -- 2. AND NOTHING ELSE IN THE SCHEMA HAS THE SAME DEFECT RIGHT NOW. A sweep
  --    at this point in the sequence cannot see what a later migration adds —
  --    that is the test suite's job and the reason §41(g) exists — but it can
  --    say that the schema is clean as of here, which is what makes the fix
  --    above a completion of 0510 rather than one more patch.
  SELECT string_agg(c.conname, ', ' ORDER BY c.conname) INTO v_bad
  FROM pg_constraint c
  WHERE c.contype = 'f' AND c.confdeltype = 'n' AND array_length(c.conkey, 1) > 1
    AND EXISTS (
      SELECT 1 FROM unnest(c.conkey) k
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
      WHERE a.attnotnull
        AND (coalesce(c.confdelsetcols, '{}'::int2[]) = '{}'::int2[]
             OR k = ANY (c.confdelsetcols)));

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'helm: these composite SET NULL keys still null a NOT NULL column: %', v_bad;
  END IF;
END;
$topology_fk_guard$;
