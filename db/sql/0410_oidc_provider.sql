-- =============================================================================
-- 0410_oidc_provider.sql — a fourth door: any OIDC-compliant identity provider
--
-- Helm has had three ways in: Entra (SSO), a local password, and RADIUS. Entra
-- is hardcoded, in the deployment's environment, to one vendor. An MSP running
-- Authentik, Keycloak, Okta, Zitadel or anything else that speaks OpenID
-- Connect had no door at all.
--
-- NOTHING HERE NAMES A PRODUCT. What is stored is the four things the protocol
-- itself defines — issuer, client id, client secret, scopes — and everything
-- else is DISCOVERED at runtime from the issuer's
-- /.well-known/openid-configuration. That is the whole reason to implement OIDC
-- rather than "Authentik support": endpoints, signing keys and supported
-- features come from the provider, so a deployment can point this at something
-- that did not exist when this file was written.
--
-- THE CLIENT SECRET SITS EXACTLY WHERE THE RADIUS SHARED SECRET SITS.
--
-- Same reasoning as 0360, and it is worth restating rather than referring to:
-- this value is needed BEFORE anybody is signed in, by the one role that runs
-- pre-authentication (helm_auth), with no tenant context and no actor to
-- attribute a reveal to. Pushing it through helm.reveal_secret() would mean
-- inventing a pre-auth actor and writing an audit row per login attempt.
--
-- So it is enveloped by the same KEK that wraps every tenant DEK — wrapped DEK
-- in the row, secret sealed under it with AES-256-GCM, AAD binding the
-- ciphertext to this tenant and this purpose. helm_app cannot SELECT this table
-- at all, by any column; it reaches the non-secret settings through a SECURITY
-- DEFINER function and writes the secret without being able to read it back.
--
-- Configuring it is gated on tenant:write, which only super_admin holds —
-- the same bar RADIUS sits behind, for the same reason: changing how an entire
-- MSP authenticates is a strictly larger act than configuring an integration.
--
-- TWO SETTINGS THAT ARE SECURITY DECISIONS, NOT PREFERENCES
--
--   allow_signup   May a successful OIDC sign-in CREATE an app_user that does
--                  not exist yet? Default false. Note what it does and does not
--                  mean: a new app_user has no membership, and without a
--                  membership it can see nothing at all. So this is the
--                  difference between "an unknown address is turned away at the
--                  door" and "an unknown address gets an empty account an
--                  administrator must then grant". It is not the difference
--                  between locked and unlocked.
--
--   link_by_email  May an OIDC identity attach to an EXISTING app_user with the
--                  same address? Default false, and this is the one that
--                  deserves thought. Turning it on means trusting the
--                  provider's email claim: anyone who can set a user's address
--                  in the IdP can take over the matching Helm account. For an
--                  Authentik or Keycloak the MSP runs itself that is usually
--                  fine, and it is also the only way a pre-provisioned account
--                  can ever use this door. For a consumer IdP it is not fine.
--                  The deployment decides, deliberately, in writing.
-- =============================================================================

SET search_path = public, extensions;

-- The auth_method enum gained 'oidc' in 0405, which is a separate file for a
-- reason worth reading: a new enum value cannot be used in the transaction that
-- added it, and db/migrate.ts runs one transaction per file. See that file.

