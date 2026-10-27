-- =============================================================================
-- 1120 — the browser extension, lookup and copy
--
-- The schema has carried the extension since 0020 (browser_extension_install,
-- the browser_extension token type) and 0070/0210 (credential_domain and its
-- resolver), and nothing has ever written a row. This is the first consumer:
-- a Chrome, Edge and Brave extension that shows a technician the credentials
-- for the site in front of them and copies a username, password or one-time
-- code. It does not fill forms.
--
-- WHAT THE EXTENSION HOLDS. A device key pair it made itself, the private half
-- non-extractable (WebCrypto), and a `helm_be_` token. The token is useless on
-- its own: every request it authenticates must also carry a signature by the
-- device key over the method, path, time and body, verified against the
-- public key recorded here when the person approved the pairing. So a token
-- lifted from the extension's storage, a log or a proxy is not a vault key.
-- authenticate_api_token() therefore returns the device key with the token,
-- which is the one change to the pre-context boundary, and it stays three
-- functions.
--
-- WHO MAY PAIR. A person, from a browser session, whose role is MSP-side
-- (tenant-wide). Not a co-managed client user, not a service account, and not
-- a request that itself authenticated with a token. A pairing is approved by
-- the same person in the same moment, in a signed-in Helm tab: the extension
-- cannot pair itself.
--
-- WHAT IT MAY REVEAL. helm.reveal_secret() gains one rung: a request
-- authenticated by an extension token may reveal for 'copy', 'autofill' and
-- 'totp' only, and a password only when its secret is 'standard'. Elevated and
-- critical credentials stay in Helm. Step-up was already unreachable to any
-- token (0750).
--
-- THE PERSONAL VAULT. 1030 said no API token may read one, and the policy
-- relied on a token's actor never being a person — true for a service account,
-- not for a personal token (0750), whose actor IS the person. So a personal
-- token could in fact read its owner's vault. The owner policy now requires a
-- request with no token at all, which closes that, and a second, read-only
-- policy lets the extension read its own person's entries. The extension
-- cannot write, change or delete one.
--
-- LIFETIME. An extension token lives 30 days and is renewed by the extension
-- while in use (helm.renew_browser_extension_token), each renewal revoking the
-- one before it. Unused for 30 days, it lapses and the person pairs again.
-- Revoking the pairing, disabling the person, or ending their membership stops
-- it on the next request.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- The token that authenticated this request, by type.
--
-- SECURITY DEFINER because api_token's read policy is tenant-wide-only and this
-- is asked on behalf of anybody. It returns one enum value about the caller's
-- own request and nothing else.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.current_api_token_type()
  RETURNS api_token_type
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT t.token_type
  FROM api_token t
  WHERE t.id = nullif(current_setting('helm.api_token_id', true), '')::uuid
    AND t.tenant_id = helm.current_tenant_id();
$$;

COMMENT ON FUNCTION helm.current_api_token_type() IS
  'The type of the API token that authenticated the current request, or NULL '
  'for a browser session (1120).';

REVOKE ALL ON FUNCTION helm.current_api_token_type() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.current_api_token_type() TO helm_app;

-- -----------------------------------------------------------------------------
-- The host of a URL as somebody typed it into a credential.
--
-- Lowercased, without scheme, userinfo, port, path or a trailing dot; an IPv6
-- literal keeps its brackets, which is how a browser reports one. "acme.com",
-- "https://admin@acme.com:8443/login" and "HTTPS://ACME.COM." all give
-- "acme.com". A Unicode host stays Unicode and so never equals the punycode a
-- browser reports, which is the safe direction for a lookalike to fail in.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.url_host(p_url text)
  RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT nullif(
    rtrim(lower(substring(btrim(p_url)
      FROM '^(?:[A-Za-z][A-Za-z0-9+.-]*://)?(?:[^@/?#[:space:]]*@)?(\[[^]]*\]|[^:/?#[:space:]]+)')), '.'),
    '');
$$;

COMMENT ON FUNCTION helm.url_host(text) IS
  'The lowercased host of a URL or bare hostname, for matching a credential to '
  'the site a browser is on (1120).';

GRANT EXECUTE ON FUNCTION helm.url_host(text) TO helm_app;

