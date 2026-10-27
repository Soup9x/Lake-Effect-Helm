-- =============================================================================
-- 1121 — the browser extension: pairing behind a password, and suggestions
--
-- PAIRING ASKS FOR THE PASSWORD AGAIN. 1120 paired a browser from any signed-in
-- Helm tab. That made a session the whole of the proof, and a session is the
-- thing most likely to be left open on a desk. A pairing is a 30-day
-- credential that outlives the session, so it now takes what a reveal of a
-- critical secret takes: a step-up, recorded moments before (0340's
-- step_up_verification, read through helm.step_up_verified()). The pairing
-- route re-checks the password, and the authenticator code when the person
-- has one, records the step-up and then pairs, so a step-up taken earlier for
-- something else does not carry over to this. This function refuses a
-- pairing without one, whatever calls it.
--
-- SUGGESTIONS. When the popup finds nothing for the site in front of it, it
-- offers what the person copied recently and what MSP staff copy most. The
-- audit log is where that history lives, and the extension's token cannot
-- read it (it holds no audit:read, and should not). So
-- helm.extension_credential_activity() reads it on the person's behalf and
-- hands back ids and counts only: no labels, no reasons, no actors. The route
-- then looks those ids up under RLS like any other lookup, so a credential
-- the person cannot open never reaches them, whatever the function returned.
--
--   - Recent is the person's own reveals, client and personal, last 90 days.
--   - Popular is everybody's reveals of client secrets, last 90 days, and
--     only for a tenant-wide caller: how often a client's credential is used
--     is not something a client-side role needs.
--
-- EVERY PAIRED BROWSER, FOR AN ADMINISTRATOR. 1120 let each person see and
-- remove their own pairings. Somebody who manages people (user:write) can now
-- see every pairing in the tenant, whose it is and when it was last used, and
-- revoke one, as they could disable the person. A revocation by somebody else
-- is audited as such, naming whose browser it was.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Pairing: 1120's function, with the step-up rung added after the
-- tenant-wide check. Everything else is unchanged.
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
-- What the person, and their colleagues, have copied lately.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.extension_credential_activity()
RETURNS TABLE (
  activity_entity_type text,
  activity_entity_id   uuid,
  last_used_by_me      timestamptz,
  uses                 bigint
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_actor  uuid := helm.current_actor_id();
  v_tenant uuid := helm.require_tenant_id();
  v_wide   boolean := helm.is_tenant_wide();
BEGIN
  IF v_actor IS NULL OR helm.current_actor_type() <> 'user' THEN
    RAISE EXCEPTION 'helm: suggestions are for a person'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH events AS (
    SELECT a.entity_type, a.entity_id, a.actor_id, a.occurred_at
    FROM audit_log a
    WHERE a.tenant_id = v_tenant
      AND a.occurred_at > now() - interval '90 days'
      AND a.outcome = 'success'
      AND a.entity_id IS NOT NULL
      AND (
        (a.action = 'secret.revealed' AND a.entity_type = 'secret')
        -- Somebody else's vault is nobody's business, not even as a count.
        OR (a.action = 'personal_vault.revealed' AND a.entity_type = 'personal_credential'
            AND a.actor_id = v_actor)
      )
  ),
  mine AS (
    SELECT e.entity_type, e.entity_id, max(e.occurred_at) AS last_used
    FROM events e
    WHERE e.actor_id = v_actor
    GROUP BY e.entity_type, e.entity_id
    ORDER BY max(e.occurred_at) DESC
    LIMIT 25
  ),
  popular AS (
    SELECT e.entity_type, e.entity_id, count(*) AS uses
    FROM events e
    WHERE v_wide AND e.entity_type = 'secret'
    GROUP BY e.entity_type, e.entity_id
    ORDER BY count(*) DESC
    LIMIT 25
  )
  SELECT coalesce(m.entity_type, p.entity_type),
         coalesce(m.entity_id, p.entity_id),
         m.last_used,
         coalesce(p.uses, 0)
  FROM mine m
  FULL JOIN popular p ON p.entity_type = m.entity_type AND p.entity_id = m.entity_id;
END;
$$;

COMMENT ON FUNCTION helm.extension_credential_activity() IS
  'Ids and counts of the current person''s recent reveals and, for tenant-wide '
  'staff, the most revealed client secrets, last 90 days. No labels or actors: '
  'callers resolve the ids under RLS.';

REVOKE ALL ON FUNCTION helm.extension_credential_activity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.extension_credential_activity() TO helm_app;


-- -----------------------------------------------------------------------------
-- Every paired browser in the tenant, for somebody who manages people.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.tenant_browser_extensions()
  RETURNS TABLE (
    id                uuid,
    user_id           uuid,
    user_name         text,
    user_email        text,
    device_label      text,
    browser           text,
    extension_version text,
    key_sha256        text,
    paired_at         timestamptz,
    last_used_at      timestamptz,
    last_used_ip      inet,
    expires_at        timestamptz,
    revoked_at        timestamptz
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF helm.current_actor_type() <> 'user' OR NOT helm.has_permission('user:write') THEN
    RAISE EXCEPTION 'helm: user:write is required to see everybody''s paired browsers'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT i.id, i.user_id, u.name, u.email::text, i.device_label, i.browser, i.extension_version,
         encode(sha256(i.device_public_key), 'hex'),
         i.created_at, t.last_used_at, t.last_used_ip, t.expires_at, i.revoked_at
  FROM browser_extension_install i
  JOIN app_user u ON u.id = i.user_id
  LEFT JOIN api_token t ON t.id = i.api_token_id
  WHERE i.tenant_id = helm.current_tenant_id()
    -- As on the person's own list: removed and lapsed ones for a month.
    AND coalesce(i.revoked_at, now()) > now() - interval '30 days'
    AND coalesce(t.expires_at, now()) > now() - interval '30 days'
  ORDER BY (i.revoked_at IS NULL AND t.expires_at > now()) DESC,
           t.last_used_at DESC NULLS LAST, i.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION helm.revoke_browser_extension(p_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_token uuid;
  v_owner uuid;
BEGIN
  IF helm.current_actor_type() <> 'user' OR NOT helm.has_permission('user:write') THEN
    RAISE EXCEPTION 'helm: user:write is required to revoke somebody else''s browser'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- From a session: an API token holding user:write is a script, and a script
  -- revoking people's browsers is not something anybody asked for.
  IF nullif(current_setting('helm.api_token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'helm: revoke a browser from a signed-in Helm tab'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE browser_extension_install i
  SET revoked_at = now()
  WHERE i.id = p_id
    AND i.tenant_id = helm.current_tenant_id()
    AND i.revoked_at IS NULL
  RETURNING i.api_token_id, i.user_id INTO v_token, v_owner;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE api_token SET revoked_at = now(), revoked_reason = 'browser revoked by an administrator'
  WHERE id = v_token AND revoked_at IS NULL;

  PERFORM helm.audit('browser_extension.revoked', 'browser_extension_install', p_id, 'success',
    NULL, NULL, NULL, jsonb_build_object('by', 'administrator', 'userId', v_owner));
  RETURN true;
END;
$$;

COMMENT ON FUNCTION helm.tenant_browser_extensions() IS
  'Every browser paired in the tenant, live ones first, for somebody holding user:write.';
COMMENT ON FUNCTION helm.revoke_browser_extension(uuid) IS
  'Revoke anybody''s paired browser and its token, from a session holding user:write. '
  'False when the id is unknown or already revoked. Audited.';

REVOKE ALL ON FUNCTION helm.tenant_browser_extensions() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.revoke_browser_extension(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.tenant_browser_extensions() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.revoke_browser_extension(uuid) TO helm_app;

-- -----------------------------------------------------------------------------
-- Guards.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  v_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'pair_browser_extension'
      AND p.prosrc LIKE '%step_up_verified%'
      AND p.prosrc LIKE '%is_tenant_wide%'
      AND p.prosrc LIKE '%helm.api_token_id%'
  ) THEN
    RAISE EXCEPTION '1121: pair_browser_extension must require a step-up, a session and a tenant-wide role';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'helm' AND p.prosecdef
    AND p.proname IN ('authenticate_api_token', 'record_api_token_use', 'memberships_for_user');
  IF v_count <> 3 THEN
    RAISE EXCEPTION '1121: expected exactly 3 pre-context authentication functions, found %', v_count;
  END IF;
END
$guard$;
