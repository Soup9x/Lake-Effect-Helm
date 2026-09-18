-- =============================================================================
-- 0440 — one notes field per item
--
-- WHY THIS IS A SEPARATE FILE AND NOT AN EDIT TO 0370
--
-- It was an edit to 0370 for a while, which was wrong. 0370 had already been
-- applied, and helm_migration stores a sha256 over the whole file — so editing
-- it in place turned every subsequent `pnpm db:migrate` into a hard failure on
-- any environment that had already run it, while leaving environments that had
-- not silently different from the ones that had. 0370 is now byte-identical to
-- what was applied, and its intent lives here.
--
-- WHAT THE INTENT WAS
--
-- credential.notes has existed since 0070, and a credential is an asset_node
-- with a subtype row — so asset_node.notes (added by 0370) gave a credential
-- TWO notes fields: the one the interface edits and the one the offboarding
-- export reads. Somebody types a note against a credential, the client's export
-- does not contain it, and nothing anywhere reports a problem. That is a worse
-- outcome than either field alone.
--
-- asset_node.notes wins because it is the field that means the same thing for
-- every asset. The content moves across first, then the duplicate goes.
--
-- WHERE THIS DELIBERATELY DIFFERS FROM THE EDIT IT REPLACES
--
-- The edit did `SET notes = c.notes ... WHERE c.notes IS NOT NULL`, which is
-- correct on a fresh build — asset_node.notes is created three statements
-- earlier and is entirely NULL — and DESTRUCTIVE on an environment that has
-- been running 0370 for months, where somebody may have written an asset_node
-- note on a credential already. Here the copy only fills a gap, and anything
-- that would have been overwritten is counted and reported rather than dropped
-- in silence.
-- =============================================================================
SET search_path = public, extensions;

DO $notes_consolidation$
DECLARE
  v_moved     bigint;
  v_conflicts bigint;
BEGIN
  -- Idempotent by construction: on a database where this already ran (or which
  -- ran the edited 0370 before it was reverted) the column is gone and there is
  -- nothing to do.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'credential' AND a.attname = 'notes'
      AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE NOTICE 'helm: credential.notes is already gone; nothing to consolidate';
    RETURN;
  END IF;

  -- Say out loud what is about to be lost, if anything. Both fields populated
  -- and disagreeing is the only case where this migration is not information-
  -- preserving, and an operator should hear about it at deploy time rather than
  -- discover it in an export six weeks later.
  SELECT count(*) INTO v_conflicts
  FROM asset_node n JOIN credential c ON c.id = n.id
  WHERE c.notes IS NOT NULL AND n.notes IS NOT NULL
    AND btrim(c.notes) <> btrim(n.notes);

  IF v_conflicts > 0 THEN
    RAISE WARNING 'helm: % credential(s) have notes in BOTH fields with different text; '
                  'the asset_node value is kept and the credential value is dropped',
                  v_conflicts;
  END IF;

  UPDATE asset_node n
     SET notes = c.notes
    FROM credential c
   WHERE c.id = n.id
     AND c.notes IS NOT NULL
     AND n.notes IS NULL;
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  RAISE NOTICE 'helm: moved % credential note(s) onto asset_node', v_moved;

  -- The CHECK went on in 0370 and comes off with the column it constrains.
  -- IF EXISTS because a database that never ran 0370's constraint statement
  -- (there is no such database today, but there is no reason to depend on that)
  -- must not fail here.
  ALTER TABLE credential DROP CONSTRAINT IF EXISTS credential_notes_length;
  ALTER TABLE credential DROP COLUMN notes;
END;
$notes_consolidation$;

-- -----------------------------------------------------------------------------
-- record_view stamps clock_timestamp(), not now().
--
-- now() is the TRANSACTION's start time, so two things opened inside one
-- transaction get identical timestamps and the recent list orders them
-- arbitrarily. One page render is one transaction today, which is why this looks
-- like it does not matter — and is exactly why it would be found by somebody
-- wondering why their recent list was in the wrong order, rather than by a test.
--
-- The body below is the live definition as 0370 left it, transformed by
-- substituting one function name. It was NOT retyped: rebuilding a routine from
-- memory has broken this project three times, and the rule since 0400 is to
-- transform what the database actually has.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_view(p_organization_id uuid DEFAULT NULL::uuid, p_node_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'helm', 'extensions', 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
  v_keep   constant integer := 50;
BEGIN
  IF v_actor IS NULL THEN RETURN; END IF;
  IF num_nonnulls(p_organization_id, p_node_id) <> 1 THEN
    RAISE EXCEPTION 'helm: record_view takes exactly one of organization_id, node_id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A service account has no recent list; it is not a person browsing.
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = v_actor) THEN RETURN; END IF;

  IF p_organization_id IS NOT NULL THEN
    INSERT INTO user_recent_view (tenant_id, user_id, organization_id, viewed_at)
    VALUES (v_tenant, v_actor, p_organization_id, clock_timestamp())
    ON CONFLICT (tenant_id, user_id, organization_id)
      WHERE organization_id IS NOT NULL
      DO UPDATE SET viewed_at = clock_timestamp();
  ELSE
    INSERT INTO user_recent_view (tenant_id, user_id, node_id, viewed_at)
    VALUES (v_tenant, v_actor, p_node_id, clock_timestamp())
    ON CONFLICT (tenant_id, user_id, node_id)
      WHERE node_id IS NOT NULL
      DO UPDATE SET viewed_at = clock_timestamp();
  END IF;

  DELETE FROM user_recent_view r
  WHERE r.tenant_id = v_tenant AND r.user_id = v_actor
    AND r.viewed_at < (
      SELECT min(keep.viewed_at) FROM (
        SELECT k.viewed_at FROM user_recent_view k
        WHERE k.tenant_id = v_tenant AND k.user_id = v_actor
        ORDER BY k.viewed_at DESC LIMIT v_keep
      ) keep
    );
END;
$function$;

-- =============================================================================
-- Guards
-- =============================================================================
DO $notes_guard$
BEGIN
  -- There must be exactly one notes field per item. A future migration
  -- re-adding credential.notes would silently split the field in two again,
  -- with the interface writing one and the export reading the other.
  IF EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'credential' AND a.attname = 'notes'
      AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'helm: notes on a credential belong to asset_node, not to credential';
  END IF;

  -- ...and the ordering fix is actually in the body, not just in this file.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'record_view')
     LIKE '%viewed_at = now()%' THEN
    RAISE EXCEPTION 'helm: record_view is stamping transaction time again';
  END IF;
END;
$notes_guard$;