-- -----------------------------------------------------------------------------
-- The pre-context boundary, with the device key.
--
-- 0270's function, with one column added: the public key of the live, approved
-- extension pairing this token belongs to, NULL for any other token or for a
-- pairing that has been revoked. The request path refuses an extension token
-- that arrives without a valid signature by this key, and refuses one whose
-- key is NULL outright. A new column changes the return type, so the function
-- is dropped and created, and its grant restored.
-- -----------------------------------------------------------------------------
DROP FUNCTION helm.authenticate_api_token(text);

CREATE FUNCTION helm.authenticate_api_token(p_token_prefix text)
  RETURNS TABLE (
    token_id           uuid,
    tenant_id          uuid,
    token_hash         bytea,
    token_type         api_token_type,
    service_account_id uuid,
    user_id            uuid,
    scopes             text[],
    ip_allowlist       inet[],
    expires_at         timestamptz,
    revoked_at         timestamptz,
    subject_disabled   boolean,
    tenant_active      boolean,
    device_public_key  bytea
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT
    t.id,
    t.tenant_id,
    t.token_hash,
    t.token_type,
    t.service_account_id,
    t.user_id,
    t.scopes,
    t.ip_allowlist,
    t.expires_at,
    t.revoked_at,
    -- A disabled service account or user must not authenticate, even with a
    -- token that is otherwise perfectly valid. Offboarding a technician has to
    -- take effect everywhere at once.
    coalesce(sa.disabled_at IS NOT NULL, u.disabled_at IS NOT NULL, false),
    ten.status = 'active',
    (SELECT i.device_public_key
       FROM browser_extension_install i
      WHERE i.api_token_id = t.id
        AND i.tenant_id = t.tenant_id
        AND i.approved_at IS NOT NULL
        AND i.revoked_at IS NULL
      ORDER BY i.created_at DESC
      LIMIT 1)
  FROM api_token t
  JOIN tenant ten ON ten.id = t.tenant_id
  LEFT JOIN service_account sa ON sa.id = t.service_account_id
  LEFT JOIN app_user u ON u.id = t.user_id
  WHERE t.token_prefix = p_token_prefix;
$$;

COMMENT ON FUNCTION helm.authenticate_api_token(text) IS
  'Authentication boundary: resolves a token prefix to its identity before any '
  'tenant context exists. Returns no tenant data and makes no authorisation '
  'decision — set_session_context() does that from the membership row. Since '
  '1120 it also returns the device key an extension token''s requests must be '
  'signed with.';

REVOKE ALL ON FUNCTION helm.authenticate_api_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.authenticate_api_token(text) TO helm_app;

-- -----------------------------------------------------------------------------
-- reveal_secret, with the extension rung.
--
-- Copied from the LIVE definition (0590), as 0590 copied 0400's, so no earlier
-- rung can be lost to a hand-merge; the guard at the end checks they are all
-- still there.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.reveal_secret(p_secret_id uuid, p_reason text DEFAULT NULL::text, p_purpose text DEFAULT 'view'::text, p_version integer DEFAULT NULL::integer)
 RETURNS TABLE(granted boolean, denial_reason text, audit_event_uid uuid, secret_id uuid, version integer, kind secret_kind, algorithm text, ciphertext bytea, nonce bytea, auth_tag bytea, aad text, data_key_id uuid, wrapped_dek bytea, kek_id text, wrap_provider text, wrap_context jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'helm', 'extensions', 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_tenant   uuid := helm.current_tenant_id();
  v_secret   secret%ROWTYPE;
  v_version  secret_version%ROWTYPE;
  v_key      tenant_data_key%ROWTYPE;
  v_deny     text := NULL;
  v_event    uuid;
  v_target   integer;
  v_purposes text[];
  -- 1120: a request made by the browser extension. Read once, here, from the
  -- token that authenticated it, never from anything the request says.
  v_extension boolean := helm.current_api_token_type() IS NOT DISTINCT FROM 'browser_extension';
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'helm: no tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_purpose NOT IN ('view', 'copy', 'autofill', 'export', 'integration', 'rotation', 'totp') THEN
    RAISE EXCEPTION 'helm: unknown reveal purpose %', p_purpose
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_secret FROM secret
  WHERE id = p_secret_id AND tenant_id = v_tenant AND deleted_at IS NULL;

  -- Unknown and out-of-scope are the same answer on purpose: probing for secret
  -- ids must not distinguish "no such secret" from "not yours".
  IF NOT FOUND OR NOT helm.org_in_scope(v_secret.organization_id) THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', p_secret_id, 'denied',
                          NULL, NULL, p_reason,
                          jsonb_build_object('purpose', p_purpose, 'cause', 'not_found_or_out_of_scope'));
    RETURN QUERY SELECT false, 'not_found', v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  -- A machine identity may be pinned to the purposes its job actually has.
  IF helm.current_actor_type() = 'service_account' THEN
    SELECT sa.allowed_reveal_purposes INTO v_purposes
    FROM service_account sa
    WHERE sa.id = helm.current_actor_id() AND sa.tenant_id = v_tenant;
  END IF;

  -- Authorisation ladder, most specific refusal first.
  -- Visibility leads the ladder. Until 0390 this rung did not exist, and a
  -- credential on an internal-only asset was withheld from a co-managed client
  -- only because the shipped client roles happen to hold neither secret:reveal
  -- nor a rank reaching any secret — two coincidences, not a rule.
  --
  -- First rather than last because the audit row records the reason, and "your
  -- rank is too low" is a different fact from "you may not see this at all".
  -- The second is the one an MSP needs when the client asks why.
  IF NOT helm.is_tenant_wide() AND NOT helm.secret_node_visible(v_secret.id) THEN
    v_deny := 'internal_only';
  ELSIF NOT helm.has_permission('secret:reveal') THEN
    v_deny := 'missing_permission';
  ELSIF v_purposes IS NOT NULL AND NOT (p_purpose = ANY (v_purposes)) THEN
    v_deny := 'purpose_not_permitted_for_actor';
  ELSIF v_extension AND p_purpose NOT IN ('copy', 'autofill', 'totp') THEN
    -- 1120. The extension copies, fills and asks for a code; it never "views",
    -- exports, rotates or integrates, so a stolen extension token cannot be
    -- made to read like any of those in the audit log.
    v_deny := 'not_permitted_for_extension';
  ELSIF v_extension AND p_purpose <> 'totp' AND v_secret.sensitivity <> 'standard' THEN
    -- 1120. Only a standard password leaves through a browser extension,
    -- whatever the purpose: the autofill rung below said so for filling, and
    -- this says it for copying too. Elevated and critical credentials are
    -- copied from Helm itself, where the person is in front of the page.
    -- A TOTP seed is stored elevated by design (0590), so a code is gated by
    -- the seed's own step-up and reason rules instead, which a token cannot
    -- satisfy for anything critical.
    v_deny := 'not_permitted_for_extension';
  ELSIF v_secret.kind = 'totp_seed' AND p_purpose NOT IN ('totp', 'export', 'rotation') THEN
    -- A TOTP seed is a code-generating key with no expiry. Handed to a browser
    -- once, every future code for that account is computable off the record
    -- forever, which makes the secret:reveal gate on the code endpoint
    -- decorative. The seed comes out for exactly three reasons: to compute the
    -- current code ('totp'), to hand the account back to a client who needs to
    -- re-enrol ('export', itself gated on a live export job below), and to
    -- re-wrap it under a new key ('rotation').
    v_deny := 'seed_not_directly_revealable';
  ELSIF p_purpose = 'totp' AND v_secret.kind <> 'totp_seed' THEN
    -- The inverse, and not pedantry. Without it 'totp' would be a purpose any
    -- caller could attach to a password reveal, and the audit row for reading a
    -- domain admin password would read like somebody glancing at an MFA code.
    v_deny := 'not_a_totp_seed';
  ELSIF helm.current_role_rank() < v_secret.min_role_rank THEN
    v_deny := 'insufficient_role_rank';
  ELSIF v_secret.requires_step_up AND NOT helm.step_up_verified() THEN
    v_deny := 'step_up_required';
  ELSIF v_secret.requires_reason AND coalesce(length(btrim(p_reason)), 0) < 10 THEN
    v_deny := 'reason_required';
  ELSIF p_purpose = 'export' AND NOT helm.has_permission('secret:export') THEN
    v_deny := 'export_not_permitted';
  ELSIF p_purpose = 'export' AND NOT helm.is_in_live_secret_export(v_secret.id) THEN
    -- Reached by the export worker, whose whole capability is this purpose.
    -- Re-derived from export_job every time, so a job revoked mid-render stops
    -- yielding material immediately. Until 0400 this also required the job to
    -- have been APPROVED — which, with approval removed, would have meant the
    -- worker could never reveal anything and every credential export rendered
    -- silently empty.
    v_deny := 'not_in_a_live_export';
  ELSIF p_purpose = 'integration' AND NOT helm.is_integration_credential(v_secret.id) THEN
    v_deny := 'not_an_integration_credential';
  ELSIF p_purpose = 'autofill' AND v_secret.sensitivity <> 'standard' THEN
    -- Elevated and critical credentials are never auto-filled into a browser.
    -- A domain admin password belongs in a deliberate, observed copy action.
    v_deny := 'autofill_not_permitted_for_sensitivity';
  END IF;

  IF v_deny IS NOT NULL THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', v_secret.id, 'denied',
                          v_secret.organization_id, v_secret.id, p_reason,
                          jsonb_build_object(
                            'purpose', p_purpose,
                            'cause', v_deny,
                            'sensitivity', v_secret.sensitivity,
                            'required_rank', v_secret.min_role_rank,
                            'actor_rank', helm.current_role_rank()));
    RETURN QUERY SELECT false, v_deny, v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  v_target := coalesce(p_version, v_secret.current_version);

  SELECT * INTO v_version FROM secret_version sv
  WHERE sv.secret_id = v_secret.id AND sv.version = v_target;

  IF NOT FOUND THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', v_secret.id, 'error',
                          v_secret.organization_id, v_secret.id, p_reason,
                          jsonb_build_object('purpose', p_purpose, 'cause', 'no_such_version',
                                             'requested_version', v_target));
    RETURN QUERY SELECT false, 'no_such_version', v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_key FROM tenant_data_key WHERE id = v_version.data_key_id;

  IF v_key.status = 'destroyed' THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', v_secret.id, 'error',
                          v_secret.organization_id, v_secret.id, p_reason,
                          jsonb_build_object('purpose', p_purpose, 'cause', 'key_destroyed',
                                             'data_key_id', v_key.id));
    RETURN QUERY SELECT false, 'key_destroyed', v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  -- Granted. The audit row and the material leave together.
  v_event := helm.audit(
    'secret.revealed', 'secret', v_secret.id, 'success',
    v_secret.organization_id, v_secret.id, p_reason,
    jsonb_build_object(
      'purpose',      p_purpose,
      'version',      v_version.version,
      'kind',         v_secret.kind,
      'sensitivity',  v_secret.sensitivity,
      'label',        v_secret.label,
      'data_key_id',  v_key.id,
      'step_up',      helm.step_up_verified()));

  UPDATE secret
  SET last_accessed_at = now(), access_count = access_count + 1
  WHERE id = v_secret.id;

  RETURN QUERY SELECT
    true, NULL::text, v_event,
    v_secret.id, v_version.version, v_secret.kind, v_version.algorithm,
    v_version.ciphertext, v_version.nonce, v_version.auth_tag, v_version.aad,
    v_key.id, v_key.wrapped_dek, v_key.kek_id, v_key.wrap_provider, v_key.wrap_context;
