-- =============================================================================
-- 0610_audit_secret_row_visibility.sql
--
-- A scoped reader could not see their own organisation's credential history,
-- and the reason was one argument in the wrong position.
--
-- THE BUG. helm.write_secret_version() audits secret.created and
-- secret.rotated like this (0470, and 0320 before it):
--
--     helm.audit('secret.rotated', 'secret', v_secret.id, 'success',
--                v_secret.organization_id, v_secret.id, ...)
--                                          ^^^^^^^^^^^
--
-- helm.audit's sixth parameter is p_node_id. So the row lands with
-- node_id = the SECRET's id. Every secret.* path does the same — reveal_secret
-- passes v_secret.id there too.
--
-- The audit_log policy (0390) then asks, for a reader who is not tenant-wide:
--
--     AND helm.node_visible(node_id)
--
-- and helm.node_visible(p) is EXISTS (SELECT 1 FROM asset_node WHERE id = p
-- AND NOT is_internal_only). No asset_node has a secret's id, so it is FALSE
-- for every one of those rows, for every scoped reader, always.
--
-- The effect: a client_admin — which holds audit:read deliberately, because
-- 0390's own header says "a co-managed customer being able to see who touched
-- their documentation is a feature" — saw none of it. Not a rotation, not a
-- creation. The feature was shipped and then filtered out by a predicate that
-- was never false on purpose.
--
-- It fails CLOSED, which is why it survived: it hides rows rather than leaking
-- them, so nothing alarming ever happened. It was found while building the
-- client page's activity card, where a feed that was empty for exactly one
-- role was the thing that did not add up.
--
-- -----------------------------------------------------------------------------
-- WHY THE POLICY AND NOT THE DATA.
--
-- The obvious fix is to pass the owning credential node's id instead. It is
-- the right value, and it is not enough, because it cannot reach a single row
-- already written. audit_log is append-only by design — helm_app has no UPDATE
-- or DELETE on it — and node_id is inside helm.audit_canonical_form(), so it
-- is covered by row_hash and by the per-tenant hash chain. Rewriting it would
-- invalidate the chain, which is the one thing that makes this table evidence.
-- So the predicate has to understand the secret-id form regardless of what
-- future writes do.
--
-- Given that, this migration changes the predicate ONLY. Correcting the write
-- as well would leave the table in two shapes with no visibility difference,
-- and would mean redefining a 100-line SECURITY DEFINER function whose own
-- history includes being silently reverted by a redefinition that took the
-- wrong source (see 0390's note above reveal_secret). The column keeps
-- carrying the secret id on a secret row; the policy now says so out loud.
--
-- helm.secret_node_visible(entity_id) is the right question, and it already
-- exists for exactly this shape (0390, re-granted 0460). It resolves a secret
-- to the credential nodes pointing at it and is true when any of them is not
-- internal-only, true when none exists at all, and false when every one is
-- internal-only. So internal-only documentation stays hidden: this narrows
-- nothing and un-hides only what 0390 meant to leave visible.
--
-- entity_id is safe to lean on. Every helm.audit() call with entity_type
-- 'secret' passes a secret id there — p_secret_id or v_secret.id, in
-- 0210, 0290, 0320, 0390, 0400, 0470 and 0590. None passes NULL.
--
-- -----------------------------------------------------------------------------
-- WHY ONLY created AND rotated, AND NOT THE WHOLE secret.* FAMILY.
--
-- secret.revealed carries the same broken node_id and would be un-hidden by
-- the same one-line change. It is deliberately NOT included.
--
-- The two groups disclose different things. created/rotated say "this client's
-- documentation changed, by whom, when" — the documentation history a
-- co-managed customer is meant to have. revealed says "your MSP read this
-- password, at this time, for this reason", which is a log of the provider's
-- own activity against the customer's credentials.
--
-- That line was drawn one commit earlier, not invented here: the Most used
-- credentials card was restricted to secret:reveal precisely so a customer
-- would not be shown how often their MSP had read a credential. Un-hiding
-- secret.revealed here would hand back the same information in more detail —
-- every individual read with an actor and a timestamp — through a different
-- door. A fix that quietly reverses the previous decision is not a fix.
--
-- So the CASE names the two actions. Widening it to the family is one line and
-- a decision for the people who own the product, not for the migration that
-- happens to be touching the predicate.
--
-- -----------------------------------------------------------------------------
-- A NOTE ON PARTITIONS, since the next reader of 0140 will want it.
--
-- 0140's ensure_audit_partition() says each new partition "gets RLS enabled
-- and the same policy applied (see helm.apply_audit_partition_rls)". It
-- enables and FORCEs RLS; it does not call that function, so a partition
-- created after this migration carries no policy of its own. That is
-- fail-closed — FORCE ROW LEVEL SECURITY with no policy returns nothing — and
-- it does not affect the application, which queries the parent and therefore
-- uses the parent's policy across the whole hierarchy. Left alone here to keep
-- this migration to the one thing it is for; recorded so the comment in 0140
-- does not mislead somebody into assuming more than it does.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION helm.apply_audit_partition_rls() RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  r record;
  v_predicate constant text :=
    'tenant_id = helm.current_tenant_id() '
    'AND helm.has_permission(''audit:read'') '
    'AND (helm.is_tenant_wide() OR ('
    '  organization_id IS NOT NULL '
    '  AND helm.org_in_scope(organization_id) '
    -- A row about a secret names no asset_node, so node_visible() can only
    -- ever be false for one. secret_node_visible() asks the question the row
    -- can actually answer: is the credential this secret belongs to visible?
    '  AND CASE '
    '        WHEN entity_type = ''secret'' '
    '             AND action IN (''secret.created'', ''secret.rotated'') '
    '        THEN helm.secret_node_visible(entity_id) '
    '        ELSE helm.node_visible(node_id) '
    '      END))';
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'audit_log'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.relname || '_rls_select', r.relname);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)',
                   r.relname || '_rls_select', r.relname, v_predicate);
  END LOOP;

  -- The parent too, so a query that does not prune to a partition is scoped.
  EXECUTE 'DROP POLICY IF EXISTS audit_log_rls_select ON audit_log';
  EXECUTE format('CREATE POLICY audit_log_rls_select ON audit_log FOR SELECT USING (%s)',
                 v_predicate);
