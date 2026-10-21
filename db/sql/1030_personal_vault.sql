-- =============================================================================
-- 1030 — a personal password vault, in the Personal tab
--
-- Decision 14 dropped this in favour of a Bitwarden/Vaultwarden integration;
-- it is built natively now, on the answers that decision recorded:
--
--   PRIVATE MEANS THE OWNER. Only the person who stored an entry can list,
--   read, change or delete it. Not an administrator, not super_admin, not an
--   API token or a service account (their actor is never a user), and there is
--   no break-glass: an entry somebody else could open in an emergency is not
--   private, and the page says it is. The policy below is the whole rule, and
--   no SECURITY DEFINER function here reads these rows for anybody else.
--
--   ENCRYPTED UNDER THE TENANT'S DATA KEY, as every Helm secret is: the same
--   AES-256-GCM envelope, bound to the entry and its version by the AAD. The
--   honest limit, stated on the page as well: the server holds the key, so it
--   COULD decrypt; the guarantee is that Helm never does it for anybody but the
--   owner. A data-key rotation re-encrypts these too (the one other reader,
--   and it shows nobody), and a key cannot be retired while an entry uses it.
--
--   NOT A CLIENT'S. No organisation, so nothing here reaches a client list,
--   search, a dashboard count or an offboarding export: those read assets and
--   secrets, and these are neither.
--
--   GONE WITH THE PERSON. Keyed to the membership, so removing somebody from
--   the tenant removes their vault in the same statement. Anything the business
--   needs belongs under a client, where it is shared and audited as such.
--
--   AUDITED WITHOUT ITS LABEL. Each read writes 'personal_vault.revealed' with
--   the entry's id and the purpose, never its name: an administrator reading
--   the audit log can see that somebody opened their own vault, not what.
--
-- WHAT IS ENCRYPTED is one JSON document per entry — the password and, when
-- there is one, the one-time code seed with its parameters — so an entry has
-- one envelope and one version, and a code is generated server-side from it
-- without the seed ever leaving.
-- =============================================================================

SET search_path = public, extensions;

CREATE TABLE personal_credential (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  owner_user_id  uuid NOT NULL,

  name           text NOT NULL,
  username       text,
  url            text,
  notes          text,

  -- What the encrypted document holds, so the list can say so without
  -- decrypting anything.
  has_password   boolean NOT NULL DEFAULT false,
  has_totp       boolean NOT NULL DEFAULT false,

  -- The envelope. Null together when the entry holds no secret at all.
  data_key_id        uuid REFERENCES tenant_data_key (id),
  secret_version     integer NOT NULL DEFAULT 0,
  secret_ciphertext  bytea,
  secret_nonce       bytea,
  secret_tag         bytea,
  secret_aad         text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT personal_credential_owner_fk FOREIGN KEY (tenant_id, owner_user_id)
    REFERENCES membership (tenant_id, user_id) ON DELETE CASCADE,
  CONSTRAINT personal_credential_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT personal_credential_text_len CHECK (
    coalesce(length(username), 0) <= 320 AND coalesce(length(url), 0) <= 2048
    AND coalesce(length(notes), 0) <= 4000
  ),
  CONSTRAINT personal_credential_envelope_complete CHECK (
    (secret_ciphertext IS NULL AND secret_nonce IS NULL AND secret_tag IS NULL
       AND secret_aad IS NULL AND data_key_id IS NULL)
    OR (secret_ciphertext IS NOT NULL AND secret_nonce IS NOT NULL AND secret_tag IS NOT NULL
       AND secret_aad IS NOT NULL AND data_key_id IS NOT NULL)
  ),
  CONSTRAINT personal_credential_nonce_len CHECK (secret_nonce IS NULL OR octet_length(secret_nonce) = 12),
  CONSTRAINT personal_credential_tag_len CHECK (secret_tag IS NULL OR octet_length(secret_tag) = 16),
  CONSTRAINT personal_credential_flags_need_envelope CHECK (
    secret_ciphertext IS NOT NULL OR (NOT has_password AND NOT has_totp)
  )
);