END;
$function$;

-- -----------------------------------------------------------------------------
-- Pairing.
--
-- Writes the extension's token and its install row together, approved by the
-- person making the request: the pairing page is a signed-in Helm tab, and the
-- approval is that person pressing the button in it. Returns the ids; the
-- token itself was minted by the application and only its hash comes here.
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
  -- needs, narrowed to the ones this person holds.
  SELECT coalesce(array_agg(p ORDER BY p), '{}') INTO v_scopes
  FROM unnest(ARRAY['asset:read', 'organization:read', 'secret:read', 'secret:reveal']) AS p
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
-- Renewal: the extension swaps its token for a fresh one while it is in use.
--
-- Only from a request that authenticated with a live extension token (and so,
-- in the application, with a signature by the pairing's device key), only for
-- a person still MSP-side, and the old token is revoked in the same statement.
-- So there is never more than one live token per pairing.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.renew_browser_extension_token(
  p_token_prefix text,
  p_token_hash   bytea,
  p_expires_at   timestamptz
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_actor   uuid := helm.current_actor_id();
  v_tenant  uuid := helm.require_tenant_id();
  v_current uuid := nullif(current_setting('helm.api_token_id', true), '')::uuid;
  v_old     api_token%ROWTYPE;
  v_install uuid;
  v_token   uuid;
BEGIN
  SELECT t.* INTO v_old
  FROM api_token t
  WHERE t.id = v_current
    AND t.tenant_id = v_tenant
    AND t.user_id = v_actor
    AND t.token_type = 'browser_extension'
    AND t.revoked_at IS NULL
    AND t.expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: only the browser extension can renew its own token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT i.id INTO v_install
  FROM browser_extension_install i
  WHERE i.api_token_id = v_old.id
    AND i.approved_at IS NOT NULL
    AND i.revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: this browser is no longer paired'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT helm.is_tenant_wide() THEN
    RAISE EXCEPTION 'helm: the browser extension is for MSP staff'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '31 days' THEN
    RAISE EXCEPTION 'helm: an extension token expires within 31 days';
  END IF;

  INSERT INTO api_token (
    tenant_id, token_type, user_id, name, token_prefix, token_hash, scopes, expires_at, created_by
  ) VALUES (
    v_tenant, 'browser_extension', v_actor, v_old.name, p_token_prefix, p_token_hash,
    v_old.scopes, p_expires_at, v_actor
  )
  RETURNING id INTO v_token;

  UPDATE browser_extension_install SET api_token_id = v_token WHERE id = v_install;
  UPDATE api_token SET revoked_at = now(), revoked_reason = 'renewed by the extension'
  WHERE id = v_old.id;

  PERFORM helm.audit(
    'browser_extension.renewed', 'browser_extension_install', v_install, 'success', NULL, NULL, NULL,
    jsonb_build_object('tokenPrefix', p_token_prefix, 'previousPrefix', v_old.token_prefix,
                       'expiresAt', p_expires_at)
  );

  RETURN v_token;
END;
$$;

-- -----------------------------------------------------------------------------
-- Your paired browsers, and taking one away.
--
-- SECURITY DEFINER for the reason my_api_tokens() is: these rows are the
-- person's own, and the table's policy is about the tenant. Nothing secret is
-- returned; the key is reduced to a fingerprint the extension also shows.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.my_browser_extensions()
  RETURNS TABLE (
    id                uuid,
    device_label      text,
    browser           text,
    extension_version text,
    key_sha256        text,
    paired_at         timestamptz,
    last_used_at      timestamptz,
    last_used_ip      inet,
    expires_at        timestamptz,
    revoked_at        timestamptz,
    is_current        boolean
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT i.id, i.device_label, i.browser, i.extension_version,
         encode(sha256(i.device_public_key), 'hex'),
         i.created_at, t.last_used_at, t.last_used_ip, t.expires_at, i.revoked_at,
         t.id IS NOT NULL AND t.id = nullif(current_setting('helm.api_token_id', true), '')::uuid
  FROM browser_extension_install i
  LEFT JOIN api_token t ON t.id = i.api_token_id
  WHERE i.user_id = helm.current_actor_id()
    AND i.tenant_id = helm.current_tenant_id()
    -- Removed and lapsed pairings stay for a month, so "did that take" has
    -- an answer on the page, then drop off.
    AND coalesce(i.revoked_at, now()) > now() - interval '30 days'
    AND coalesce(t.expires_at, now()) > now() - interval '30 days'
  ORDER BY (i.revoked_at IS NULL AND t.expires_at > now()) DESC, i.created_at DESC;
$$;

CREATE OR REPLACE FUNCTION helm.revoke_my_browser_extension(p_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := helm.current_actor_id();
  v_token uuid;
BEGIN
  IF v_actor IS NULL OR helm.current_actor_type() <> 'user' THEN
    RAISE EXCEPTION 'helm: no person in context' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE browser_extension_install i
  SET revoked_at = now()
  WHERE i.id = p_id
    AND i.user_id = v_actor
    AND i.tenant_id = helm.current_tenant_id()
    AND i.revoked_at IS NULL
  RETURNING i.api_token_id INTO v_token;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE api_token SET revoked_at = now(), revoked_reason = 'browser unpaired'
  WHERE id = v_token AND revoked_at IS NULL;

  PERFORM helm.audit('browser_extension.revoked', 'browser_extension_install', p_id, 'success');
  RETURN true;
END;
$$;

COMMENT ON FUNCTION helm.pair_browser_extension(text, text, text, bytea, text, bytea, timestamptz) IS
  'Pair a browser extension for the current person: MSP staff, from a session, '
  'approved in the same request. Writes the token and the install together. Audited.';
COMMENT ON FUNCTION helm.renew_browser_extension_token(text, bytea, timestamptz) IS
  'Swap a live extension token for a fresh one and revoke the old one. Only the '
  'extension itself, for its own pairing. Audited.';
COMMENT ON FUNCTION helm.revoke_my_browser_extension(uuid) IS
  'Unpair one of the current person''s browsers and revoke its token. False when '
  'the id is not theirs or already revoked.';

REVOKE ALL ON FUNCTION helm.pair_browser_extension(text, text, text, bytea, text, bytea, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.renew_browser_extension_token(text, bytea, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.my_browser_extensions() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.revoke_my_browser_extension(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.pair_browser_extension(text, text, text, bytea, text, bytea, timestamptz) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.renew_browser_extension_token(text, bytea, timestamptz) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.my_browser_extensions() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.revoke_my_browser_extension(uuid) TO helm_app;

-- -----------------------------------------------------------------------------
-- The personal vault: the owner, from a session, for everything; the owner's
-- own extension, for reading.
--
-- The owner policy is replaced rather than widened: it now requires a request
-- with no token at all, which is what 1030 meant by "not an API token". The
-- read policy beside it admits exactly one kind of token, and only for SELECT,
-- so the extension can list and open an entry and cannot write, change or
-- delete one.
-- -----------------------------------------------------------------------------
DROP POLICY personal_credential_owner ON personal_credential;

CREATE POLICY personal_credential_owner ON personal_credential
  FOR ALL TO helm_app
  USING (
    tenant_id = helm.current_tenant_id()
    AND helm.current_actor_type() = 'user'
    AND owner_user_id = helm.current_actor_id()
    AND nullif(current_setting('helm.api_token_id', true), '') IS NULL
  )
  WITH CHECK (
    tenant_id = helm.current_tenant_id()
    AND helm.current_actor_type() = 'user'
    AND owner_user_id = helm.current_actor_id()
    AND nullif(current_setting('helm.api_token_id', true), '') IS NULL
  );

CREATE POLICY personal_credential_owner_extension ON personal_credential
  FOR SELECT TO helm_app
  USING (
    tenant_id = helm.current_tenant_id()
    AND helm.current_actor_type() = 'user'
    AND owner_user_id = helm.current_actor_id()
    AND helm.current_api_token_type() = 'browser_extension'
  );

-- =============================================================================
-- Guards
-- =============================================================================
DO $guard$
DECLARE
  v_count integer;
BEGIN
  -- 1. The pre-context boundary is still exactly three functions.
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'helm' AND p.prosecdef
    AND p.proname IN ('authenticate_api_token', 'record_api_token_use', 'memberships_for_user');
  IF v_count <> 3 THEN
    RAISE EXCEPTION '1120: expected exactly 3 pre-context authentication functions, found %', v_count;
  END IF;

  -- 2. Every rung reveal_secret had before is still there, and the new one is.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'reveal_secret'
      AND p.prosrc LIKE '%secret_node_visible%'
      AND p.prosrc LIKE '%min_role_rank%'
      AND p.prosrc LIKE '%step_up_verified%'
      AND p.prosrc LIKE '%is_in_live_secret_export%'
      AND p.prosrc LIKE '%autofill_not_permitted_for_sensitivity%'
      AND p.prosrc LIKE '%seed_not_directly_revealable%'
      AND p.prosrc LIKE '%not_a_totp_seed%'
      AND p.prosrc LIKE '%not_permitted_for_extension%'
  ) THEN
    RAISE EXCEPTION '1120: reveal_secret lost a rung';
  END IF;

  -- 3. Nothing but the owner reads a personal vault, and only the owner's
  --    session writes one.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'personal_credential' AND 'helm_app' = ANY (roles)
      AND policyname NOT IN ('personal_credential_owner', 'personal_credential_owner_extension')
  ) THEN
    RAISE EXCEPTION '1120: a third policy would widen who reads a personal vault';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'personal_credential' AND policyname = 'personal_credential_owner_extension'
      AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION '1120: the extension''s vault policy must be read-only';
  END IF;
END
$guard$;
