-- =============================================================================
-- 0640 — sop_version joins the purge path, and a client with a checklist can be
--        deleted again
--
-- F1 gave the application a way to publish a procedure, and immediately hit the
-- wall 0520 hit from the other side:
--
--   ERROR: helm: DELETE on sop_version is not permitted; this table is
--          append-only
--
-- helm.delete_organization ends by deleting the client's asset_node rows, which
-- cascades to `sop` and then to `sop_version`. That table carries
-- helm.deny_mutation(), which refuses UPDATE and DELETE outright — so purging a
-- client failed with a 403 naming an internal table.
--
-- WHY THIS WAS INVISIBLE UNTIL NOW. 0090 modelled sop_version from the
-- beginning and nothing in the application ever wrote a row, so outside a test
-- fixture the cascade never reached one. 0520's own header names this table in
-- its list of things it was deliberately leaving alone, which was the right
-- call at the time: there was nothing to leave alone. F1 ships publishing, so
-- the conflict is live — publish one checklist for a client and that client can
-- never be deleted.
--
-- WHAT 0520 ALREADY DECIDED, AND WHAT THIS CHANGES. 0520 built the mechanism
-- for exactly this situation and applied it to secret_version:
-- helm.deny_mutation_unless_purging(), with two locks that must both hold —
--
--   1. helm.purging = 'on', set with SET LOCAL inside the delete functions, so
--      it cannot outlive the transaction that set it;
--   2. the caller owns the table, which helm_app does not. The delete functions
--      are SECURITY DEFINER owned by the role that does.
--
-- Neither lock alone is enough and the reasoning is 0520's, unchanged: helm_app
-- can call set_config() itself, so the GUC alone would let the request role
-- delete history directly, and ownership alone would let any future SECURITY
-- DEFINER function do it by accident.
--
-- 0520 also wrote a guard asserting that this exemption must not spread:
--
--   "AND SO ARE THE OTHER APPEND-ONLY TABLES. Only secret_version was meant to
--    become purgeable."
--
-- That guard runs at 0520's point in the sequence, so this file would not trip
-- it. Stepping around it quietly is the thing that should not happen, so the
-- guard is RE-STATED at the bottom of this file with the new allowed set, and
-- the intent is amended in the open: two tables may be purged, and the reason
-- the second one joins is written above.
--
-- WHAT IS NOT EXEMPTED, which is most of it:
--
--   audit_log                      keeps the unexempted deny_mutation(). The
--                                  immutability of the audit trail is the
--                                  entire reason permanent deletion is
--                                  defensible — a client's documentation can be
--                                  destroyed precisely because the record of
--                                  what was done to it cannot be.
--   flexible_asset_type_version    unchanged. Types are tenant-scoped, so a
--                                  client purge never reaches one.
--   deleting ONE published procedure  still impossible, and deliberately so.
--                                  The exemption fires only inside a purge, so
--                                  DELETE on a single sop_version — or on the
--                                  sop node above it — is refused exactly as
--                                  before. A procedure is archived, not
--                                  deleted; a client is purged, and that takes
--                                  everything.
--   UPDATE on sop_version          still refused outright. The exemption is for
--                                  removal, never for rewriting a published
--                                  version in place, which is the property runs
--                                  depend on.
--
-- THE ORDER OF DELETES MATTERS, and was measured rather than reasoned about.
-- Exempting the trigger alone is not enough: sop_run.sop_id is ON DELETE
-- RESTRICT, so with the trigger permitting the version delete the cascade then
-- fails with
--
--   update or delete on table "sop" violates foreign key constraint
--   "sop_run_sop_fk" on table "sop_run"
--
-- A client's runs therefore go first (sop_run_step follows by cascade), then
-- their published versions inside the purge window, and only then the nodes.
-- =============================================================================
SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- The trigger. helm.deny_mutation_unless_purging() is 0520's function, used
-- here unchanged — no new mechanism, no second copy of the two locks.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS sop_version_append_only ON sop_version;
CREATE TRIGGER sop_version_append_only
  BEFORE UPDATE OR DELETE ON sop_version
  FOR EACH ROW EXECUTE FUNCTION helm.deny_mutation_unless_purging();