CREATE INDEX personal_credential_owner_idx ON personal_credential (tenant_id, owner_user_id);
CREATE INDEX personal_credential_key_idx ON personal_credential (data_key_id) WHERE data_key_id IS NOT NULL;

COMMENT ON TABLE personal_credential IS
  'A person''s own passwords (1030). Readable and writable by the owner only; no administrator '
  'override. Encrypted under the tenant data key; excluded from search, lists and exports.';

ALTER TABLE personal_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_credential FORCE ROW LEVEL SECURITY;

-- The owner, signed in as themselves. current_actor_type() is 'user' only for
-- a person's own session, so an API token or service account matches nothing.
CREATE POLICY personal_credential_owner ON personal_credential
  FOR ALL TO helm_app
  USING (
    tenant_id = helm.current_tenant_id()
    AND helm.current_actor_type() = 'user'
    AND owner_user_id = helm.current_actor_id()
  )
  WITH CHECK (
    tenant_id = helm.current_tenant_id()
    AND helm.current_actor_type() = 'user'
    AND owner_user_id = helm.current_actor_id()
  );

-- The data-key rotation, and nothing else: it reads an envelope and writes it
-- back under the active key (src/lib/personal/vault.ts, reEncryptPersonalVault).
CREATE POLICY personal_credential_rotation ON personal_credential
  FOR ALL TO helm_key_admin
  USING (tenant_id = helm.current_tenant_id() AND helm.has_permission('key:rotate'))
  WITH CHECK (tenant_id = helm.current_tenant_id() AND helm.has_permission('key:rotate'));

-- Default privileges hand every new table to the auditor. Not this one.
-- helm_worker is a MEMBER of helm_app, so it inherits helm_app's grant and its
-- policy; what keeps the worker out is the policy's actor_type = 'user', since
-- the worker only ever acts as a service account (tested).
REVOKE ALL ON personal_credential FROM PUBLIC, helm_worker, helm_auditor, helm_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON personal_credential TO helm_app;
GRANT SELECT, UPDATE ON personal_credential TO helm_key_admin;

-- -----------------------------------------------------------------------------
-- A data key cannot be retired while a vault entry is still sealed under it.
-- 0230's rule for secrets, extended: retiring it would make the entry unreadable.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.retire_data_key(p_data_key_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_remaining bigint;
  v_personal  bigint;
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

  -- Counted, never read: this function runs as its owner, and the count is
  -- all a key administrator learns about anybody's vault.
  SELECT count(*) INTO v_personal FROM personal_credential WHERE data_key_id = p_data_key_id;

  IF v_remaining > 0 OR v_personal > 0 THEN
    RAISE EXCEPTION 'helm: % live secrets still use key % (and % personal vault entries); re-encrypt them before retiring',
      v_remaining, p_data_key_id, v_personal
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

-- -----------------------------------------------------------------------------
-- Guards.
-- -----------------------------------------------------------------------------
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'personal_credential' AND 'helm_app' = ANY (roles)
      AND policyname <> 'personal_credential_owner'
  ) THEN
    RAISE EXCEPTION '1030: a second policy would widen who reads a personal vault';
  END IF;
  IF has_table_privilege('helm_auditor', 'personal_credential', 'SELECT')
     OR has_table_privilege('helm_auth', 'personal_credential', 'SELECT') THEN
    RAISE EXCEPTION '1030: the auditor or the auth role can read personal vaults';
  END IF;
  -- The owner policy is the only thing between the worker (a member of
  -- helm_app) and these rows, so it must keep requiring a person.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'personal_credential' AND policyname = 'personal_credential_owner'
      AND qual LIKE '%current_actor_type()%''user''%' AND with_check LIKE '%current_actor_type()%''user''%'
  ) THEN
    RAISE EXCEPTION '1030: the owner policy no longer requires a person signed in as themselves';
  END IF;
END
$guard$;