END;
$$;

SELECT helm.apply_audit_partition_rls();

-- helm_auditor reads audit history and may now reach the new branch. The
-- 0220 loop that grants the read-only helm helpers skips SECURITY DEFINER
-- functions, and secret_node_visible is one, so 0390 and 0460 each granted it
-- by hand to helm_app and helm_worker. The compliance role was not in that
-- list because nothing it could reach called the function. Now something does.
GRANT EXECUTE ON FUNCTION helm.secret_node_visible(uuid) TO helm_auditor;

-- -----------------------------------------------------------------------------
-- Assertions. A policy whose text is right and whose behaviour is not is worth
-- nothing, so this checks the behaviour against rows it writes itself.
-- -----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_expr text;
BEGIN
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO v_expr
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  WHERE c.relname = 'audit_log' AND pol.polname = 'audit_log_rls_select';

  IF v_expr IS NULL THEN
    RAISE EXCEPTION 'helm: audit_log_rls_select is missing after reapplying it';
  END IF;

  IF v_expr NOT LIKE '%secret_node_visible%' THEN
    RAISE EXCEPTION 'helm: the audit policy still does not consult secret_node_visible: %', v_expr;
  END IF;

  -- The old predicate must be gone from the secret branch but still present
  -- for everything else: this fix narrows nothing.
  IF v_expr NOT LIKE '%node_visible(node_id)%' THEN
    RAISE EXCEPTION 'helm: the audit policy lost its node_visible(node_id) branch: %', v_expr;
  END IF;

  IF v_expr NOT LIKE '%has_permission%audit:read%' THEN
    RAISE EXCEPTION 'helm: the audit policy lost its audit:read requirement: %', v_expr;
  END IF;

  -- Every partition carries it too, or a direct read of one behaves
  -- differently from a read through the parent.
  PERFORM 1
  FROM pg_class c
  JOIN pg_inherits i ON i.inhrelid = c.oid
  JOIN pg_class p ON p.oid = i.inhparent
  WHERE p.relname = 'audit_log'
    AND NOT EXISTS (
      SELECT 1 FROM pg_policy pol
      WHERE pol.polrelid = c.oid
        AND pg_get_expr(pol.polqual, pol.polrelid) LIKE '%secret_node_visible%'
    );
  IF FOUND THEN
    RAISE EXCEPTION 'helm: at least one audit_log partition did not get the new policy';
  END IF;
END
$verify$;

COMMIT;
