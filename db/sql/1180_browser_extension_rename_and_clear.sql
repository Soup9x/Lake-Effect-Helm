-- =============================================================================
-- 1180 — paired browsers can be renamed, and removed ones cleared from the list
--
-- RENAMING. A browser is named once, on the pairing page, and 1120 had no way
-- to change it afterwards. helm.rename_my_browser_extension() renames one of
-- the person's own pairings, live or not, and the token's name with it, so
-- the API tokens list and the audit read the same. Audited with both names.
--
-- CLEARING. Removed and lapsed pairings stayed on the person's list for 30
-- days (1120's my_browser_extensions()), so "did that take" had an answer.
-- With a few extensions reinstalled that is a list of dead rows nobody can get
-- rid of. hidden_at marks a pairing the person has cleared: it leaves their
-- own list at once and nothing else changes. Only a pairing that is already
-- removed or lapsed can be cleared, so clearing never quietly leaves a live
-- browser paired out of sight; a live one is removed first, which revokes it.
--
-- The row is kept. An administrator's list (1121's tenant_browser_extensions())
-- still shows it, and the audit trail still points at it.
-- =============================================================================

ALTER TABLE browser_extension_install ADD COLUMN hidden_at timestamptz;

COMMENT ON COLUMN browser_extension_install.hidden_at IS
  'When the person cleared this removed or lapsed pairing from their own list (1180). '
  'Administrators still see it.';

-- -----------------------------------------------------------------------------
-- Your paired browsers: 1120's function, without the ones you have cleared.
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
    AND i.hidden_at IS NULL
    -- Removed and lapsed pairings stay for a month, so "did that take" has
    -- an answer on the page, then drop off.
    AND coalesce(i.revoked_at, now()) > now() - interval '30 days'
    AND coalesce(t.expires_at, now()) > now() - interval '30 days'
  ORDER BY (i.revoked_at IS NULL AND t.expires_at > now()) DESC, i.created_at DESC;
$$;

-- -----------------------------------------------------------------------------
-- Renaming one of your browsers.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.rename_my_browser_extension(p_id uuid, p_label text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := helm.current_actor_id();
  v_label text := btrim(coalesce(p_label, ''));
  v_old   text;
  v_token uuid;
BEGIN
  IF v_actor IS NULL OR helm.current_actor_type() <> 'user' THEN
    RAISE EXCEPTION 'helm: no person in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_label = '' OR length(v_label) > 80 THEN
    RAISE EXCEPTION 'helm: a paired browser needs a name of at most 80 characters';
  END IF;

  SELECT i.device_label, i.api_token_id INTO v_old, v_token
  FROM browser_extension_install i
  WHERE i.id = p_id
    AND i.user_id = v_actor
    AND i.tenant_id = helm.current_tenant_id()
    AND i.hidden_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_old = v_label THEN
    RETURN true;
  END IF;

  UPDATE browser_extension_install SET device_label = v_label WHERE id = p_id;
  UPDATE api_token SET name = 'Browser extension: ' || v_label WHERE id = v_token;

  PERFORM helm.audit(
    'browser_extension.renamed', 'browser_extension_install', p_id, 'success', NULL, NULL, NULL,
    jsonb_build_object('from', v_old, 'to', v_label)
  );
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- Clearing removed and lapsed browsers from your list: one, or (p_id NULL)
-- all of them. Returns how many were cleared. A live pairing is never touched.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.clear_my_browser_extensions(p_id uuid DEFAULT NULL)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := helm.current_actor_id();
  v_ids   uuid[];
BEGIN
  IF v_actor IS NULL OR helm.current_actor_type() <> 'user' THEN
    RAISE EXCEPTION 'helm: no person in context' USING ERRCODE = 'insufficient_privilege';
  END IF;

  WITH cleared AS (
    UPDATE browser_extension_install i
    SET hidden_at = now()
    WHERE i.user_id = v_actor
      AND i.tenant_id = helm.current_tenant_id()
      AND i.hidden_at IS NULL
      AND (p_id IS NULL OR i.id = p_id)
      AND (
        i.revoked_at IS NOT NULL
        OR NOT EXISTS (
          SELECT 1 FROM api_token t
          WHERE t.id = i.api_token_id AND t.revoked_at IS NULL AND t.expires_at > now()
        )
      )
    RETURNING i.id
  )
  SELECT coalesce(array_agg(id), '{}') INTO v_ids FROM cleared;

  IF cardinality(v_ids) > 0 THEN
    PERFORM helm.audit(
      'browser_extension.cleared', 'browser_extension_install',
      CASE WHEN cardinality(v_ids) = 1 THEN v_ids[1] END, 'success', NULL, NULL, NULL,
      jsonb_build_object('installIds', to_jsonb(v_ids))
    );
  END IF;
  RETURN cardinality(v_ids);
END;
$$;

COMMENT ON FUNCTION helm.rename_my_browser_extension(uuid, text) IS
  'Rename one of the current person''s paired browsers, and its token. False when '
  'the id is not theirs. Audited.';
COMMENT ON FUNCTION helm.clear_my_browser_extensions(uuid) IS
  'Hide the current person''s removed or lapsed pairings (one, or all when the id is '
  'NULL) from their own list. Never touches a live pairing. Audited.';

REVOKE ALL ON FUNCTION helm.my_browser_extensions() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.rename_my_browser_extension(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.clear_my_browser_extensions(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.my_browser_extensions() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.rename_my_browser_extension(uuid, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.clear_my_browser_extensions(uuid) TO helm_app;
