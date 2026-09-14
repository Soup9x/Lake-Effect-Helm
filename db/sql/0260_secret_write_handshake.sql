-- =============================================================================
-- 0260_secret_write_handshake.sql — allocating a version before encrypting
--
-- THE TENSION: the AAD binds a ciphertext to its version, so the application
-- must know the version number BEFORE it encrypts. But the version is allocated
-- by the database, under a row lock, so that two concurrent rotations cannot
-- collide.
--
-- The first implementation did that with a client-side
-- `SELECT current_version FROM secret ... FOR UPDATE`. Two problems:
--
--   1. PostgreSQL requires UPDATE (or DELETE) privilege for a row lock, not
--      just SELECT. So every role that writes secrets needed UPDATE on `secret`
--      — including helm_key_admin, whose whole point is that it rotates keys
--      without being able to edit documentation. The rotation worker failed
--      with "permission denied for table secret".
--
--   2. The stale-version check for re-encryption lived in application code,
--      where a worker on a stale deploy could skip it. What it prevents is a
--      rotation job writing its decrypted copy back over a password a
--      technician changed seconds earlier — silently reverting a credential.
--      That guard belongs in the database.
--
-- helm.begin_secret_write() does both under SECURITY DEFINER: it takes the row
-- lock, optionally asserts the expected current version, and returns the number
-- the next version will have. The lock is held for the rest of the caller's
-- transaction, so the value cannot go stale between here and
-- helm.write_secret_version().
-- =============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION helm.begin_secret_write(
  p_secret_id uuid,
  -- Re-encryption passes the version it decrypted. NULL means "whatever is
  -- current", which is what an ordinary rotation wants.
  p_expected_current_version integer DEFAULT NULL
) RETURNS TABLE (
  next_version    integer,
  current_version integer,
  organization_id uuid,
  sensitivity     secret_sensitivity
)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_secret secret%ROWTYPE;
BEGIN
  -- FOR UPDATE here rather than in the caller: taking the lock as the definer
  -- means the write path does not require UPDATE privilege on `secret`, so
  -- helm_key_admin can rotate keys without being able to edit documentation.
  SELECT * INTO v_secret
  FROM secret
  WHERE id = p_secret_id AND tenant_id = v_tenant AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND OR NOT helm.org_in_scope(v_secret.organization_id) THEN
    RAISE EXCEPTION 'helm: secret % not found in scope', p_secret_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_expected_current_version IS NOT NULL
     AND v_secret.current_version <> p_expected_current_version THEN
    RAISE EXCEPTION
      'helm: secret % moved from version % to % during re-encryption',
      p_secret_id, p_expected_current_version, v_secret.current_version
      USING ERRCODE = 'serialization_failure',
            HINT = 'Skip this secret rather than writing the stale copy back; '
                   'the newer version is already under the active key.';
  END IF;

  RETURN QUERY SELECT
    v_secret.current_version + 1,
    v_secret.current_version,
    v_secret.organization_id,
    v_secret.sensitivity;
END;
$$;

COMMENT ON FUNCTION helm.begin_secret_write(uuid, integer) IS
  'Locks a secret and returns the version its next write will carry, so the '
  'application can bind that version into the AAD before encrypting. The lock '
  'persists for the caller''s transaction.';

REVOKE ALL ON FUNCTION helm.begin_secret_write(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.begin_secret_write(uuid, integer) TO helm_app, helm_key_admin;

-- -----------------------------------------------------------------------------
-- helm_key_admin only ever reaches secrets through the audited functions, so it
-- has no business holding a direct SELECT on `secret` either. Revoke it: the
-- rotation worker now learns everything it needs from
-- helm.secrets_pending_reencryption() and helm.begin_secret_write().
-- -----------------------------------------------------------------------------
REVOKE SELECT ON secret FROM helm_key_admin;

DO $verify$
BEGIN
  IF has_table_privilege('helm_key_admin', 'secret', 'SELECT')
     OR has_table_privilege('helm_key_admin', 'secret', 'UPDATE') THEN
    RAISE EXCEPTION 'helm: helm_key_admin still has direct access to secret';
  END IF;

  IF NOT has_function_privilege('helm_key_admin', 'helm.begin_secret_write(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: the rotation worker cannot allocate a secret version';
  END IF;
END
$verify$;
