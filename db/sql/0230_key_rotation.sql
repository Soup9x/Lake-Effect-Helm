-- =============================================================================
-- 0230_key_rotation.sql — the rotation worker's read API
--
-- Rotation needs to answer "how much ciphertext still depends on a key I am
-- trying to retire", and that means counting rows in secret_version — which no
-- role can read, by design (0200, 0220).
--
-- Rather than weaken that, the rotation worker gets two narrow SECURITY DEFINER
-- functions that return COUNTS AND IDENTIFIERS ONLY. Neither can return
-- ciphertext. The worker then re-encrypts through the ordinary audited path
-- (helm.reveal_secret + helm.write_secret_version), so a key rotation leaves
-- exactly the same audit trail as a technician rotating a password by hand.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- How many live secrets are still encrypted under a non-active key.
--
-- Only CURRENT versions count. Superseded versions are history: they are
-- expected to stay on the key they were written under, re-encrypting them would
-- mean appending rows to an append-only table for no benefit, and destroying an
-- old key making that history unreadable is the intended effect of a shred, not
-- a bug.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.rotation_backlog()
  RETURNS TABLE (
    data_key_id   uuid,
    generation    integer,
    status        data_key_status,
    secret_count  bigint
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT k.id, k.generation, k.status, count(s.id)
  FROM tenant_data_key k
  LEFT JOIN secret_version sv
    ON sv.data_key_id = k.id
  LEFT JOIN secret s
    ON s.id = sv.secret_id
   AND s.current_version = sv.version
   AND s.deleted_at IS NULL
  WHERE k.tenant_id = helm.current_tenant_id()
    AND k.status <> 'active'
    AND helm.has_permission('key:rotate')
  GROUP BY k.id, k.generation, k.status
  HAVING count(s.id) > 0;
$$;

-- -----------------------------------------------------------------------------
-- The next batch of secrets to re-encrypt. Identifiers and policy only.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.secrets_pending_reencryption(
  p_limit integer DEFAULT 100
)
  RETURNS TABLE (
    secret_id       uuid,
    organization_id uuid,
    version         integer,
    data_key_id     uuid,
    sensitivity     secret_sensitivity,
    requires_step_up boolean
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT s.id, s.organization_id, sv.version, sv.data_key_id,
         s.sensitivity, s.requires_step_up
  FROM secret s
  JOIN secret_version sv
    ON sv.secret_id = s.id AND sv.version = s.current_version
  JOIN tenant_data_key k
    ON k.id = sv.data_key_id
  WHERE s.tenant_id = helm.current_tenant_id()
    AND s.deleted_at IS NULL
    AND k.status IN ('retiring', 'retired')
    AND helm.has_permission('key:rotate')
  ORDER BY s.sensitivity DESC, s.id
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000);
$$;

-- -----------------------------------------------------------------------------
-- Retire a key once nothing current depends on it.
--
-- Refuses while the backlog is non-empty. That check lives here rather than in
-- the worker because the consequence of getting it wrong — destroying a key
-- that live ciphertext still needs — is unrecoverable data loss, and a
-- database-side guard cannot be skipped by a worker deployed from a stale
-- branch.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.retire_data_key(p_data_key_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_remaining bigint;
  v_tenant    uuid := helm.current_tenant_id();
BEGIN
  IF NOT helm.has_permission('key:rotate') THEN
    RAISE EXCEPTION 'helm: key:rotate permission required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT count(*) INTO v_remaining
  FROM secret s
  JOIN secret_version sv ON sv.secret_id = s.id AND sv.version = s.current_version
  WHERE sv.data_key_id = p_data_key_id AND s.deleted_at IS NULL;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'helm: % live secrets still use key %; re-encrypt them before retiring',
      v_remaining, p_data_key_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE tenant_data_key
  SET status = 'retired', retired_at = now()
  WHERE id = p_data_key_id AND tenant_id = v_tenant AND status = 'retiring';

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM helm.audit('key.retired', 'tenant_data_key', p_data_key_id, 'success',
                     NULL, NULL, NULL, jsonb_build_object('live_secrets_remaining', 0));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION helm.rotation_backlog() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.secrets_pending_reencryption(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.retire_data_key(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.rotation_backlog() TO helm_key_admin, helm_auditor;
GRANT EXECUTE ON FUNCTION helm.secrets_pending_reencryption(integer) TO helm_key_admin;
GRANT EXECUTE ON FUNCTION helm.retire_data_key(uuid) TO helm_key_admin;

-- The rotation worker re-encrypts through the ordinary path, so it needs the
-- same grants a technician's session has on those two functions. Both were
-- already granted to helm_key_admin in 0220; restated here so this migration
-- reads as a complete description of what the worker can do.
