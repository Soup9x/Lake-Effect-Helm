-- =============================================================================
-- 1240  Homarr board links: a Helm status page for a Homarr iFrame widget
-- =============================================================================
--
-- Homarr is a self-hosted dashboard. Its iFrame widget shows any page by URL,
-- and that is the only way it can show Helm: it has no widget that calls
-- somebody else's API with a key. So an administrator makes a LINK here, and
-- Helm serves a small page at /embed/homarr/<token> that Homarr frames.
--
-- WHY NOT A SESSION, OR AN API TOKEN. The frame is loaded by whoever is looking
-- at the Homarr board, in a frame on another origin, where a Helm session
-- cookie is a third-party cookie that browsers drop, and where a bearer header
-- cannot be set at all. The credential has to be in the URL. A URL is a weaker
-- place for a credential than a header, so what the URL opens is made small
-- rather than the URL made strong:
--
--   * It opens ONE page, read-only, and nothing else in Helm. It is not an
--     api_token and no route accepts it as one; there is no actor, no session
--     context and no RLS identity behind it. The page's data comes from one
--     SECURITY DEFINER function, helm.homarr_board_view(), which returns an
--     already-aggregated summary and never a secret, a credential, a note, an
--     address or a contact.
--   * The administrator chooses whether the summary may NAME things (client
--     names and what is expiring) or only COUNT them, because a Homarr board
--     can itself be public, and whoever can see the board sees the frame.
--   * The page may be framed only by the Homarr addresses written on the link
--     (Content-Security-Policy frame-ancestors). Everywhere else in Helm stays
--     X-Frame-Options: DENY.
--   * It is revocable at once, and every use is counted.
--
-- The token is stored as SHA-256 only, with a visible prefix for lookup, the
-- same shape as api_token (0020): helm_hb_<8>.<secret>.
--
-- NOT EXPOSED TO ROLES. Like 1210's tables, nothing at runtime may touch the
-- table directly; the app goes through the functions below. Managing links
-- needs tenant:write. Reading a board needs only the token.
-- =============================================================================

CREATE TABLE homarr_board_link (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  token_prefix     text NOT NULL CHECK (token_prefix ~ '^helm_hb_[A-Za-z0-9]{8}$'),
  token_hash       bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  -- The Homarr addresses allowed to frame the page: scheme, host and port,
  -- nothing else. At least one, because a link nothing may frame is useless,
  -- and "*" is not an address.
  allowed_origins  text[] NOT NULL CHECK (
    cardinality(allowed_origins) BETWEEN 1 AND 10
    AND array_position(allowed_origins, NULL) IS NULL
  ),
  -- false: counts only. true: client names and expiring item labels too.
  show_details     boolean NOT NULL DEFAULT false,
  created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  use_count        bigint NOT NULL DEFAULT 0,
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  CONSTRAINT homarr_board_link_prefix_uk UNIQUE (token_prefix)
);
CREATE INDEX homarr_board_link_tenant_idx ON homarr_board_link (tenant_id, created_at DESC);

