-- =============================================================================
-- 0480 — per-user permission grants become manageable, and stop being a
--        privilege-escalation route
--
-- membership_permission is the per-person override on top of a role's
-- permissions: set_session_context() unions the role's grants with it and
-- subtracts its denies, honouring expires_at. That half has always worked.
--
-- The table had a SELECT policy and an INSERT policy. Nothing else. Measured on
-- a live cluster before writing any of this, as helm_app under a real session
-- context:
--
--   DELETE FROM membership_permission WHERE ...   →  0 rows. No error.
--   UPDATE membership_permission SET granted=false →  0 rows. No error.
--
-- Silently. A grant, once written, could not be revoked, expired or corrected
-- through the request path at all — and a revoke button built over that would
-- have reported success while changing nothing, which is the worst available
-- outcome for a control whose entire job is taking access away.
--
-- Two more holes surfaced while building the write path, both of which would
-- have become one-click operations the moment a grant UI shipped. Neither was
-- theoretical; both are reproduced in db/tests/security.sql.
--
-- 1. SELF-ESCALATION. `membership`'s writes are guarded by 0350, which refuses
--    to grant a role ranking above the actor's own — its header argues that the
--    rule belongs beside the policies rather than in the API, "so it holds for
--    every writer". membership_permission had no equivalent. tier3 holds
--    user:write and rank 80 and does NOT hold tenant:write; it could write
--    itself a tenant:write grant here and the next session context handed it
--    over. Measured:
--
--      acting as tier3 → INSERT ... 'tenant:write', granted → accepted
--      next set_session_context() → permissions include "tenant:write"
--
--    tenant:write is the gate on editing the tenant. This was 0350's hole,
--    reopened through the other table.
--
-- 2. MSP-ONLY PERMISSIONS REACHING CLIENT-SIDE USERS. `permission.msp_only`
--    marks the fifteen permissions no co-managed customer may hold, and a
--    trigger on role_permission (0020) enforces it. membership_permission had
--    no such trigger, and the union in set_session_context() does not care
--    which table a grant came from. Measured: secret:export — msp_only,
--    rank-agnostic, and the thing that turns an export request into a file full
--    of another client's credentials — pinned directly to a client_admin user
--    and honoured in full.
--
--    That is the precondition for the export escalation fixed alongside this
--    work, and the only route by which it was reachable: the ROLE grant is
--    refused by 0020, the USER grant was not refused by anything.
--
-- WHICH PERMISSION GOVERNS THIS TABLE: tenant:write, raised from user:write.
--
-- Deliberate, and a narrowing. user:write is "manage the people in this
-- tenant" — invite somebody, change their role, end their membership. Writing
-- a per-user permission override is a different act: it changes what the
-- role catalogue MEANS for one person, which is a change to the authority
-- model rather than to a person's job. That belongs with editing the tenant.
--
-- In the shipped catalogue tenant:write is held by super_admin alone, so this
-- confines per-user grants to rank 100. Nothing regresses by tightening it:
-- there has never been an application write path to this table, so the only
-- writers are out-of-band ones RLS does not apply to.
--
-- The triggers below do NOT depend on that choice. If a deployment ever adds a
-- custom role holding tenant:write, the escalation and msp_only rules still
-- hold, because they are beside the data rather than in the policy.
-- =============================================================================
SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Policies. INSERT is replaced rather than left alongside: two permissive
-- INSERT policies OR together, so leaving the user:write one in place would
-- have made the new gate decorative.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS membership_permission_rls_write   ON membership_permission;
DROP POLICY IF EXISTS membership_permission_rls_insert  ON membership_permission;
DROP POLICY IF EXISTS membership_permission_rls_update  ON membership_permission;
DROP POLICY IF EXISTS membership_permission_rls_delete  ON membership_permission;

CREATE POLICY membership_permission_rls_insert ON membership_permission FOR INSERT
  WITH CHECK (helm.has_permission('tenant:write')
              AND EXISTS (SELECT 1 FROM membership m
                          WHERE m.id = membership_permission.membership_id
                            AND m.tenant_id = helm.require_tenant_id()));

-- USING and WITH CHECK both, and they are not the same question: USING says
-- which rows may be touched, WITH CHECK says what they may become. Without the
-- second, an UPDATE could move a grant onto a membership in another tenant.
CREATE POLICY membership_permission_rls_update ON membership_permission FOR UPDATE
  USING (helm.has_permission('tenant:write')
         AND EXISTS (SELECT 1 FROM membership m
                     WHERE m.id = membership_permission.membership_id
                       AND m.tenant_id = helm.require_tenant_id()))
  WITH CHECK (helm.has_permission('tenant:write')
              AND EXISTS (SELECT 1 FROM membership m
                          WHERE m.id = membership_permission.membership_id
                            AND m.tenant_id = helm.require_tenant_id()));

-- Revocation is gated exactly as granting is, rather than more loosely.
-- Letting a lower role revoke what it could not grant sounds harmless — you
-- can always take access away — but it hands anyone with the lesser permission
-- a way to strip an administrator's overrides.
CREATE POLICY membership_permission_rls_delete ON membership_permission FOR DELETE
  USING (helm.has_permission('tenant:write')
         AND EXISTS (SELECT 1 FROM membership m
                     WHERE m.id = membership_permission.membership_id
                       AND m.tenant_id = helm.require_tenant_id()));

-- -----------------------------------------------------------------------------
-- helm.enforce_membership_permission_authority — the two rules the policies
-- cannot express, beside the data so they hold for every writer.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.enforce_membership_permission_authority() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_msp_only    boolean;
  v_role_key    text;
  v_tenant_wide boolean;
  v_permissions text;
