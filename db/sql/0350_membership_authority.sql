-- 0350_membership_authority.sql — who may grant what
--
-- `membership`'s RLS policies test the tenant and `user:write`, and stop there.
-- That was enough while nothing could write a membership from a request: the
-- only writer was scripts/bootstrap.ts, running out of band as a role RLS does
-- not apply to.
--
-- Adding a user-management API changes that, and exposes a hole the policies
-- never closed:
--
--   `tier3` holds every permission except organization:delete, tenant:write and
--   key:rotate (0900). So it holds user:write. Its rank is 80. Nothing in the
--   INSERT policy compares the rank of the role being GRANTED against the rank
--   of the role doing the granting — so a tier3 could mint a `super_admin`
--   membership, for anybody, including themselves, and be rank 100 a moment
--   later.
--
-- Enforcing that in the API would put the one rule that decides who can become
-- an administrator in the layer that is easiest to bypass — a future route, a
-- maintenance script, a psql session as helm_app. It goes here, beside the
-- policies, so it holds for every writer.
--
-- The second rule is about scope rather than rank. `membership_scope_exclusive`
-- already says a membership is either tenant-wide or pinned to a non-empty list
-- of organisations. It does not say which roles may be tenant-wide, so a
-- `client_admin` — a co-managed CUSTOMER — could be given org_scope_all and see
-- every other client in the tenant with client permissions. A role that is not
-- tenant-wide exists precisely to be pinned.

CREATE OR REPLACE FUNCTION helm.enforce_membership_authority() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_target_rank integer;
  v_target_wide boolean;
  v_actor_rank  integer;
BEGIN
  SELECT rank, is_tenant_wide INTO v_target_rank, v_target_wide
  FROM app_role WHERE key = NEW.role_key;

  IF v_target_rank IS NULL THEN
    -- The foreign key would catch this too; saying it here makes the failure
    -- name the role rather than the constraint.
    RAISE EXCEPTION 'helm: no such role %', NEW.role_key
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- A client-side role is defined by being pinned. Unpinned, it is a customer
  -- login that can read every other customer's documentation.
  IF NOT v_target_wide AND NEW.org_scope_all THEN
    RAISE EXCEPTION
      'helm: % is a client-side role and cannot hold tenant-wide scope', NEW.role_key
      USING ERRCODE = 'check_violation';
  END IF;

  -- The RAW setting, not helm.current_role_rank().
  --
  -- That function coalesces an unset GUC to 0 so callers fail closed, which is
  -- right everywhere else and wrong here: it makes "no session context" look
  -- like "rank 0", and every grant above rank 0 would fail — including the one
  -- scripts/bootstrap.ts makes when it creates the first administrator, before
  -- any session exists. Reading the setting directly is the only way to tell
  -- an absent context from a real rank of zero.
  --
  -- Treating an absent context as permitted is not a hole. `membership_rls_write`
  -- requires helm.require_tenant_id(), which RAISES when unset, so the runtime
  -- roles cannot reach this trigger without a context at all. What is left is
  -- the roles RLS does not apply to — the migrator, the superuser — which is
  -- bootstrap and nothing a request can become.
  v_actor_rank := nullif(current_setting('helm.role_rank', true), '')::integer;

  IF v_actor_rank IS NOT NULL AND v_target_rank > v_actor_rank THEN
    RAISE EXCEPTION
      'helm: cannot grant % (rank %) — your own role ranks %',
      NEW.role_key, v_target_rank, v_actor_rank
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

-- Fires on every UPDATE, not just one naming role_key.
--
-- That is deliberate and does more than block escalation: it means a tier3
-- cannot revoke, expire or re-scope a super_admin's membership either, because
-- the row they are touching carries a rank above their own. Authority over a
-- membership is the same question whichever column is being changed.
DROP TRIGGER IF EXISTS membership_authority ON membership;
CREATE TRIGGER membership_authority
  BEFORE INSERT OR UPDATE ON membership
  FOR EACH ROW EXECUTE FUNCTION helm.enforce_membership_authority();


