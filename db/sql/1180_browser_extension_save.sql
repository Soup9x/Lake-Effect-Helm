-- =============================================================================
-- 1180 — the browser extension saves and updates logins
--
-- Until now the extension only read: look a site up, copy, fill. It now offers,
-- as Bitwarden does, to save a login the person just signed in with, to update
-- the password Helm holds when they signed in with a different one, and to add
-- one from the popup. That is a write path from a browser, so it is narrower
-- than the web interface's in four ways, each enforced here and not only in the
-- routes.
--
-- 1. A PAIRING CARRIES WRITE ONLY WHEN IT WAS APPROVED WITH IT. New pairings
--    gain secret:write and asset:write, narrowed as before to what the person
--    holds. An existing pairing keeps the scopes it was approved with: renewal
--    copies them, and nothing here widens a live token. Saving from a browser
--    paired before 1180 asks the person to pair it again, which takes their
--    password (and authenticator code) again, so the wider token is something
--    they agreed to, not something that arrived with an upgrade.
--
-- 2. ONLY STANDARD CREDENTIALS. A request authenticated by an extension token
--    may create a secret only at 'standard' sensitivity, with no step-up, no
--    reason and the default rank; may not change those on any secret; and may
--    write a new version only of a standard secret. So a signed request from a
--    compromised browser profile cannot overwrite a domain admin password, or
--    quietly lower the protection on one. The same line the reveal rungs drew
--    in 1120, drawn for writes.
--
-- 3. "IS THIS THE PASSWORD HELM HAS?" WITHOUT A REVEAL. After a sign-in the
--    extension needs to know whether the password typed matches the one
--    stored. helm.extension_password_state() compares the keyed blind index
--    (0040's reuse_hmac, HMAC-SHA-256 under a per-tenant subkey) of what was
--    typed with the current version's, and answers same, changed or unknown.
--    Nothing is decrypted and no plaintext leaves, so a sign-in is not an
--    audited reveal. It answers only for a standard secret the person could
--    reveal anyway, so it is never an oracle for one they could not.
--
-- 4. THE PERSONAL VAULT. The extension may add an entry to its own person's
--    vault and change one; it still cannot delete one. Two policies, INSERT
--    and UPDATE, beside 1120's read-only one.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Pairing: 1121's function, with the two write scopes added to what a new
-- pairing may carry. Everything else is unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.pair_browser_extension(
  p_label             text,
  p_browser           text,
  p_extension_version text,
  p_public_key        bytea,
  p_token_prefix      text,
  p_token_hash        bytea,
  p_expires_at        timestamptz
) RETURNS TABLE (install_id uuid, token_id uuid, scopes text[])
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_actor   uuid := helm.current_actor_id();
  v_tenant  uuid := helm.require_tenant_id();
  v_label   text := btrim(coalesce(p_label, ''));
  v_scopes  text[];
  v_live    integer;
  v_token   uuid;
  v_install uuid;
BEGIN
  IF v_actor IS NULL OR helm.current_actor_type() <> 'user' THEN
    RAISE EXCEPTION 'helm: only a signed-in person can pair a browser extension'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The same rule as 0750's: a token cannot beget a token. Renewal is the one
  -- exception, and it is its own function, bound to the pairing it renews.
  IF nullif(current_setting('helm.api_token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'helm: a browser extension can only be paired from a signed-in Helm tab'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT helm.is_tenant_wide() THEN
    RAISE EXCEPTION 'helm: the browser extension is for MSP staff'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 1121: the person re-entered their password (and their authenticator
  -- code, when they have one) for this pairing. A session alone is not
  -- enough: one left open on somebody else's desk would otherwise mint a
  -- 30-day credential that outlives it. The application checks the password
  -- and records the step-up immediately before calling this; the database
  -- refuses a pairing without one, whoever calls it.
  IF NOT helm.step_up_verified() THEN
    RAISE EXCEPTION 'helm: re-enter your password to pair a browser extension'
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'step_up_required';
  END IF;

  IF v_label = '' OR length(v_label) > 80 THEN
    RAISE EXCEPTION 'helm: a paired browser needs a name of at most 80 characters';
  END IF;
  IF length(coalesce(p_browser, '')) > 40 OR length(coalesce(p_extension_version, '')) > 20 THEN
    RAISE EXCEPTION 'helm: the browser or extension version is too long';
  END IF;
  -- A P-256 public key in SubjectPublicKeyInfo form is 91 bytes. The shape is
  -- checked properly by the application, which parses it; this is the floor.
  IF p_public_key IS NULL OR octet_length(p_public_key) NOT BETWEEN 64 AND 200 THEN
    RAISE EXCEPTION 'helm: that is not a device public key';
  END IF;

  IF p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '31 days' THEN
    RAISE EXCEPTION 'helm: an extension token expires within 31 days';
  END IF;

  -- What it may do: the four permissions looking up and copying a credential
  -- needs, and since 1180 the two saving one needs, narrowed to the ones this
  -- person holds. Somebody whose role cannot write credentials pairs a browser
  -- that can look up and fill, and is never offered a save.
  SELECT coalesce(array_agg(p ORDER BY p), '{}') INTO v_scopes
  FROM unnest(ARRAY['asset:read', 'asset:write', 'organization:read', 'secret:read', 'secret:reveal', 'secret:write']) AS p
  WHERE helm.has_permission(p);

  IF cardinality(v_scopes) = 0 THEN
    RAISE EXCEPTION 'helm: your role cannot read credentials, so there is nothing for the extension to do'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT count(*) INTO v_live
  FROM browser_extension_install i
  JOIN api_token t ON t.id = i.api_token_id
  WHERE i.user_id = v_actor
    AND i.tenant_id = v_tenant
    AND i.revoked_at IS NULL
    AND t.revoked_at IS NULL
    AND t.expires_at > now();
  IF v_live >= 10 THEN
    RAISE EXCEPTION 'helm: you already have 10 paired browsers; remove one before pairing another';
  END IF;

  INSERT INTO api_token (
    tenant_id, token_type, user_id, name, token_prefix, token_hash, scopes, expires_at, created_by
  ) VALUES (
    v_tenant, 'browser_extension', v_actor, 'Browser extension: ' || v_label,
    p_token_prefix, p_token_hash, v_scopes, p_expires_at, v_actor
  )
  RETURNING id INTO v_token;

  INSERT INTO browser_extension_install (
    tenant_id, user_id, api_token_id, device_label, device_public_key, browser,
    extension_version, approved_at, approved_by
  ) VALUES (
    v_tenant, v_actor, v_token, v_label, p_public_key, nullif(btrim(p_browser), ''),
    nullif(btrim(p_extension_version), ''), now(), v_actor
  )
  RETURNING id INTO v_install;

  PERFORM helm.audit(
    'browser_extension.paired', 'browser_extension_install', v_install, 'success', NULL, NULL, NULL,
    jsonb_build_object(
      'label', v_label,
      'browser', p_browser,
      'extensionVersion', p_extension_version,
      'tokenPrefix', p_token_prefix,
      'keySha256', encode(sha256(p_public_key), 'hex'),
      'expiresAt', p_expires_at
    )
  );

  RETURN QUERY SELECT v_install, v_token, v_scopes;
END;
$$;

-- -----------------------------------------------------------------------------
-- Only standard credentials, through the extension.
--
-- Triggers rather than rungs in the functions, because a secret row is
-- inserted by the application under RLS (SecretService.createInTransaction)
-- and a version through helm.write_secret_version(); a trigger catches both,
-- and any path added later.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.extension_secret_write_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF helm.current_api_token_type() IS DISTINCT FROM 'browser_extension' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.sensitivity <> 'standard' OR NEW.requires_step_up OR NEW.requires_reason
       OR NEW.min_role_rank > 40 OR NEW.kind = 'totp_seed' THEN
      RAISE EXCEPTION 'helm: the browser extension saves standard passwords only'
        USING ERRCODE = 'insufficient_privilege', DETAIL = 'not_permitted_for_extension';
    END IF;
  ELSIF NEW.sensitivity IS DISTINCT FROM OLD.sensitivity
     OR NEW.requires_step_up IS DISTINCT FROM OLD.requires_step_up
     OR NEW.requires_reason IS DISTINCT FROM OLD.requires_reason
     OR NEW.min_role_rank IS DISTINCT FROM OLD.min_role_rank
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
    RAISE EXCEPTION 'helm: the browser extension cannot change how a credential is protected'
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'not_permitted_for_extension';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION helm.extension_secret_write_guard() IS
  'A request made by the browser extension creates standard secrets only and '
  'cannot change any secret''s protection, client, or deletion (1180).';

CREATE TRIGGER secret_extension_write_guard
  BEFORE INSERT OR UPDATE ON secret
  FOR EACH ROW EXECUTE FUNCTION helm.extension_secret_write_guard();

CREATE OR REPLACE FUNCTION helm.extension_version_write_guard()
  RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_sensitivity secret_sensitivity;
  v_kind        secret_kind;
BEGIN
  IF helm.current_api_token_type() IS DISTINCT FROM 'browser_extension' THEN
    RETURN NEW;
  END IF;
  SELECT s.sensitivity, s.kind INTO v_sensitivity, v_kind
  FROM secret s WHERE s.id = NEW.secret_id AND s.tenant_id = NEW.tenant_id;
  IF v_sensitivity IS DISTINCT FROM 'standard' OR v_kind = 'totp_seed' THEN
    RAISE EXCEPTION 'helm: the browser extension updates standard passwords only'
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'not_permitted_for_extension';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION helm.extension_version_write_guard() IS
  'A request made by the browser extension writes a new version of a standard '
  'password only (1180).';

REVOKE ALL ON FUNCTION helm.extension_version_write_guard() FROM PUBLIC;

CREATE TRIGGER secret_version_extension_write_guard
  BEFORE INSERT ON secret_version
  FOR EACH ROW EXECUTE FUNCTION helm.extension_version_write_guard();

-- -----------------------------------------------------------------------------
-- Is this the password Helm has?
--
-- SECURITY DEFINER because secret_version has no SELECT policy for anybody
-- (0200): this reads one column of one row and returns one word. The caller
-- must be the extension, the secret must be one the caller could reveal for
-- 'autofill' (in scope, visible, secret:reveal, rank, standard, no step-up,
-- no reason), and only then is the blind index compared.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.extension_password_state(p_secret_id uuid, p_hmac bytea)
  RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_secret secret%ROWTYPE;
  v_stored bytea;
BEGIN
  IF helm.current_api_token_type() IS DISTINCT FROM 'browser_extension' THEN
    RAISE EXCEPTION 'helm: only the browser extension asks this'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_secret FROM secret
  WHERE id = p_secret_id AND tenant_id = v_tenant AND deleted_at IS NULL;
  IF NOT FOUND
     OR NOT helm.org_in_scope(v_secret.organization_id)
     OR (NOT helm.is_tenant_wide() AND NOT helm.secret_node_visible(v_secret.id))
     OR NOT helm.has_permission('secret:reveal')
     OR helm.current_role_rank() < v_secret.min_role_rank
     OR v_secret.sensitivity <> 'standard'
     OR v_secret.kind = 'totp_seed'
     OR v_secret.requires_step_up
     OR v_secret.requires_reason THEN
    RETURN 'unknown';
  END IF;

  SELECT sv.reuse_hmac INTO v_stored
  FROM secret_version sv
  WHERE sv.secret_id = v_secret.id AND sv.version = v_secret.current_version;

  IF v_stored IS NULL OR p_hmac IS NULL OR octet_length(p_hmac) <> 32 THEN
    RETURN 'unknown';
  END IF;
  RETURN CASE WHEN v_stored = p_hmac THEN 'same' ELSE 'changed' END;
END;
$$;

COMMENT ON FUNCTION helm.extension_password_state(uuid, bytea) IS
  'For the browser extension after a sign-in: whether a typed password''s blind '
  'index matches the stored standard password''s current version. Same, changed '
  'or unknown; decrypts nothing (1180).';

REVOKE ALL ON FUNCTION helm.extension_password_state(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.extension_password_state(uuid, bytea) TO helm_app;

-- -----------------------------------------------------------------------------
-- The personal vault: the owner's own extension may add and change entries.
-- Never delete: that stays in Helm, signed in.
-- -----------------------------------------------------------------------------
CREATE POLICY personal_credential_owner_extension_insert ON personal_credential
  FOR INSERT TO helm_app
  WITH CHECK (
    tenant_id = helm.current_tenant_id()
    AND helm.current_actor_type() = 'user'
    AND owner_user_id = helm.current_actor_id()
    AND helm.current_api_token_type() = 'browser_extension'
  );

CREATE POLICY personal_credential_owner_extension_update ON personal_credential
  FOR UPDATE TO helm_app
  USING (
    tenant_id = helm.current_tenant_id()
    AND helm.current_actor_type() = 'user'
    AND owner_user_id = helm.current_actor_id()
    AND helm.current_api_token_type() = 'browser_extension'
  )
  WITH CHECK (
    tenant_id = helm.current_tenant_id()
    AND helm.current_actor_type() = 'user'
    AND owner_user_id = helm.current_actor_id()
    AND helm.current_api_token_type() = 'browser_extension'
  );

-- =============================================================================
-- Guards
-- =============================================================================
DO $guard$
BEGIN
  -- Still a step-up, a session and a tenant-wide role to pair (1121).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'pair_browser_extension'
      AND p.prosrc LIKE '%step_up_verified%'
      AND p.prosrc LIKE '%is_tenant_wide%'
      AND p.prosrc LIKE '%helm.api_token_id%'
  ) THEN
    RAISE EXCEPTION '1180: pair_browser_extension must require a step-up, a session and a tenant-wide role';
  END IF;

  -- The personal vault: the owner from a session, and the owner's extension
  -- for reading, adding and changing. Nothing else, and no extension DELETE.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'personal_credential' AND 'helm_app' = ANY (roles)
      AND policyname NOT IN (
        'personal_credential_owner', 'personal_credential_owner_extension',
        'personal_credential_owner_extension_insert', 'personal_credential_owner_extension_update')
  ) THEN
    RAISE EXCEPTION '1180: an unexpected policy on personal_credential';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'personal_credential' AND policyname LIKE 'personal_credential_owner_extension%'
      AND cmd IN ('ALL', 'DELETE')
  ) THEN
    RAISE EXCEPTION '1180: the extension must not delete from a personal vault';
  END IF;
END
$guard$;