BEGIN
  -- A DENY is not an escalation and cannot become one: it only ever subtracts.
  -- Both rules below are about handing authority over, so both are scoped to
  -- grants. Refusing a deny would mean an administrator could not withdraw a
  -- permission they are not themselves allowed to hand out, which is backwards.
  IF NOT NEW.granted THEN
    RETURN NEW;
  END IF;

  SELECT p.msp_only INTO v_msp_only
  FROM permission p WHERE p.key = NEW.permission_key;

  SELECT m.role_key, r.is_tenant_wide INTO v_role_key, v_tenant_wide
  FROM membership m JOIN app_role r ON r.key = m.role_key
  WHERE m.id = NEW.membership_id;

  -- 1. MSP-ONLY STAYS MSP-ONLY, whichever table the grant is written to. The
  --    same rule 0020 enforces on role_permission; a per-user override is not
  --    a loophole in it.
  IF v_msp_only AND v_tenant_wide IS NOT NULL AND NOT v_tenant_wide THEN
    RAISE EXCEPTION
      'helm: permission % is MSP-only and cannot be granted to %, whose role % is client-side',
      NEW.permission_key, NEW.membership_id, v_role_key
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 2. NOBODY GRANTS WHAT THEY DO NOT HOLD.
  --
  --    The RAW setting, not helm.has_permission(), for the reason 0350 gives
  --    about ranks: that function treats an unset GUC as "no permissions",
  --    which is right everywhere else and wrong here — it would make "no
  --    session context" indistinguishable from "an actor holding nothing", and
  --    every grant scripts/bootstrap.ts makes before any session exists would
  --    fail.
  --
  --    Treating an absent context as permitted is not a hole. The policies
  --    above require helm.require_tenant_id(), which RAISES when unset, so no
  --    runtime role reaches this trigger without a context. What is left is the
  --    roles RLS does not apply to — the migrator and the superuser — which is
  --    bootstrap, and nothing a request can become.
  v_permissions := nullif(current_setting('helm.permissions', true), '');

  IF v_permissions IS NOT NULL
     AND NOT (NEW.permission_key = ANY (string_to_array(v_permissions, ','))) THEN
    RAISE EXCEPTION
      'helm: you cannot grant % because you do not hold it yourself',
      NEW.permission_key
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

-- Fires on UPDATE as well as INSERT, and on every column rather than a subset.
-- An UPDATE that flips granted from false to true, or repoints membership_id at
-- a client-side user, is the same act as writing the row that way to begin
-- with.
DROP TRIGGER IF EXISTS membership_permission_authority ON membership_permission;
CREATE TRIGGER membership_permission_authority
  BEFORE INSERT OR UPDATE ON membership_permission
  FOR EACH ROW EXECUTE FUNCTION helm.enforce_membership_permission_authority();

COMMENT ON FUNCTION helm.enforce_membership_permission_authority() IS
  'Refuses a per-user permission grant that would hand a client-side role an '
  'MSP-only permission, or hand the grantee a permission the granter does not '
  'hold. Deliberately not SECURITY DEFINER: it reads the caller''s own context.';

-- =============================================================================
-- Guards
-- =============================================================================
DO $membership_permission_guard$
DECLARE
  v_missing text;
BEGIN
  -- 1. ALL FOUR COMMANDS ARE COVERED. The bug this file exists for is two
  --    MISSING policies, and a missing policy is silent: the write affects zero
  --    rows and reports success.
  SELECT string_agg(cmd, ', ') INTO v_missing
  FROM unnest(ARRAY['r', 'a', 'w', 'd']) AS cmd
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'membership_permission'::regclass AND polcmd = cmd
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'helm: membership_permission has no policy for command(s): %', v_missing;
  END IF;

  -- 2. EVERY WRITE PATH ASKS FOR tenant:write. A policy that kept user:write
  --    would leave the old gate in place under a new name.
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'membership_permission'::regclass
      AND polcmd IN ('a', 'w', 'd')
      AND coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')
          NOT LIKE '%tenant:write%'
  ) THEN
    RAISE EXCEPTION 'helm: a membership_permission write policy does not require tenant:write';
  END IF;

  -- 3. THE TRIGGER IS INSTALLED, on both commands and on all columns.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'membership_permission'::regclass
      AND tgname = 'membership_permission_authority'
      AND NOT tgisinternal
      AND (tgtype & 4) <> 0          -- INSERT
      AND (tgtype & 16) <> 0         -- UPDATE
      AND (tgtype & 2) <> 0          -- BEFORE
      AND tgattr = ''::int2vector    -- every column
  ) THEN
    RAISE EXCEPTION
      'helm: membership_permission_authority must fire BEFORE INSERT OR UPDATE on all columns';
  END IF;

  -- 4. NOT SECURITY DEFINER. It reads current_setting('helm.permissions'),
  --    which is the CALLER's authority. As DEFINER it would still read the
  --    caller's GUC, but the label would invite somebody to add a query that
  --    silently ran with the owner's rights instead.
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'helm.enforce_membership_permission_authority()'::regprocedure
      AND prosecdef
  ) THEN
    RAISE EXCEPTION
      'helm: enforce_membership_permission_authority must not be SECURITY DEFINER';
  END IF;

  -- 5. 0020's TRIGGER ON role_permission SURVIVES. This file adds the per-user
  --    half of one rule; losing the per-role half would reopen the wider door.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'role_permission'::regclass
      AND tgname = 'role_permission_msp_guard'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'helm: the role_permission MSP-only guard is missing';
  END IF;
END;
$membership_permission_guard$;