-- ---------------------------------------------------------------------------
-- Inviting somebody who may not have an account yet
--
-- `app_user` is deployment-global and helm_app deliberately cannot see a person
-- who has no membership in the CURRENT tenant — app_user_rls_select says so.
-- That is right, and it makes find-or-create-by-email impossible from the
-- request role: inviting an address that already belongs to another tenant
-- would fail the lookup, then fail the insert on the unique email, and the
-- caller could not tell that apart from a typo.
--
-- So the lookup crosses the boundary in a function instead of widening the
-- policy. helm_app gets no INSERT policy on app_user at all — it cannot mint
-- identities by any other path — and this function is the whole of what it can
-- do, gated on the same permission the membership policies require.
--
-- It returns an id and nothing else. An administrator inviting an address
-- learns that the address exists, which they would learn from the invitation
-- succeeding anyway; they learn nothing about the account behind it.
CREATE OR REPLACE FUNCTION helm.upsert_invitee(p_email citext, p_name text DEFAULT NULL)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- A session context is required, so this cannot be called from a connection
  -- that never identified itself.
  PERFORM helm.require_tenant_id();

  IF NOT helm.has_permission('user:write') THEN
    RAISE EXCEPTION 'helm: user:write is required to invite somebody'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id INTO v_id FROM app_user WHERE email = p_email;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO app_user (email, name) VALUES (p_email, nullif(btrim(p_name), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION helm.upsert_invitee(citext, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.upsert_invitee(citext, text) TO helm_app;


-- ---------------------------------------------------------------------------
-- Ending the sessions of somebody whose access was revoked
--
-- `auth_session` belongs to helm_auth and helm_app cannot touch it — §21 of the
-- security suite asserts exactly that, because the request role being able to
-- forge or read a session is the failure everything else is built to prevent.
-- So revocation crosses the boundary here rather than in a route.
--
-- It deletes sessions only when the person has no ACTIVE membership left
-- anywhere. Sessions are not tenant-scoped — the tenant comes from a cookie at
-- request time — so a contractor revoked from one MSP tenant while still
-- working for another must keep the session that serves the second. Their
-- access to the revoked tenant is already gone the moment the membership is:
-- identity resolution finds no active membership and refuses. Deleting the row
-- is what makes that true even for a path that somehow cached the lookup.
CREATE OR REPLACE FUNCTION helm.end_sessions_if_no_access(p_user_id uuid)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  PERFORM helm.require_tenant_id();

  IF NOT helm.has_permission('user:write') THEN
    RAISE EXCEPTION 'helm: user:write is required to end somebody''s sessions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF EXISTS (
    SELECT 1 FROM membership
    WHERE user_id = p_user_id
      AND status = 'active'
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
  ) THEN
    RETURN 0;
  END IF;

  DELETE FROM auth_session WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION helm.end_sessions_if_no_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.end_sessions_if_no_access(uuid) TO helm_app;

-- ---------------------------------------------------------------------------
-- Guard
--
-- Structural only. The behaviour cannot be exercised here: inserting a tenant
-- fires helm.provision_worker_identities(), which needs roles that 0900 has not
-- seeded yet at this point in the run. The escalation itself is reproduced
-- against real fixtures in db/tests/security.sql §22 and, through the API, in
-- tests/integration/users.test.ts.
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'membership_authority'
      AND tgrelid = 'public.membership'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'helm: the membership_authority trigger is not installed';
  END IF;

  -- BEFORE INSERT OR UPDATE, on every column. tgtype bit 0 is BEFORE, bit 2 is
  -- INSERT, bit 4 is UPDATE. An UPDATE trigger narrowed to a column list would
  -- let a rank be changed by a statement that does not name role_key.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'membership_authority'
      AND tgrelid = 'public.membership'::regclass
      AND (tgtype & 1) = 1      -- BEFORE
      AND (tgtype & 4) = 4      -- INSERT
      AND (tgtype & 16) = 16    -- UPDATE
      AND tgattr = ''::int2vector
  ) THEN
    RAISE EXCEPTION
      'helm: membership_authority must fire BEFORE INSERT OR UPDATE on all columns';
  END IF;

  -- SECURITY INVOKER. As DEFINER it would run as the migrating role, which is
  -- exactly the role RLS does not apply to, and helm.current_role_rank() would
  -- still read the caller's GUC — so the check would pass while the write ran
  -- with authority the caller does not have.
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'helm.enforce_membership_authority()'::regprocedure AND prosecdef
  ) THEN
    RAISE EXCEPTION 'helm: enforce_membership_authority must not be SECURITY DEFINER';
  END IF;

  -- helm_app must NOT be able to insert an app_user row directly. The invite
  -- path is helm.upsert_invitee() and nothing else, so a future policy that
  -- opened this up would be caught here.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'app_user' AND cmd IN ('INSERT', 'ALL')
      AND 'helm_app' = ANY (roles)
  ) THEN
    RAISE EXCEPTION 'helm: helm_app has an INSERT policy on app_user; invitations must go through helm.upsert_invitee()';
  END IF;

  IF NOT has_function_privilege('helm_app', 'helm.upsert_invitee(citext, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app cannot execute helm.upsert_invitee()';
  END IF;

  -- And it still must not reach auth_session by any other path.
  IF has_table_privilege('helm_app', 'auth_session', 'SELECT')
     OR has_table_privilege('helm_app', 'auth_session', 'DELETE') THEN
    RAISE EXCEPTION 'helm: helm_app has direct access to auth_session';
  END IF;

  IF NOT has_function_privilege('helm_app', 'helm.end_sessions_if_no_access(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app cannot execute helm.end_sessions_if_no_access()';
  END IF;
END
$guard$;
