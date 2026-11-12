-- =============================================================================
-- 1300 — An administrator can require the browser extension to be locked
-- =============================================================================
--
-- The extension can seal its pairing behind a PIN or a password (0.4.0), so a
-- copy of the browser profile, or somebody sitting down at an unlocked
-- computer after a restart, holds nothing Helm will answer. Until now that was
-- each technician's own choice, per browser, and nothing told an administrator
-- who had made it.
--
-- extension_policy.require_lock makes it the MSP's choice. The extension says
-- on every request whether it is locked with a PIN, a password or nothing, and
-- with the requirement on Helm refuses an extension that is not (and one too
-- old to say), on every route but the two it needs to explain itself and stay
-- paired. See src/lib/extension/policy.ts.
--
-- WHAT THIS IS AND IS NOT. The lock lives in the browser, so Helm takes the
-- extension's word for it: this makes every honest copy of the extension set a
-- lock before it can be used. It is not a defence against somebody who already
-- holds an unsealed pairing and edits the extension to lie. Revoking the
-- browser is the answer to that, as it always was.
-- =============================================================================

SET search_path = public, extensions;

CREATE TABLE extension_policy (
  tenant_id    uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  -- Refuse an extension that is not locked with a PIN or a password.
  require_lock boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES app_user(id) ON DELETE SET NULL
);

COMMENT ON TABLE extension_policy IS
  'Browser extension settings a tenant administrator sets (1300).';

SELECT helm.apply_tenant_rls('extension_policy', false, 100, NULL);
REVOKE ALL ON extension_policy FROM PUBLIC, helm_app, helm_auth;

-- Every member may read it: the extension's own requests need the answer, and
-- it is not sensitive.
CREATE FUNCTION helm.extension_policy()
RETURNS TABLE (require_lock boolean, updated_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT coalesce(p.require_lock, false), p.updated_at
  FROM (SELECT helm.require_tenant_id() AS tenant_id) t
  LEFT JOIN extension_policy p ON p.tenant_id = t.tenant_id;
$$;

-- user:write, as revoking somebody's paired browser is (1121): both decide how
-- other people's browsers may reach Helm. Never from an extension's own token.
CREATE FUNCTION helm.set_extension_policy(p_require_lock boolean) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
BEGIN
  IF NOT helm.has_permission('user:write') THEN
    RAISE EXCEPTION 'helm: changing the browser extension policy requires user:write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_require_lock IS NULL THEN
    RAISE EXCEPTION 'helm: require_lock must be true or false' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO extension_policy (tenant_id, require_lock, updated_by)
  VALUES (v_tenant, p_require_lock, v_actor)
  ON CONFLICT (tenant_id) DO UPDATE SET
    require_lock = EXCLUDED.require_lock,
    updated_at = now(),
    updated_by = v_actor;

  PERFORM helm.audit(
    'extension_policy.updated', 'tenant', v_tenant, 'success', NULL, NULL, NULL,
    jsonb_build_object('requireLock', p_require_lock));
END;
$$;

REVOKE ALL ON FUNCTION helm.extension_policy() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_extension_policy(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.extension_policy() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_extension_policy(boolean) TO helm_app;

DO $$
BEGIN
  IF has_table_privilege('helm_app', 'extension_policy', 'SELECT')
     OR has_table_privilege('helm_app', 'extension_policy', 'UPDATE')
     OR has_table_privilege('helm_auth', 'extension_policy', 'SELECT') THEN
    RAISE EXCEPTION '1300: an application role can reach extension_policy directly';
  END IF;
END
$$;