-- Origins are checked in SQL as well as by the route, so a row cannot carry
-- something the CSP header would read as a wildcard or a second directive.
CREATE OR REPLACE FUNCTION helm.homarr_origins_ok(p_origins text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(bool_and(o ~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' AND length(o) <= 200), false)
  FROM unnest(p_origins) AS o;
$$;

ALTER TABLE homarr_board_link ADD CONSTRAINT homarr_board_link_origins_shape
  CHECK (helm.homarr_origins_ok(allowed_origins));

COMMENT ON TABLE homarr_board_link IS 'Links that open Helm''s read-only status page in a Homarr iFrame widget (1240). Reached only through helm.homarr_board_links(), helm.create_homarr_board_link(), helm.revoke_homarr_board_link() and helm.homarr_board_view().';

REVOKE ALL ON homarr_board_link FROM PUBLIC, helm_app, helm_auth, helm_worker, helm_key_admin, helm_auditor;

-- And RLS as a second lock, like every table carrying tenant_id: MSP-side, and
-- writes at super_admin's rank, matching tenant:write in the functions. With no
-- grants it decides nothing today; it is here so a future GRANT does not open
-- every tenant's links to every other.
SELECT helm.apply_tenant_rls('homarr_board_link', false, 100, NULL);

-- -----------------------------------------------------------------------------
-- Managing links: tenant:write, in a session.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.require_homarr_admin() RETURNS void
  LANGUAGE plpgsql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM helm.require_tenant_id();
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: Homarr board links are managed by tenant administrators (tenant:write)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION helm.homarr_board_links()
  RETURNS TABLE (
    id uuid, name text, token_prefix text, allowed_origins text[], show_details boolean,
    created_at timestamptz, created_by_name text, last_used_at timestamptz, use_count bigint,
    revoked_at timestamptz
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM helm.require_homarr_admin();
  RETURN QUERY
    SELECT l.id, l.name, l.token_prefix, l.allowed_origins, l.show_details,
           l.created_at, u.name, l.last_used_at, l.use_count, l.revoked_at
    FROM homarr_board_link l
    LEFT JOIN app_user u ON u.id = l.created_by
    WHERE l.tenant_id = helm.current_tenant_id()
    ORDER BY (l.revoked_at IS NULL) DESC, l.created_at DESC
    LIMIT 100;
END;
$$;

-- The token is minted by the app, which hands it to the administrator once;
-- the database is given only the prefix and the hash.
CREATE OR REPLACE FUNCTION helm.create_homarr_board_link(
  p_name text, p_prefix text, p_hash bytea, p_origins text[], p_show_details boolean
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM helm.require_homarr_admin();
  IF (SELECT count(*) FROM homarr_board_link
      WHERE tenant_id = helm.current_tenant_id() AND revoked_at IS NULL) >= 20 THEN
    RAISE EXCEPTION 'helm: revoke a Homarr board link before making another (20 at most)'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO homarr_board_link (tenant_id, name, token_prefix, token_hash, allowed_origins,
                                 show_details, created_by)
  VALUES (helm.current_tenant_id(), btrim(p_name), p_prefix, p_hash, p_origins,
          coalesce(p_show_details, false), helm.current_actor_id())
  RETURNING id INTO v_id;
  PERFORM helm.audit('homarr_board.created', 'homarr_board_link', v_id, 'success', NULL, NULL, NULL,
                     jsonb_build_object('name', btrim(p_name), 'prefix', p_prefix,
                                        'origins', to_jsonb(p_origins),
                                        'showDetails', coalesce(p_show_details, false)));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION helm.revoke_homarr_board_link(p_id uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE v_prefix text;
BEGIN
  PERFORM helm.require_homarr_admin();
  UPDATE homarr_board_link
     SET revoked_at = now(), revoked_by = helm.current_actor_id()
   WHERE id = p_id AND tenant_id = helm.current_tenant_id() AND revoked_at IS NULL
  RETURNING token_prefix INTO v_prefix;
  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'helm: there is no such live Homarr board link' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM helm.audit('homarr_board.revoked', 'homarr_board_link', p_id, 'success', NULL, NULL, NULL,
                     jsonb_build_object('prefix', v_prefix));
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.homarr_board_view — the page's data, for a token and nothing else.
--
-- Runs with NO tenant context: the token is what names the tenant. Returns
-- NULL for an unknown prefix, a wrong secret, a revoked link or an inactive
-- tenant, and the caller answers all four the same way.
--
-- What comes back is counts, integration health, and (only when the link says
-- so) the names of clients and of what is expiring. Nothing else is read.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.homarr_board_view(p_prefix text, p_hash bytea)
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_link   homarr_board_link;
  v_tenant tenant;
  v_counts jsonb;
  v_items  jsonb := '[]'::jsonb;
  v_integrations jsonb;
BEGIN
  SELECT * INTO v_link FROM homarr_board_link WHERE token_prefix = p_prefix;
  IF v_link.id IS NULL OR v_link.token_hash <> p_hash OR v_link.revoked_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_tenant FROM tenant WHERE id = v_link.tenant_id;
  IF v_tenant.id IS NULL OR v_tenant.status <> 'active' THEN
    RETURN NULL;
  END IF;

  UPDATE homarr_board_link SET last_used_at = now(), use_count = use_count + 1 WHERE id = v_link.id;

  WITH live AS (
    SELECT e.*, helm.expiration_severity(e.expires_at, e.criticality) AS severity
    FROM expiration e
    JOIN organization o ON o.id = e.organization_id
    WHERE e.tenant_id = v_link.tenant_id
      AND o.deleted_at IS NULL AND o.archived_at IS NULL
      AND (e.acknowledged_until IS NULL OR e.acknowledged_until < now())
  )
  SELECT jsonb_build_object(
    'expired',  count(*) FILTER (WHERE severity = 'expired'),
    'critical', count(*) FILTER (WHERE severity = 'critical'),
    'warning',  count(*) FILTER (WHERE severity = 'warning'),
    'clients', (SELECT count(*) FROM organization
                WHERE tenant_id = v_link.tenant_id AND deleted_at IS NULL
                  AND archived_at IS NULL AND NOT is_msp_internal),
    'devices', (SELECT count(*) FROM asset_node n
                JOIN organization o ON o.id = n.organization_id
                WHERE n.tenant_id = v_link.tenant_id AND n.node_type = 'device'
                  AND n.archived_at IS NULL AND o.deleted_at IS NULL AND o.archived_at IS NULL)
  ) INTO v_counts
  FROM live;

  IF v_link.show_details THEN
    SELECT coalesce(jsonb_agg(x ORDER BY x->>'expiresAt'), '[]'::jsonb) INTO v_items
    FROM (
      SELECT jsonb_build_object(
        'id', e.id,
        'label', e.label,
        'kind', e.kind,
        'organizationId', e.organization_id,
        'organization', o.name,
        'nodeId', e.node_id,
        'expiresAt', e.expires_at,
        'daysRemaining', e.expires_at::date - current_date,
        'severity', helm.expiration_severity(e.expires_at, e.criticality),
        'autoRenew', e.auto_renew
      ) AS x
      FROM expiration e
      JOIN organization o ON o.id = e.organization_id
      WHERE e.tenant_id = v_link.tenant_id
        AND o.deleted_at IS NULL AND o.archived_at IS NULL
        AND (e.acknowledged_until IS NULL OR e.acknowledged_until < now())
        AND helm.expiration_severity(e.expires_at, e.criticality) IN ('expired', 'critical', 'warning')
      ORDER BY e.expires_at
      LIMIT 12
    ) s;
  END IF;

  -- Integration health. The connection's own name only with details on: for a
  -- per-client connection (Microsoft 365, Proxmox) it is usually the client.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'provider', c.provider,
    'name', CASE WHEN v_link.show_details THEN c.display_name ELSE NULL END,
    'status', c.status,
    'syncEnabled', c.sync_enabled,
    'intervalMinutes', c.sync_interval_minutes,
    'lastSyncAt', c.last_sync_at,
    'lastSuccessAt', c.last_success_at,
    'failures', c.consecutive_failures
  ) ORDER BY c.provider, c.display_name), '[]'::jsonb) INTO v_integrations
  FROM integration_connection c
  WHERE c.tenant_id = v_link.tenant_id AND c.disabled_at IS NULL;

  RETURN jsonb_build_object(
    'tenant', v_tenant.name,
    'linkName', v_link.name,
    'showDetails', v_link.show_details,
    'allowedOrigins', to_jsonb(v_link.allowed_origins),
    'counts', v_counts,
    'expirations', v_items,
    'integrations', v_integrations,
    'generatedAt', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION helm.homarr_origins_ok(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.require_homarr_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.homarr_board_links() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.create_homarr_board_link(text, text, bytea, text[], boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.revoke_homarr_board_link(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.homarr_board_view(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.homarr_origins_ok(text[]) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.require_homarr_admin() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.homarr_board_links() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.create_homarr_board_link(text, text, bytea, text[], boolean) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.revoke_homarr_board_link(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.homarr_board_view(text, bytea) TO helm_app;
