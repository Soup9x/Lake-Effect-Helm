-- =============================================================================
-- 0510 — ON DELETE SET NULL was nulling tenant_id along with the reference
--
-- FOUND BY TRYING TO DELETE SOMETHING. 0500 added the first hard delete this
-- product has ever had, and the first client it was pointed at failed:
--
--   ERROR:  null value in column "tenant_id" of relation "ssl_certificate"
--           violates not-null constraint
--   CONTEXT: UPDATE ONLY "ssl_certificate"
--            SET "installed_on_node_id" = NULL, "tenant_id" = NULL
--            WHERE ... ; SQL statement "DELETE FROM asset_node ..."
--
-- Every cross-table reference in this schema is COMPOSITE and carries tenant_id
-- — that is what makes a foreign key incapable of pointing across a tenant
-- boundary, and it is one of the better decisions in the data model. But
-- `ON DELETE SET NULL` with no column list nulls EVERY column of the key, and
-- tenant_id is NOT NULL on all thirty tables that use one.
--
-- So the referential action was unreachable. Not "wrong in an edge case": any
-- attempt to delete a site, a vendor, a contact, a network, a device, a domain,
-- a secret or an asset node raised, because something somewhere holds an
-- optional reference to it. Thirty constraints, all with the same shape:
--
--   FOREIGN KEY (<nullable reference>, tenant_id)
--     REFERENCES <parent>(id, tenant_id) ON DELETE SET NULL
--
-- It never surfaced because nothing in the product deletes. Archiving hides a
-- row and deleted_at retires it; the SET NULL branch had simply never run.
--
-- THE FIX is the column list Postgres 15 added: `ON DELETE SET NULL (col)`
-- nulls the reference and leaves the tenant alone, which is what every one of
-- these constraints meant when it was written.
--
-- DRIVEN FROM THE CATALOGUE rather than thirty hand-written statements. The
-- shape is uniform and a typo in one of thirty would be invisible — the whole
-- reason this was only noticed by executing it. The loop finds every composite
-- SET NULL foreign key whose key includes a NOT NULL column, and rebuilds it
-- nulling only the columns that can actually hold NULL.
--
-- LOCKING. Each constraint is dropped and re-added NOT VALID, then validated
-- separately: ADD CONSTRAINT ... NOT VALID takes a brief ACCESS EXCLUSIVE lock
-- and VALIDATE takes only SHARE UPDATE EXCLUSIVE, so a large table is not read
-- under an exclusive lock. The existing data already satisfies the constraint —
-- only the referential ACTION changes — so validation finds nothing.
-- =============================================================================
SET search_path = public, extensions;

DO $set_null_repair$
DECLARE
  r            record;
  v_nullable   text;
  v_fixed      integer := 0;
BEGIN
  FOR r IN
    SELECT c.oid, c.conname, t.relname AS child, p.relname AS parent,
           c.conkey, c.confkey, c.conrelid, c.confrelid,
           pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_class p ON p.oid = c.confrelid
    WHERE c.contype = 'f'
      AND c.confdeltype = 'n'                     -- ON DELETE SET NULL
      AND array_length(c.conkey, 1) > 1           -- composite
      -- ...and at least one column of the key cannot hold NULL, which is what
      -- makes the action unreachable.
      AND EXISTS (
        SELECT 1 FROM unnest(c.conkey) k
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
        WHERE a.attnotnull
      )
    ORDER BY t.relname, c.conname
  LOOP
    -- Only the columns that may actually be nulled. For every constraint in
    -- this schema that is exactly the reference, with tenant_id left out.
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
      INTO v_nullable
    FROM unnest(r.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = r.conrelid AND a.attnum = k.attnum
    WHERE NOT a.attnotnull;

    IF v_nullable IS NULL THEN
      -- Every column of the key is NOT NULL: SET NULL can never be satisfied
      -- and the constraint is asking for something impossible. Louder than a
      -- silent skip, because it cannot be repaired by this file.
      RAISE EXCEPTION
        'helm: % on % has no nullable column and cannot use ON DELETE SET NULL',
        r.conname, r.child;
    END IF;

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.child, r.conname);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I %s ON DELETE SET NULL (%s) NOT VALID',
      r.child, r.conname,
      -- The definition up to the action, reused verbatim: the column list, the
      -- parent, and any ON UPDATE clause are whatever they already were.
      regexp_replace(r.def, '\s+ON DELETE SET NULL\s*$', ''),
      v_nullable);
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', r.child, r.conname);

    v_fixed := v_fixed + 1;
  END LOOP;

  RAISE NOTICE 'helm: repaired % composite ON DELETE SET NULL constraints', v_fixed;
END;
$set_null_repair$;

-- =============================================================================
-- Guards
-- =============================================================================
DO $set_null_guard$
DECLARE
  v_bad text;
BEGIN
  -- 1. NONE LEFT. The same catalogue query the repair ran on; if it still finds
  --    one, the rewrite did not take and hard deletion is still broken.
  SELECT string_agg(t.relname || '.' || c.conname, ', ') INTO v_bad
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE c.contype = 'f' AND c.confdeltype = 'n'
    AND array_length(c.conkey, 1) > 1
    AND EXISTS (
      SELECT 1 FROM unnest(c.conkey) k
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
      WHERE a.attnotnull
        -- A column named in the SET NULL list is one the action will null.
        -- confdelsetcols is empty when the action covers the whole key.
        AND (c.confdelsetcols = '{}'::int2[] OR k = ANY (c.confdelsetcols))
    );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'helm: these SET NULL foreign keys still null a NOT NULL column: %', v_bad;
  END IF;

  -- 2. EVERY ONE STILL CARRIES tenant_id IN ITS KEY. The repair rewrites thirty
  --    constraints; dropping the tenant column from one of them would make a
  --    cross-tenant reference representable, which is the thing composite keys
  --    exist here to prevent.
  SELECT string_agg(t.relname || '.' || c.conname, ', ') INTO v_bad
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE c.contype = 'f' AND c.confdeltype = 'n'
    AND array_length(c.conkey, 1) > 1
    AND NOT EXISTS (
      SELECT 1 FROM unnest(c.conkey) k
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
      WHERE a.attname = 'tenant_id'
    );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'helm: these composite foreign keys lost tenant_id: %', v_bad;
  END IF;

  -- 3. ALL THIRTY ARE VALIDATED, not left NOT VALID. A constraint that is never
  --    validated is not enforced for existing rows and reads as enforced.
  SELECT string_agg(t.relname || '.' || c.conname, ', ') INTO v_bad
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
  WHERE c.contype = 'f' AND NOT c.convalidated;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'helm: these foreign keys were left NOT VALID: %', v_bad;
  END IF;
END;
$set_null_guard$;
