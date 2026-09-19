-- =============================================================================
-- 0460 — is_internal_only reaches every secret, not just the credential ones
--
-- THE GAP. helm.secret_node_visible() resolved a secret's visibility by joining
-- `credential` and nothing else. A secret reached any other way produced zero
-- rows, bool_or over zero rows is NULL, and the coalesce turned that into
-- "visible" — so a client-side actor could read the label, kind, sensitivity
-- and rotation state of a secret explicitly marked internal-only, as long as it
-- hung off something other than a credential.
--
-- FOUR PATHS, NOT TWO. The report named flexible assets. The catalogue names
-- two more: every foreign key into `secret` from a table that is an asset_node
-- subtype has the same hole.
--
--   credential.secret_id / .totp_secret_id        was covered
--   flexible_asset_secret -> flexible_asset_record  was NOT
--   ssl_certificate.private_key_secret_id           was NOT
--   license.license_key_secret_id                   was NOT
--
-- A TLS private key on an internal-only certificate and a license key on an
-- internal-only license were exposed by exactly the same mechanism as the
-- flexible-asset case, and would have stayed exposed if this had been fixed
-- only where it was reported.
--
-- unifi_site_mapping.api_key_secret_id is the one reference with no node behind
-- it — it is integration configuration, not documentation — so it has no
-- is_internal_only to consult and falls to the default below.
-- =============================================================================
SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- THE DEFAULT FLIPS TO NOT-VISIBLE, and 0390 argued the opposite, so here is
-- why that argument no longer holds.
--
-- 0390 said: a secret with no credential row is "material without a documented
-- account, was never part of the credential model, and stays governed by the
-- controls that always governed it — organisation scope, secret:reveal,
-- min_role_rank and step-up."
--
-- That was sound while `credential` was the only path. It is not any more, and
-- it was not true even when it was written: flexible_asset_secret already
-- existed. The premise "no credential row therefore not part of the asset
-- model" was false, so the default was doing two jobs at once — standing for
-- "genuinely unattached" AND for "attached by a path this function does not
-- know about". The second meaning is the vulnerability.
--
-- Covering all four paths shrinks the zero-row set to integration
-- configuration and genuinely orphaned secrets. For those, fail-closed is the
-- right answer on its own merits — but the decisive reason is the failure mode
-- this has now demonstrated twice. A reference path gets added (flexible
-- assets, then UniFi) and this function does not learn about it. With a
-- permissive default that is a silent leak nobody sees. With a fail-closed
-- default it is a visible "why can't the client see this", which is the
-- direction an error of this kind should fail in.
--
-- And a default is a poor place to rely on being remembered, so the guard at
-- the bottom of this file reads the catalogue: a NEW foreign key into `secret`
-- from a table this function does not name fails the migration.
--
-- WHAT THIS CHANGES IN PRACTICE. Only for client-side roles — every caller
-- short-circuits on helm.is_tenant_wide() first, so no MSP-side actor is
-- affected. A co-managed client stops seeing that an unattached secret exists
-- in their organisation. Secrets created through /api/secrets always have a
-- credential row, so this is legacy and integration material rather than
-- anything the product creates today.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.secret_node_visible(p_secret_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  -- bool_or over every node that references this secret: if ANY of them is not
  -- internal, the secret is visible. That is 0390's rule for credentials and it
  -- is preserved exactly — a secret documented on both an internal and an
  -- ordinary asset stays visible, because the ordinary one is a legitimate
  -- reason for the client to know it exists.
  --
  -- coalesce(..., false): no referencing node at all is now NOT visible. See
  -- the header.
  SELECT coalesce(bool_or(NOT n.is_internal_only), false)
  FROM (
    -- A documented account, and its TOTP seed.
    SELECT c.id AS node_id FROM credential c
     WHERE c.secret_id = p_secret_id OR c.totp_secret_id = p_secret_id
    UNION
    -- A secret field on a flexible asset record. The record IS the node.
    SELECT r.id FROM flexible_asset_secret f
      JOIN flexible_asset_record r ON r.id = f.record_id
     WHERE f.secret_id = p_secret_id
    UNION
    -- A certificate's private key.
    SELECT x.id FROM ssl_certificate x
     WHERE x.private_key_secret_id = p_secret_id
    UNION
    -- A licence key.
    SELECT l.id FROM license l
     WHERE l.license_key_secret_id = p_secret_id
  ) refs
  JOIN asset_node n ON n.id = refs.node_id;
$$;

-- Unchanged from 0390, restated because a CREATE OR REPLACE keeps the old
-- grants and a reader should not have to know that to see who may call this.
REVOKE ALL ON FUNCTION helm.secret_node_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.secret_node_visible(uuid) TO helm_app, helm_worker;

COMMENT ON FUNCTION helm.secret_node_visible(uuid) IS
  'Whether a client-side role may know this secret exists. Resolves every '
  'asset_node path that references a secret; a secret with no referencing node '
  'is not visible. MSP-side callers short-circuit before reaching this.';

-- =============================================================================
-- Guards
-- =============================================================================
DO $secret_visibility_guard$
DECLARE
  v_unknown text;
BEGIN
  /*
   * 1. EVERY REFERENCE PATH IS ACCOUNTED FOR.
   *
   * This is the guard that matters, because the bug it prevents has already
   * happened twice: a table grows a foreign key into `secret` and nobody
   * teaches this function about it. Read from the catalogue rather than from a
   * list somebody maintains by hand.
   *
   * A referencing table is accounted for if the function names it. The two
   * exceptions are named explicitly and for stated reasons:
   *
   *   secret_version        the secret's own versions, not a reference TO it
   *   unifi_site_mapping    integration configuration with no asset_node behind
   *                         it, so there is no is_internal_only to consult
   */
  SELECT string_agg(DISTINCT t.relname, ', ') INTO v_unknown
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE c.contype = 'f'
    AND c.confrelid = 'secret'::regclass
    AND t.relname NOT IN ('secret_version', 'unifi_site_mapping')
    AND position(t.relname IN (
      SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'secret_node_visible')) = 0;

  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION
      'helm: % references secret but helm.secret_node_visible() does not know about it, '
      'so an internal-only flag on that path would not be enforced', v_unknown;
  END IF;

  -- 2. THE DEFAULT IS FAIL-CLOSED. Stated as an assertion because the whole
  --    exposure came from a coalesce reading the other way, and a future
  --    "simplification" back to true would reopen it silently.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'secret_node_visible')
     ~ 'coalesce\s*\(\s*bool_or[^)]*\)\s*,\s*true' THEN
    RAISE EXCEPTION 'helm: secret_node_visible defaults to visible again';
  END IF;

  -- 3. STILL SECURITY DEFINER. It reads asset_node to find out whether a node
  --    is internal, and under the CALLER's RLS an internal node is invisible —
  --    the join would drop the row and report "visible" for precisely the
  --    secret this exists to hide.
  IF NOT (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'helm' AND p.proname = 'secret_node_visible') THEN
    RAISE EXCEPTION 'helm: secret_node_visible is no longer SECURITY DEFINER';
  END IF;
END;
$secret_visibility_guard$;