-- -----------------------------------------------------------------------------
-- helm.delete_organization, reissued. 0520's body with three statements added
-- before the node delete; everything else is byte-for-byte what was there.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.delete_organization(p_organization_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_org     organization%ROWTYPE;
  v_counts  jsonb;
BEGIN
  SELECT * INTO v_org FROM organization
  WHERE id = p_organization_id AND tenant_id = v_tenant;

  IF NOT FOUND OR NOT helm.org_in_scope(p_organization_id) THEN
    RAISE EXCEPTION 'helm: client % not found', p_organization_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT helm.has_permission('organization:delete') THEN
    PERFORM helm.audit('organization.delete_denied', 'organization', p_organization_id,
                       'denied'::audit_outcome, p_organization_id, NULL, NULL,
                       jsonb_build_object('cause', 'missing_permission'));
    RAISE EXCEPTION 'helm: organization:delete is required to delete a client'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_org.archived_at IS NULL THEN
    RAISE EXCEPTION 'helm: % must be archived before it can be deleted', v_org.name
      USING ERRCODE = 'check_violation', DETAIL = 'archive_first';
  END IF;

  -- `checklist_runs` is new in this count. The confirmation dialog quotes these
  -- numbers back before anything is destroyed, and "and 14 completed checklist
  -- runs" is exactly the kind of thing somebody should be told they are about
  -- to lose. Measured before any delete, like the rest.
  SELECT jsonb_build_object(
    'assets',         (SELECT count(*) FROM asset_node WHERE organization_id = p_organization_id),
    'secrets',        (SELECT count(*) FROM secret     WHERE organization_id = p_organization_id),
    'sites',          (SELECT count(*) FROM site       WHERE organization_id = p_organization_id),
    'contacts',       (SELECT count(*) FROM contact    WHERE organization_id = p_organization_id),
    'notes',          (SELECT count(*) FROM note       WHERE organization_id = p_organization_id),
    'attachments',    (SELECT count(*) FROM attachment WHERE organization_id = p_organization_id),
    'checklist_runs', (SELECT count(*) FROM sop_run    WHERE organization_id = p_organization_id)
  ) INTO v_counts;

  PERFORM helm.audit('organization.deleted', 'organization', p_organization_id,
                     'success'::audit_outcome, p_organization_id, NULL, NULL,
                     v_counts || jsonb_build_object('name', v_org.name, 'slug', v_org.slug));

  -- Runs first. sop_run.sop_id is ON DELETE RESTRICT, so a procedure with a run
  -- against it cannot be removed while the run exists — and the run is this
  -- client's, so it goes with them. sop_run_step follows by cascade.
  DELETE FROM sop_run WHERE organization_id = p_organization_id;

  -- Then the published versions, inside their own window. Narrow on purpose:
  -- the only sop_version rows reachable here are those of procedures belonging
  -- to the client being purged.
  PERFORM set_config('helm.purging', 'on', true);
  DELETE FROM sop_version
   WHERE sop_id IN (SELECT id FROM asset_node
                     WHERE organization_id = p_organization_id AND node_type = 'sop');
  PERFORM set_config('helm.purging', 'off', true);

  DELETE FROM asset_node WHERE organization_id = p_organization_id;
  DELETE FROM unifi_site_mapping WHERE organization_id = p_organization_id;

  -- Transaction-local, and lowered again immediately: the window in which
  -- credential history can be removed is exactly these two statements.
  PERFORM set_config('helm.purging', 'on', true);
  DELETE FROM secret_version
   WHERE secret_id IN (SELECT id FROM secret WHERE organization_id = p_organization_id);
  DELETE FROM secret WHERE organization_id = p_organization_id;
  PERFORM set_config('helm.purging', 'off', true);

  DELETE FROM organization WHERE id = p_organization_id;

  RETURN v_counts;
END;
$$;

-- =============================================================================
-- Guards
-- =============================================================================
DO $sop_purge_guard$
DECLARE
  v_fn  text := (SELECT pg_get_functiondef('helm.deny_mutation_unless_purging()'::regprocedure));
  v_org text := (SELECT pg_get_functiondef('helm.delete_organization(uuid)'::regprocedure));
  v_bad text;
BEGIN
  -- 1. THE AUDIT LOG IS STILL UNTOUCHED. 0520 asserted this and it is asserted
  --    again, because this file is the first thing to widen the exemption and
  --    the next one will copy whichever file it reads.
  IF EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal
      AND c.relname LIKE 'audit_log%'
      AND t.tgname = 'audit_log_immutable'
      AND t.tgfoid <> 'helm.deny_mutation()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'helm: an audit_log trigger no longer uses the unexempted deny_mutation()';
  END IF;

  -- 2. THE EXEMPTION REACHES EXACTLY TWO TABLES. This REPLACES 0520's "only
  --    secret_version was meant to become purgeable" — see the header. A third
  --    table joining this list is a decision, not a detail, so it fails here
  --    until somebody writes the next migration and says why.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_bad
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE NOT t.tgisinternal
    AND t.tgfoid = 'helm.deny_mutation_unless_purging()'::regprocedure
    AND c.relname NOT IN ('secret_version', 'sop_version');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'helm: the purge exemption has spread to %', v_bad;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relname = 'sop_version'
      AND t.tgfoid = 'helm.deny_mutation_unless_purging()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'helm: sop_version did not pick up the purge exemption';
  END IF;

  -- 3. BOTH LOCKS, AND DELETE ONLY. 0520's three assertions about the shared
  --    function, repeated because this file now depends on them too: a later
  --    edit that loosened the function would widen two tables at once.
  IF v_fn !~ 'helm\.purging' THEN
    RAISE EXCEPTION 'helm: the purge exemption no longer requires the helm.purging flag';
  END IF;
  IF v_fn !~ 'pg_has_role' THEN
    RAISE EXCEPTION 'helm: the purge exemption no longer requires table ownership';
  END IF;
  IF v_fn !~ 'TG_OP = ''DELETE''' THEN
    RAISE EXCEPTION 'helm: the purge exemption is not limited to DELETE';
  END IF;

  -- 4. THE PURGE WINDOW IS STILL LOWERED. A function that raises the flag and
  --    never lowers it leaves every subsequent statement in that transaction
  --    able to delete history, which is the opposite of what SET LOCAL is for.
  IF (length(v_org) - length(replace(v_org, '''helm.purging'', ''on''', '')))
     / length('''helm.purging'', ''on''')
     <> (length(v_org) - length(replace(v_org, '''helm.purging'', ''off''', '')))
     / length('''helm.purging'', ''off''') THEN
    RAISE EXCEPTION 'helm: delete_organization raises the purge flag more often than it lowers it';
  END IF;

  -- 5. THE RUNS GO BEFORE THE NODES. sop_run.sop_id is ON DELETE RESTRICT, so
  --    this ordering is what makes the purge work at all; a reissue that lost
  --    it would fail only for a client that had actually followed a checklist.
  IF position('DELETE FROM sop_run WHERE organization_id' in v_org) = 0
     OR position('DELETE FROM sop_run WHERE organization_id' in v_org)
        > position('DELETE FROM asset_node WHERE organization_id' in v_org) THEN
    RAISE EXCEPTION 'helm: delete_organization must remove a client''s runs before their nodes';
  END IF;
END;
$sop_purge_guard$;