-- -----------------------------------------------------------------------------
-- helm.scopes_well_formed — an IMMUTABLE predicate, because a CHECK needs one.
--
-- The obvious spelling, array_to_string(scopes, ' ') ~ '...', does not work:
-- array_to_string is STABLE, not IMMUTABLE, and Postgres refuses it in a CHECK.
-- (The same trap as text[]::text, which cost a generated column earlier in this
-- schema.) unnest, the regex match and bool_and are each immutable, so this
-- wrapper genuinely is what it claims to be.
--
-- bool_and over an empty array is NULL, which a CHECK treats as passing — hence
-- the separate length constraint below rather than relying on this one.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.scopes_well_formed(p_scopes text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT bool_and(s ~ '^[A-Za-z0-9_.:/-]{1,64}$') FROM unnest(p_scopes) AS s;
$$;

-- -----------------------------------------------------------------------------
-- oidc_provider — one provider per tenant.
--
-- One row, not a list, for the same reason radius_config is one row: a second
-- OIDC provider is a second identity source, and "which one is this person in?"
-- is a question that ends in account collisions keyed on an email address.
-- A deployment that genuinely federates two directories should federate them in
-- the IdP, which is what an IdP is for.
-- -----------------------------------------------------------------------------
CREATE TABLE oidc_provider (
  tenant_id     uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,

  enabled       boolean NOT NULL DEFAULT false,

  -- The provider id in the OAuth callback URL: /api/auth/callback/<slug>.
  --
  -- UNIQUE across the deployment, not per tenant, because the callback path has
  -- no tenant in it. IMMUTABLE once set, enforced in update_oidc_settings():
  -- the redirect URI is registered at the IdP by hand, and silently changing
  -- the path here breaks every sign-in with an error message that appears at
  -- the provider rather than in Helm.
  slug          text NOT NULL UNIQUE,

  -- What the button on the sign-in page says. "Sign in with {display_name}".
  display_name  text NOT NULL,

  -- The issuer identifier, exactly as the provider publishes it. Discovery
  -- appends /.well-known/openid-configuration, so a trailing slash produces a
  -- double slash that some providers 404 — refused below rather than quietly
  -- normalised, so the value stored is the value the operator can compare
  -- against their IdP's own screen.
  issuer        text NOT NULL,

  client_id     text NOT NULL,

  -- openid is mandatory; profile and email are what Helm actually reads. More
  -- can be added for providers that gate claims behind a scope (Authentik's
  -- group membership, for instance).
  scopes        text[] NOT NULL DEFAULT ARRAY['openid', 'profile', 'email'],

  -- The two security decisions described in the header.
  allow_signup  boolean NOT NULL DEFAULT false,
  link_by_email boolean NOT NULL DEFAULT false,

  -- The envelope. Identical in shape to radius_config and to
  -- tenant_data_key + secret_version, because it is the same construction.
  wrap_provider     text  NOT NULL,
  kek_id            text  NOT NULL,
  wrapped_dek       bytea NOT NULL,
  secret_ciphertext bytea NOT NULL,
  secret_nonce      bytea NOT NULL,
  secret_tag        bytea NOT NULL,
  secret_aad        text  NOT NULL,

  -- Last time somebody pressed Test, and what discovery said.
  last_test_at    timestamptz,
  last_test_ok    boolean,
  last_test_error text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,

  -- Lowercase, URL-safe, and long enough to be descriptive. The shape is the
  -- one Auth.js puts straight into a path segment.
  CONSTRAINT oidc_slug_shape CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
  -- Auth.js resolves providers by id. A slug colliding with a built-in one
  -- would shadow it, and 'microsoft-entra-id' shadowing Entra means the SSO
  -- button silently starts pointing somewhere else.
  CONSTRAINT oidc_slug_not_reserved CHECK (
    slug NOT IN ('microsoft-entra-id', 'credentials', 'email', 'webauthn', 'nodemailer')
  ),
  CONSTRAINT oidc_display_name_present CHECK (length(btrim(display_name)) BETWEEN 1 AND 60),
  -- https only. The client secret is presented to the token endpoint that
  -- discovery returns, and discovery is fetched from this URL — so plaintext
  -- here is plaintext for the secret, whatever the network is.
  CONSTRAINT oidc_issuer_https CHECK (issuer ~ '^https://[A-Za-z0-9._~%-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%!$&''()*+,;=:@/-]*)?$'),
  CONSTRAINT oidc_issuer_no_trailing_slash CHECK (issuer !~ '/$'),
  CONSTRAINT oidc_issuer_length CHECK (length(issuer) BETWEEN 9 AND 500),
  CONSTRAINT oidc_client_id_present CHECK (length(btrim(client_id)) BETWEEN 1 AND 255),
  CONSTRAINT oidc_client_id_shape CHECK (client_id !~ '[[:space:]]'),
  CONSTRAINT oidc_scopes_count CHECK (array_length(scopes, 1) BETWEEN 1 AND 20),
  CONSTRAINT oidc_scopes_openid CHECK ('openid' = ANY (scopes)),
  CONSTRAINT oidc_scopes_shape CHECK (helm.scopes_well_formed(scopes)),
  CONSTRAINT oidc_nonce_len CHECK (octet_length(secret_nonce) = 12),
  CONSTRAINT oidc_tag_len CHECK (octet_length(secret_tag) = 16),
  CONSTRAINT oidc_secret_present CHECK (octet_length(secret_ciphertext) > 0)
);

COMMENT ON TABLE oidc_provider IS
  'Generic OIDC identity provider settings and the enveloped client secret. '
  'Readable only by helm_auth — the same boundary radius_config and '
  'local_credential.password_phc sit behind.';

COMMENT ON COLUMN oidc_provider.slug IS
  'The provider id in /api/auth/callback/<slug>. Immutable once set: the '
  'redirect URI is registered by hand at the identity provider.';

COMMENT ON COLUMN oidc_provider.link_by_email IS
  'Whether an OIDC identity may attach to an existing account with the same '
  'address. Trusting the provider''s email claim; off unless the deployment '
  'says otherwise.';

CREATE TRIGGER oidc_provider_touch BEFORE UPDATE ON oidc_provider
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- -----------------------------------------------------------------------------
-- helm.oidc_signin_options — what the PUBLIC sign-in page may know.
--
-- A button needs a label and a path, so that is the entire result type. No
-- issuer, no client id, and certainly no secret: this answers a question asked
-- by an anonymous browser, and the least it can say while still rendering a
-- usable page is a label and a slug.
--
-- The issuer is deliberately absent even though it is not secret. A sign-in
-- page that names the deployment's internal IdP hostname tells an unauthenticated
-- visitor where to point their next scan.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.oidc_signin_options()
RETURNS TABLE (slug text, display_name text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT o.slug, o.display_name
  FROM oidc_provider o
  JOIN tenant t ON t.id = o.tenant_id AND t.status = 'active'
  WHERE o.enabled
  ORDER BY o.display_name;
$$;

-- -----------------------------------------------------------------------------
-- helm.oidc_provider_by_slug — everything Auth.js needs to build the provider.
--
-- Keyed by slug because that is what the callback URL carries. At this point in
-- a sign-in there is no session, no cookie and no tenant — the slug is the only
-- thing known, exactly as an email address is the only thing known when RADIUS
-- is resolved.
--
-- Returns the envelope, not the secret. The database has never held the master
-- key and is not being given it here; the caller unwraps.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.oidc_provider_by_slug(p_slug text)
RETURNS TABLE (
  tenant_id uuid, slug text, display_name text, issuer text, client_id text,
  scopes text[], allow_signup boolean, link_by_email boolean,
  wrap_provider text, kek_id text, wrapped_dek bytea,
  secret_ciphertext bytea, secret_nonce bytea, secret_tag bytea, secret_aad text
)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT o.tenant_id, o.slug, o.display_name, o.issuer, o.client_id,
         o.scopes, o.allow_signup, o.link_by_email,
         o.wrap_provider, o.kek_id, o.wrapped_dek,
         o.secret_ciphertext, o.secret_nonce, o.secret_tag, o.secret_aad
  FROM oidc_provider o
  JOIN tenant t ON t.id = o.tenant_id AND t.status = 'active'
  WHERE o.slug = p_slug AND o.enabled;
$$;

-- -----------------------------------------------------------------------------
-- helm.oidc_provider_for_tenant — the same row, for the admin test button.
--
-- Separate from the above and NOT filtered on `enabled`, because testing a
-- configuration before switching it on is the entire point of a test button.
-- Taking a tenant_id rather than a slug keeps the sign-in lookup from being
-- reachable with a value somebody guessed.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.oidc_provider_for_tenant(p_tenant_id uuid)
RETURNS TABLE (
  tenant_id uuid, slug text, display_name text, issuer text, client_id text,
  scopes text[], allow_signup boolean, link_by_email boolean,
  wrap_provider text, kek_id text, wrapped_dek bytea,
  secret_ciphertext bytea, secret_nonce bytea, secret_tag bytea, secret_aad text
)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT o.tenant_id, o.slug, o.display_name, o.issuer, o.client_id,
         o.scopes, o.allow_signup, o.link_by_email,
         o.wrap_provider, o.kek_id, o.wrapped_dek,
         o.secret_ciphertext, o.secret_nonce, o.secret_tag, o.secret_aad
  FROM oidc_provider o WHERE o.tenant_id = p_tenant_id;
$$;

-- -----------------------------------------------------------------------------
-- helm.oidc_settings — everything EXCEPT the secret, for the current tenant.
--
-- What helm_app is allowed to know. Runs inside a tenant context, returns at
-- most one row, so there is no argument to get wrong and no way to name another
-- tenant. The envelope columns are not in the result type at all — not filtered
-- out downstream, absent.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.oidc_settings()
RETURNS TABLE (
  enabled boolean, slug text, display_name text, issuer text, client_id text,
  scopes text[], allow_signup boolean, link_by_email boolean, secret_set boolean,
  last_test_at timestamptz, last_test_ok boolean, last_test_error text,
  updated_at timestamptz
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.is_tenant_wide() THEN
    RAISE EXCEPTION 'helm: authentication settings are not visible to a client-side role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT o.enabled, o.slug, o.display_name, o.issuer, o.client_id, o.scopes,
           o.allow_signup, o.link_by_email,
           true AS secret_set,
           o.last_test_at, o.last_test_ok, o.last_test_error, o.updated_at
    FROM oidc_provider o WHERE o.tenant_id = v_tenant;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.set_oidc_provider — write settings and the enveloped secret together.
--
-- One function rather than two, for the reason 0360 gives: the AAD binds the
-- ciphertext to this tenant, and a half-applied change leaves a secret sealed
-- against settings that have moved on — a configuration nobody can sign in
-- against and nobody can see is broken.
--
-- The caller encrypts. It has the KEK provider; the database has never had it.
-- What arrives here is ciphertext.
--
-- THE SLUG IS FIXED ON FIRST WRITE. On conflict it is deliberately not in the
-- SET list: the redirect URI is registered by hand at the identity provider,
-- and moving the path silently turns every sign-in into an error that appears
-- at the IdP rather than in Helm. Changing it means forgetting the provider and
-- configuring it again, which is the same work the IdP side needs anyway.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_oidc_provider(
  p_enabled       boolean,
  p_slug          text,
  p_display_name  text,
  p_issuer        text,
  p_client_id     text,
  p_scopes        text[],
  p_allow_signup  boolean,
  p_link_by_email boolean,
  p_wrap_provider text,
  p_kek_id        text,
  p_wrapped_dek   bytea,
  p_ciphertext    bytea,
  p_nonce         bytea,
  p_tag           bytea,
  p_aad           text
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
  v_slug   text;
BEGIN
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: configuring authentication requires tenant:write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT o.slug INTO v_slug FROM oidc_provider o WHERE o.tenant_id = v_tenant;

  IF v_slug IS NOT NULL AND v_slug <> p_slug THEN
    RAISE EXCEPTION 'helm: the sign-in path cannot be changed once it is registered (it is %)', v_slug
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'Remove the provider and configure it again, then update the redirect URI at the identity provider.';
  END IF;

  INSERT INTO oidc_provider (
    tenant_id, enabled, slug, display_name, issuer, client_id, scopes,
    allow_signup, link_by_email,
    wrap_provider, kek_id, wrapped_dek,
    secret_ciphertext, secret_nonce, secret_tag, secret_aad,
    created_by, updated_by)
  VALUES (
    v_tenant, p_enabled, p_slug, btrim(p_display_name), btrim(p_issuer),
    btrim(p_client_id), p_scopes, p_allow_signup, p_link_by_email,
    p_wrap_provider, p_kek_id, p_wrapped_dek,
    p_ciphertext, p_nonce, p_tag, p_aad, v_actor, v_actor)
  ON CONFLICT (tenant_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    display_name = EXCLUDED.display_name,
    issuer = EXCLUDED.issuer,
    client_id = EXCLUDED.client_id,
    scopes = EXCLUDED.scopes,
    allow_signup = EXCLUDED.allow_signup,
    link_by_email = EXCLUDED.link_by_email,
    wrap_provider = EXCLUDED.wrap_provider,
    kek_id = EXCLUDED.kek_id,
    wrapped_dek = EXCLUDED.wrapped_dek,
    secret_ciphertext = EXCLUDED.secret_ciphertext,
    secret_nonce = EXCLUDED.secret_nonce,
    secret_tag = EXCLUDED.secret_tag,
    secret_aad = EXCLUDED.secret_aad,
    -- A settings change invalidates whatever the last test proved.
    last_test_at = NULL,
    last_test_ok = NULL,
    last_test_error = NULL,
    updated_by = v_actor;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.update_oidc_settings — change everything but the secret.
--
-- Exists so that adding a scope does not require re-typing the client secret,
-- which is the kind of friction that ends with the secret in a shared note.
-- The slug is absent from the signature entirely rather than accepted and
-- ignored — an argument that does nothing is worse than no argument.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.update_oidc_settings(
  p_enabled       boolean,
  p_display_name  text,
  p_issuer        text,
  p_client_id     text,
  p_scopes        text[],
  p_allow_signup  boolean,
  p_link_by_email boolean
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
  v_rows   integer;
BEGIN
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: configuring authentication requires tenant:write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE oidc_provider SET
    enabled = p_enabled,
    display_name = btrim(p_display_name),
    issuer = btrim(p_issuer),
    client_id = btrim(p_client_id),
    scopes = p_scopes,
    allow_signup = p_allow_signup,
    link_by_email = p_link_by_email,
    last_test_at = NULL,
    last_test_ok = NULL,
    last_test_error = NULL,
    updated_by = v_actor
  WHERE tenant_id = v_tenant;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.forget_oidc_provider — turn the door off and take the key with it.
--
-- Deletes rather than clearing `enabled`, so a decommissioned provider does not
-- leave its client secret sitting in the database indefinitely. Same reasoning
-- as forget_radius_config().
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.forget_oidc_provider() RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_rows   integer;
BEGIN
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: configuring authentication requires tenant:write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM oidc_provider WHERE tenant_id = v_tenant;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.record_oidc_test — remember what discovery found.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_oidc_test(
  p_tenant_id uuid,
  p_ok        boolean,
  p_error     text DEFAULT NULL
) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  UPDATE oidc_provider
  SET last_test_at = now(), last_test_ok = p_ok, last_test_error = left(p_error, 500)
  WHERE tenant_id = p_tenant_id;
$$;

-- -----------------------------------------------------------------------------
-- helm.stamp_session_method — label a session Auth.js created.
--
-- auth_session.auth_method defaults to 'sso' because the Auth.js adapter INSERTs
-- with only the three columns it knows about. That default is right for Entra
-- and wrong for a generic OIDC provider, which would otherwise be indistinguishable
-- from Entra in an audit trail — the exact distinction 0405 added the value for.
--
-- Called immediately after the adapter creates the session, by the one role
-- that may touch auth_session at all. Narrow on purpose: it sets one column,
-- only on a session that exists, and cannot move a session between users.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.stamp_session_method(
  p_session_token text,
  p_method        auth_method,
  p_ip            inet DEFAULT NULL,
  p_user_agent    text DEFAULT NULL
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE auth_session
  SET auth_method = p_method,
      ip = coalesce(p_ip, ip),
      user_agent = coalesce(left(p_user_agent, 400), user_agent)
  WHERE session_token = p_session_token;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- =============================================================================
-- Grants
-- =============================================================================

-- The table itself: helm_auth and nobody else. Same boundary radius_config and
-- local_credential.password_phc sit behind, for the same reason.
REVOKE ALL ON oidc_provider FROM PUBLIC, helm_app, helm_worker, helm_auditor, helm_key_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON oidc_provider TO helm_auth;

REVOKE ALL ON FUNCTION helm.scopes_well_formed(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.oidc_signin_options() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.oidc_provider_by_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.oidc_provider_for_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.oidc_settings() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_oidc_provider(
  boolean, text, text, text, text, text[], boolean, boolean,
  text, text, bytea, bytea, bytea, bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.update_oidc_settings(
  boolean, text, text, text, text[], boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.forget_oidc_provider() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_oidc_test(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.stamp_session_method(text, auth_method, inet, text) FROM PUBLIC;

-- Reading the client secret is a pre-authentication act, so it belongs to the
-- pre-authentication role and to nothing else. So is labelling the session that
-- pre-authentication just produced.
GRANT EXECUTE ON FUNCTION helm.oidc_signin_options() TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.oidc_provider_by_slug(text) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.oidc_provider_for_tenant(uuid) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.record_oidc_test(uuid, boolean, text) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.stamp_session_method(text, auth_method, inet, text) TO helm_auth;

-- Writing it is an administrative act inside a tenant context, so it belongs to
-- the application role — which still cannot read back what it wrote.
GRANT EXECUTE ON FUNCTION helm.oidc_settings() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_oidc_provider(
  boolean, text, text, text, text, text[], boolean, boolean,
  text, text, bytea, bytea, bytea, bytea, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.update_oidc_settings(
  boolean, text, text, text, text[], boolean, boolean) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.forget_oidc_provider() TO helm_app;

-- The scope predicate is referenced by a CHECK constraint, so every role that
-- can write the table must be able to execute it. That is helm_auth only.
GRANT EXECUTE ON FUNCTION helm.scopes_well_formed(text[]) TO helm_auth, helm_app;

-- =============================================================================
-- Guards
--
-- Structural, and checked at migration time rather than asserted in a test that
-- may not be run. Each is a boundary that one convenient grant would erase.
-- =============================================================================
DO $oidc_guard$
DECLARE
  v_col text;
  v_bad text;
BEGIN
  -- 1. helm_app cannot read the client secret, or anything else on this table.
  --    Checked per column rather than on the table, because a column-level
  --    grant is exactly the shortcut somebody takes to "just show the issuer
  --    on the settings page" and it would not show up in a table-level test.
  FOR v_col IN
    SELECT column_name FROM information_schema.columns WHERE table_name = 'oidc_provider'
  LOOP
    IF has_column_privilege('helm_app', 'oidc_provider', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'helm: helm_app can read oidc_provider.%', v_col;
    END IF;
  END LOOP;

  -- 2. Nor can any other runtime role. helm_worker is a MEMBER of helm_app, so
  --    it is named explicitly: a REVOKE naming it would have been a no-op, and
  --    a privilege inherited through membership is still a privilege.
  FOREACH v_col IN ARRAY ARRAY['helm_worker', 'helm_auditor', 'helm_key_admin'] LOOP
    IF has_table_privilege(v_col, 'oidc_provider', 'SELECT') THEN
      RAISE EXCEPTION 'helm: % can read oidc_provider', v_col;
    END IF;
  END LOOP;

  -- 3. helm_auth can, because pre-authentication is its whole job.
  IF NOT has_table_privilege('helm_auth', 'oidc_provider', 'SELECT') THEN
    RAISE EXCEPTION 'helm: helm_auth cannot read oidc_provider, so nobody can sign in';
  END IF;

  -- 4. The secret-bearing lookups are not reachable from the application role.
  --    oidc_settings() is the one helm_app gets, and its result type has no
  --    envelope columns in it at all.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'helm'
    AND p.proname IN ('oidc_provider_by_slug', 'oidc_provider_for_tenant')
    AND has_function_privilege('helm_app', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'helm: helm_app can execute secret-bearing OIDC lookups: %', v_bad;
  END IF;

  -- 5. And helm_app must still be able to CONFIGURE one, or the settings page
  --    is decorative. Write without read is the whole shape of this boundary.
  IF NOT has_function_privilege('helm_app',
        'helm.set_oidc_provider(boolean, text, text, text, text, text[], boolean, boolean, text, text, bytea, bytea, bytea, bytea, text)',
        'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app cannot configure an OIDC provider';
  END IF;

  -- 6. helm_app must never reach auth_session — §21 of the security model. The
  --    stamping function is SECURITY DEFINER and granted to helm_auth alone;
  --    this confirms the grant did not widen.
  IF has_function_privilege('helm_app',
        'helm.stamp_session_method(text, auth_method, inet, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app can stamp sessions, which means it can reach auth_session';
  END IF;
END;
$oidc_guard$;
