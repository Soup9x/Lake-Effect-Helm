-- 0710_reset_authority.sql — who may issue somebody else's reset code
--
-- 0350 closed one escalation and this file closes the second door into it.
--
-- 0350 says a tier3 (rank 80, holds user:write) may not grant, revoke or
-- re-scope a super_admin's membership (rank 100): authority over a membership
-- follows rank. The administrator-issued reset in
-- src/app/api/auth/local/reset/route.ts asked a narrower question — "does the
-- caller hold user:write, and is the target an active member of this tenant" —
-- and returned the reset link to the caller. So a tier3 could issue a code for
-- the super_admin, redeem it, sign in as them and be rank 100 a moment later:
-- the same outcome 0350 forbids, reached through the password instead of the
-- membership row.
--
-- The answer is the same rule in the same layer. Issuing somebody's reset code
-- is authority over their account, so it is refused when the target's role in
-- this tenant outranks the caller's. Equal rank is permitted, exactly as 0350
-- permits granting a role equal to your own — a super_admin must be able to
-- recover another super_admin during the outage this path exists for.
--
-- A SECOND RULE, about scope. `app_user` is deployment-global and a local
-- password is one credential for every tenant the person belongs to. An
-- administrator of tenant A resetting it is also resetting the person's way into
-- tenant B, which tenant A has no authority over. A deployment serving one MSP
-- never has such a person; a deployment serving several must not let one MSP's
-- administrator mint the other's access. So a target holding an active
-- membership in any OTHER tenant is refused, and has to be reset by an
-- administrator they can reach through the self-service path or out of band.
-- helm_app cannot see other tenants' memberships, which is why this is a
-- SECURITY DEFINER function rather than a query in the route.
--
-- Returns one row: the user id when permitted, otherwise NULL and a refusal
-- code the route turns into a response. The function decides; the route only
-- translates.

CREATE OR REPLACE FUNCTION helm.authorise_out_of_band_reset(p_email citext)
  RETURNS TABLE (user_id uuid, refusal text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant      uuid := helm.require_tenant_id();
  v_actor_rank  integer := helm.current_role_rank();
  v_user        uuid;
  v_target_rank integer;
BEGIN
  IF NOT helm.has_permission('user:write') THEN
    RETURN QUERY SELECT NULL::uuid, 'forbidden'::text;
    RETURN;
  END IF;

  SELECT u.id, max(r.rank)
    INTO v_user, v_target_rank
  FROM app_user u
  JOIN membership m
    ON m.user_id = u.id
   AND m.tenant_id = v_tenant
   AND m.status = 'active'
   AND m.revoked_at IS NULL
   AND (m.expires_at IS NULL OR m.expires_at > now())
  JOIN app_role r ON r.key = m.role_key
  WHERE u.email = p_email
  GROUP BY u.id;

  IF v_user IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, 'not_found'::text;
    RETURN;
  END IF;

  IF v_target_rank > v_actor_rank THEN
    RETURN QUERY SELECT NULL::uuid, 'outranks_caller'::text;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM membership m
    WHERE m.user_id = v_user
      AND m.tenant_id <> v_tenant
      AND m.status = 'active'
      AND m.revoked_at IS NULL
      AND (m.expires_at IS NULL OR m.expires_at > now())
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'member_elsewhere'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_user, NULL::text;
END;
$$;

COMMENT ON FUNCTION helm.authorise_out_of_band_reset(citext) IS
  'May the current actor issue an out-of-band reset code for this address? '
  'Refuses a target whose role here outranks the caller''s (the 0350 rule), or '
  'who holds an active membership in another tenant. See 0710.';

REVOKE ALL ON FUNCTION helm.authorise_out_of_band_reset(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.authorise_out_of_band_reset(citext) TO helm_app;

-- ---------------------------------------------------------------------------
-- Guard
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (
    SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'authorise_out_of_band_reset'
  ) THEN
    RAISE EXCEPTION '0710: authorise_out_of_band_reset must be SECURITY DEFINER — '
      'helm_app cannot see memberships in other tenants';
  END IF;

  IF has_function_privilege('public', 'helm.authorise_out_of_band_reset(citext)', 'EXECUTE') THEN
    RAISE EXCEPTION '0710: authorise_out_of_band_reset must not be executable by PUBLIC';
  END IF;
END;
$$;
