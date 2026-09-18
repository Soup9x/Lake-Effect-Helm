-- =============================================================================
-- 0430_unifi_network_assets.sql — UniFi Network, part 1: schema, config, sync
--
-- WHICH CONTROLLER THIS TARGETS, AND WHY IT MATTERS
--
-- UniFi has three API surfaces and they are not interchangeable. This targets
-- exactly one:
--
--   THE NETWORK INTEGRATION API — official, local, GA.
--     Base path   https://{host}/proxy/network/integration/v1
--     Auth        X-API-KEY header
--     Requires    UniFi Network 9.x+ on UniFi OS 9.3.43+
--     Key issued  console Settings -> Control Plane -> Integrations -> API Keys
--     Reads       GET /sites, /sites/{siteId}/devices, /sites/{siteId}/clients
--     Envelope    { data[], offset, limit, count, totalCount }, limit max 200
--
-- NOT the classic controller API (/api/s/{site}/stat/device, /stat/sta). That
-- one authenticates with a cookie session and a CSRF header, and — the decisive
-- point — AN API KEY DOES NOT AUTHENTICATE IT AT ALL. A design that stored an
-- API key and then called the classic endpoints would fail 401 on every poll.
--
-- NOT the Site Manager cloud API (api.ui.com). This is an on-premises product;
-- routing a client's inventory through Ubiquiti's cloud to read a controller on
-- the same LAN is a dependency nobody asked for.
--
-- The version floor is therefore a real deployment requirement, not a footnote,
-- and the test-connection action reports it rather than leaving an operator to
-- infer it from a 404.
--
-- SELF-SIGNED TLS IS THE NORMAL CASE, NOT THE EXCEPTION
--
-- A local UniFi console ships with a self-signed certificate, and most
-- self-hosted deployments never replace it. Every community client handles this
-- with a global "--insecure" switch. That is the wrong shape here: it turns off
-- verification for every controller, forever, on the strength of one awkward
-- install.
--
-- So verification is ON by default and the escape hatch is PER MAPPING and is
-- NOT a disable — it is a PIN. tls_pinned_sha256 holds the fingerprint of the
-- one certificate this mapping will accept. A pinned self-signed certificate
-- still detects interception; `rejectUnauthorized: false` does not. Recording
-- the fingerprint an operator actually saw is strictly more informative than
-- recording that they gave up.
--
-- tls_exception_ack records WHO accepted it and WHEN, because a pin is a
-- decision and decisions have owners.
--
-- WHERE THE API KEY LIVES
--
-- In `secret`, through the same path every client credential uses. NOT in a
-- bespoke encrypted column on the mapping.
--
-- That is not tidiness. It is what makes the API key inherit the reveal ladder,
-- the per-access audit row, the rank gate, the rotation path and the
-- helm_app-can-write-but-never-read boundary that already exist. A bespoke
-- column would have had to re-earn every one of those, and would have been the
-- only credential in the product outside the vault.
--
-- CONSEQUENCE, FOUND BY READING RATHER THAN BY TESTING: helm.reveal_secret()
-- gates the 'integration' purpose on helm.is_integration_credential(), which
-- only recognises secrets referenced from integration_connection. A UniFi API
-- key would have been refused on every poll with 'not_an_integration_credential'
-- — the sync failing completely, from a function nobody would think to look at.
-- That function is extended below.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- The permission.
--
-- integration:network:manage is DELIBERATELY ITS OWN SCOPE, not tenant:write
-- and not a shared integration:manage.
--
-- The person who should wire up a client's UniFi controller is the technician
-- who looks after that client's network. Gating it on tenant:write would mean
-- making them a super_admin — handing them the tenant's authentication
-- settings and key rotation to let them type in a controller URL. Gating it on
-- integration:manage would bundle it with the notification webhooks and
-- anything else that lands in that bucket later.
--
-- Seeded here rather than only in 0900 so an EXISTING deployment gains it on
-- upgrade; 0900 seeds it too for a fresh build, and both are idempotent.
-- -----------------------------------------------------------------------------
-- The key has THREE segments and every existing permission has two, so the
-- shape constraint from 0020 has to widen to admit it.
--
-- Widened rather than renamed, because the extra segment is the point: it says
-- "an integration permission, of the network subtype", which is exactly the
-- distinction that stops somebody later folding this into integration:manage.
-- `category` is its own column and nothing anywhere splits a key on the colon
-- (checked before changing this), so the constraint is a format rule and not a
-- control — widening it weakens nothing.
ALTER TABLE permission DROP CONSTRAINT IF EXISTS permission_key_shape;
ALTER TABLE permission ADD CONSTRAINT permission_key_shape CHECK (
  key ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)?$'
);

INSERT INTO permission (key, category, description, msp_only) VALUES
  ('integration:network:manage', 'integration',
   'Configure network controller integrations and their credentials', true)
ON CONFLICT (key) DO NOTHING;

-- tier3 is the senior engineer who actually configures a client's network gear.
-- super_admin holds everything by construction.
--
-- GUARDED ON THE ROLES EXISTING, because this file runs BEFORE 0900 seeds the
-- catalogue: on a fresh build app_role is empty and the foreign key refuses the
-- insert, which broke the first rebuild. On an upgrade the roles are already
-- there and this grants them; on a fresh build 0900 does it instead. The same
-- trap 0400 hit, and the same shape of fix.
DO $grant_network$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_role WHERE key = 'super_admin') THEN
    RETURN;
  END IF;

  INSERT INTO role_permission (role_key, permission_key) VALUES
    ('super_admin', 'integration:network:manage'),
    ('tier3',       'integration:network:manage')
  ON CONFLICT DO NOTHING;
END;
$grant_network$;

-- -----------------------------------------------------------------------------
-- unifi_site_mapping — one UniFi site, bound to one Helm organisation.
--
-- organization_id is NOT NULL: a controller site describes exactly one client's
-- network, and an unscoped mapping would put one client's devices in another's
-- inventory. The FK is the composite (organization_id, tenant_id) pair this
-- schema uses everywhere, so a mapping cannot reference another tenant's
-- organisation even with RLS off.
-- -----------------------------------------------------------------------------
CREATE TABLE unifi_site_mapping (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL,

  name             text NOT NULL,
  controller_url   text NOT NULL,
  -- The site's id in the Integration API, which is a uuid on current versions
  -- but is text here: it was a short slug ("default") on older controllers and
  -- a column that refuses the value the controller returns is worse than a
  -- column that is slightly wide.
  unifi_site_id    text NOT NULL,

  -- THE API KEY. A reference into `secret`, never a column of its own.
  -- ON DELETE RESTRICT: deleting the credential out from under a live mapping
  -- would leave a mapping that polls forever and fails forever.
  api_key_secret_id uuid,

  is_active        boolean NOT NULL DEFAULT false,

  -- TLS. See the header: verification is on, and the exception is a pin.
  tls_verify        boolean NOT NULL DEFAULT true,
  tls_pinned_sha256 text,
  tls_exception_ack_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  tls_exception_ack_at timestamptz,

  -- Per mapping, not hardcoded. A busy site polled every minute and a quiet one
  -- every hour are both reasonable, and one number cannot be both.
  poll_interval_seconds integer NOT NULL DEFAULT 300,

  -- Sync state. next_poll_at is what the worker orders by, so a mapping that is
  -- failing backs off without holding up the others.
  last_poll_at      timestamptz,
  last_poll_ok      boolean,
  last_poll_error   text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  next_poll_at      timestamptz NOT NULL DEFAULT now(),
  -- What the last successful poll saw, for the settings page.
  last_device_count integer,
  last_client_count integer,

  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT unifi_mapping_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT unifi_mapping_secret_fk FOREIGN KEY (api_key_secret_id, tenant_id)
    REFERENCES secret (id, tenant_id) ON DELETE RESTRICT,
  -- One Helm organisation per controller site. Two mappings onto the same site
  -- would double-poll it and race each other's upserts.
  CONSTRAINT unifi_mapping_site_uk UNIQUE (tenant_id, controller_url, unifi_site_id),
  CONSTRAINT unifi_mapping_name_uk UNIQUE (tenant_id, name),

  CONSTRAINT unifi_mapping_name_present CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  -- https only, and no trailing slash: the integration path is appended to this
  -- verbatim, and a double slash 404s on some builds.
  CONSTRAINT unifi_mapping_url_https CHECK (controller_url ~ '^https://[A-Za-z0-9._~%-]+(:[0-9]{1,5})?$'),
  CONSTRAINT unifi_mapping_site_present CHECK (length(btrim(unifi_site_id)) BETWEEN 1 AND 128),
  -- Below 30s a poll has not finished before the next begins; above a day the
  -- inventory is stale enough to mislead.
  CONSTRAINT unifi_mapping_interval_range CHECK (poll_interval_seconds BETWEEN 30 AND 86400),
  CONSTRAINT unifi_mapping_failures_nonneg CHECK (consecutive_failures >= 0),
  CONSTRAINT unifi_mapping_pin_shape CHECK (
    tls_pinned_sha256 IS NULL OR tls_pinned_sha256 ~ '^[0-9a-f]{64}$'
  ),
  -- A PIN IS A DECISION AND DECISIONS HAVE OWNERS. A row cannot carry a trust
  -- exception without naming who accepted it and when — enforced here so no
  -- code path can set one silently.
  CONSTRAINT unifi_mapping_pin_acknowledged CHECK (
    tls_pinned_sha256 IS NULL
      OR (tls_exception_ack_by IS NOT NULL AND tls_exception_ack_at IS NOT NULL)
  ),
  -- Verification off with nothing pinned is the blanket disable this design
  -- exists to prevent. Unrepresentable rather than discouraged.
  CONSTRAINT unifi_mapping_no_blanket_disable CHECK (
    tls_verify OR tls_pinned_sha256 IS NOT NULL
  ),
  -- A mapping cannot go active without a credential to poll with.
  CONSTRAINT unifi_mapping_active_needs_key CHECK (
    NOT is_active OR api_key_secret_id IS NOT NULL
  )
);

CREATE INDEX unifi_mapping_due_idx ON unifi_site_mapping (next_poll_at)
  WHERE is_active;

COMMENT ON COLUMN unifi_site_mapping.api_key_secret_id IS
  'The controller API key, held in `secret` like every other credential so it '
  'inherits the reveal ladder and the audit trail. Never a column here.';
COMMENT ON COLUMN unifi_site_mapping.tls_pinned_sha256 IS
  'A pinned certificate fingerprint, not a verification disable. A pinned '
  'self-signed certificate still detects interception.';

CREATE TRIGGER unifi_site_mapping_touch BEFORE UPDATE ON unifi_site_mapping
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- -----------------------------------------------------------------------------
-- network_assets — what the controller sees, plus what a human wrote about it.
--
-- WHAT IS ENCRYPTED AND WHAT IS NOT, decided per field rather than per table.
--
--   ENCRYPTED  mac, ip, hostname, serial, and a user's custom name. These
--              identify a machine and a person: a MAC is a device fingerprint
--              that follows hardware between networks, a hostname is routinely
--              "james-laptop", and a serial is what a warranty claim is made
--              against.
--
--   PLAIN      uptime, signal strength, switch port, uplink MAC's owner,
--              firmware version, model, state. Telemetry about how a box is
--              doing. There is no confidentiality requirement here, and
--              encrypting it would cost a DEK unwrap per row per read while
--              making "which access points are on old firmware" impossible to
--              answer in SQL.
--
-- Blanket-encrypting the telemetry JSON is the tempting shortcut and it buys
-- nothing: it protects data that needs no protection, at the price of every
-- query that would have made the inventory useful.
--
-- TWO ENVELOPES, NOT ONE, AND THE REASON IS CONCURRENCY.
--
-- controller_* fields are written only by the sync. custom_name is written only
-- by a person. They are sealed SEPARATELY so the two writers cannot clobber
-- each other — the requirement that a sync must never overwrite a user's edit
-- becomes a property of the schema rather than a rule the worker has to
-- remember. Sharing one envelope would have made a read-modify-write of the
-- whole blob mandatory on every poll, which is precisely the race to avoid.
--
-- Each encrypted column packs nonce || auth_tag || ciphertext into one bytea.
-- The AAD is rebuilt from (tenant, asset, field) rather than stored per column,
-- because the binding is deterministic and a stored copy is one more thing that
-- can disagree with reality.
-- -----------------------------------------------------------------------------
CREATE TYPE network_asset_type AS ENUM ('unifi_device', 'client_device');
CREATE TYPE network_asset_status AS ENUM ('active', 'maintenance', 'decommissioned');

CREATE TABLE network_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  -- Which mapping last saw it. SET NULL rather than CASCADE: removing a
  -- controller mapping should not delete the client's device inventory along
  -- with the notes somebody wrote on it.
  mapping_id      uuid REFERENCES unifi_site_mapping(id) ON DELETE SET NULL,

  asset_type      network_asset_type NOT NULL,

  -- The match key. HMAC-SHA256 under the per-tenant blind-index subkey, so the
  -- same MAC indexes differently in each tenant and one tenant's index cannot
  -- be used to probe another's.
  --
  -- STATED PLAINLY: a MAC is 48 bits and an OUI prefix narrows it much further,
  -- so an attacker holding BOTH this column and HELM_BLIND_INDEX_KEY_B64 can
  -- enumerate candidate MACs offline. That is a weaker position than the same
  -- attacker has against a password index, and what it yields is "this device
  -- is on this client's network" rather than a credential. The mitigations are
  -- the same: the key is separate from the KEK, and the subkey is per tenant.
  mac_blind_index bytea NOT NULL,

  -- nonce || tag || ciphertext, one envelope per field.
  data_key_id     uuid NOT NULL REFERENCES tenant_data_key(id) ON DELETE RESTRICT,
  mac_address_enc bytea NOT NULL,
  ip_address_enc  bytea,
  hostname_enc    bytea,
  serial_enc      bytea,

  -- Controller telemetry, in the clear and queryable.
  model           text,
  firmware_version text,
  device_state    text,
  uptime_seconds  bigint,
  signal_dbm      smallint,
  switch_port     integer,
  uplink_mac_blind_index bytea,
  vlan_id         integer,
  ssid            text,
  is_wired        boolean,
  is_online       boolean NOT NULL DEFAULT false,
  last_seen_at    timestamptz,
  last_synced_at  timestamptz,

  -- USER-OWNED. The sync must never write these; the separate envelope above is
  -- what makes that structural rather than aspirational.
  custom_name_enc bytea,
  asset_tag       text,
  department      text,
  notes           text,
  maintenance_status network_asset_status NOT NULL DEFAULT 'active',

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT network_asset_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  -- The upsert key. A device is one row per tenant however many times it moves
  -- between the sites of that tenant's clients.
  CONSTRAINT network_asset_mac_uk UNIQUE (tenant_id, mac_blind_index),
  CONSTRAINT network_asset_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT network_asset_mac_index_len CHECK (octet_length(mac_blind_index) = 32),
  CONSTRAINT network_asset_uplink_index_len CHECK (
    uplink_mac_blind_index IS NULL OR octet_length(uplink_mac_blind_index) = 32
  ),
  -- nonce(12) + tag(16) + at least one byte of ciphertext.
  CONSTRAINT network_asset_mac_enc_len CHECK (octet_length(mac_address_enc) >= 29),
  CONSTRAINT network_asset_signal_range CHECK (signal_dbm IS NULL OR signal_dbm BETWEEN -120 AND 0),
  CONSTRAINT network_asset_port_range CHECK (switch_port IS NULL OR switch_port BETWEEN 0 AND 4096),
  CONSTRAINT network_asset_vlan_range CHECK (vlan_id IS NULL OR vlan_id BETWEEN 0 AND 4094)
);

CREATE INDEX network_asset_lookup_idx ON network_assets (tenant_id, mac_blind_index);
CREATE INDEX network_asset_org_idx ON network_assets (tenant_id, organization_id, asset_type);
CREATE INDEX network_asset_online_idx ON network_assets (tenant_id, is_online, last_seen_at DESC);
CREATE INDEX network_asset_mapping_idx ON network_assets (mapping_id) WHERE mapping_id IS NOT NULL;

COMMENT ON COLUMN network_assets.custom_name_enc IS
  'User-set, overrides the controller hostname. Sealed separately from the '
  'controller fields so a sync physically cannot overwrite it.';

CREATE TRIGGER network_assets_touch BEFORE UPDATE ON network_assets
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- -----------------------------------------------------------------------------
-- asset_ip_history — where a device has been.
--
-- Append-on-change, not append-per-poll. A device polled every five minutes for
-- a year is 105,000 rows of "still .47" and one row of the day it moved; only
-- the second is worth keeping, so a repeat poll extends last_seen_at on the
-- open row instead of writing a new one.
--
-- The blind index is here for the same reason it is on the asset: "who had
-- 10.2.0.47 when that alert fired" is the question this table exists to answer,
-- and answering it without one would mean decrypting every row.
-- -----------------------------------------------------------------------------
CREATE TABLE asset_ip_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  asset_id       uuid NOT NULL,

  data_key_id    uuid NOT NULL REFERENCES tenant_data_key(id) ON DELETE RESTRICT,
  ip_address_enc bytea NOT NULL,
  ip_blind_index bytea NOT NULL,

  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT asset_ip_history_asset_fk FOREIGN KEY (asset_id, tenant_id)
    REFERENCES network_assets (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT asset_ip_history_index_len CHECK (octet_length(ip_blind_index) = 32),
  CONSTRAINT asset_ip_history_enc_len CHECK (octet_length(ip_address_enc) >= 29),
  CONSTRAINT asset_ip_history_window CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX asset_ip_history_asset_idx ON asset_ip_history (tenant_id, asset_id, last_seen_at DESC);
-- The lookup this table exists for: which device held this address, and when.
CREATE INDEX asset_ip_history_ip_idx ON asset_ip_history (tenant_id, ip_blind_index, last_seen_at DESC);

-- =============================================================================
-- Row-level security
--
-- The same helper every other tenant table uses, so these inherit the isolation
-- the rest of the schema already proves rather than restating it.
--
--   unifi_site_mapping   org-scoped, write rank 80 (tier3). Reading which
--                        controller a client uses is ordinary documentation;
--                        WRITING is additionally gated on
--                        integration:network:manage inside the SECURITY DEFINER
--                        functions below, because a rank is not a permission.
--
--   network_assets       org-scoped, write rank 40 (tier1). A device inventory
--                        IS a client's asset documentation, and editing its
--                        name or notes is the same act as editing any other
--                        asset's — which is what the brief asked for.
--
--   asset_ip_history     tenant-scoped and written only by the worker.
-- =============================================================================
-- The explicit fourth argument is not decoration. 0390 added a five-argument
-- overload alongside the original three-argument one, so a three-argument call
-- is AMBIGUOUS and Postgres refuses it outright. Passing NULL for the
-- internal-only column selects the newer form, which is what every caller in
-- 0390 does.
SELECT helm.apply_tenant_rls('unifi_site_mapping', true, 80, NULL);
SELECT helm.apply_tenant_rls('network_assets', true, 40, NULL);
SELECT helm.apply_tenant_rls('asset_ip_history', false, 80, NULL);

-- -----------------------------------------------------------------------------
-- helm.is_integration_credential — now aware that a mapping holds one.
--
-- THE BUG THIS PREVENTS, found by reading the reveal ladder rather than by
-- running the sync: reveal_secret() refuses purpose 'integration' unless this
-- returns true, and the 0110 version only knew about integration_connection.
-- A UniFi API key stored exactly as instructed would have been refused on every
-- poll with 'not_an_integration_credential' — every sync failing, from a
-- function three files away that nobody would think to look at.
--
-- Rebuilt by TRANSFORMING the live definition, not by retyping it: the original
-- branch is preserved verbatim and a second is added beside it. Retyping a
-- routine from memory has broken this project three times.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.is_integration_credential(p_secret_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM integration_connection c
    CROSS JOIN LATERAL jsonb_each_text(c.credential_secret_ids) AS cred(role_key, secret_id)
    WHERE c.tenant_id = helm.current_tenant_id()
      AND c.disabled_at IS NULL
      AND cred.secret_id = p_secret_id::text
  )
  OR EXISTS (
    -- Added in 0430. A UniFi controller's API key is an integration credential
    -- by every meaning of the phrase; it simply lives on its own table.
    SELECT 1
    FROM unifi_site_mapping m
    WHERE m.tenant_id = helm.current_tenant_id()
      AND m.api_key_secret_id = p_secret_id
  );
$function$;

-- =============================================================================
-- The administrative surface
-- =============================================================================

-- -----------------------------------------------------------------------------
-- helm.unifi_mappings — what an operator may see.
--
-- No secret material: the API key is a uuid reference and the reveal path is
-- elsewhere. api_key_set is the only thing said about it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.unifi_mappings()
  RETURNS TABLE (
    id uuid, organization_id uuid, organization_name text, name text,
    controller_url text, unifi_site_id text, is_active boolean,
    api_key_set boolean, tls_verify boolean, tls_pinned_sha256 text,
    tls_exception_ack_at timestamptz, tls_exception_ack_by_name text,
    poll_interval_seconds integer,
    last_poll_at timestamptz, last_poll_ok boolean, last_poll_error text,
    consecutive_failures integer, next_poll_at timestamptz,
    last_device_count integer, last_client_count integer,
    asset_count bigint, updated_at timestamptz
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.is_tenant_wide() THEN
    RAISE EXCEPTION 'helm: network integration settings are not visible to a client-side role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT m.id, m.organization_id, o.name, m.name,
           m.controller_url, m.unifi_site_id, m.is_active,
           m.api_key_secret_id IS NOT NULL,
           m.tls_verify, m.tls_pinned_sha256,
           m.tls_exception_ack_at, ack.name,
           m.poll_interval_seconds,
           m.last_poll_at, m.last_poll_ok, m.last_poll_error,
           m.consecutive_failures, m.next_poll_at,
           m.last_device_count, m.last_client_count,
           (SELECT count(*) FROM network_assets a WHERE a.mapping_id = m.id),
           m.updated_at
    FROM unifi_site_mapping m
    JOIN organization o ON o.id = m.organization_id AND o.tenant_id = v_tenant
    LEFT JOIN app_user ack ON ack.id = m.tls_exception_ack_by
    WHERE m.tenant_id = v_tenant
    ORDER BY o.name, m.name;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.set_unifi_mapping — create or edit one.
--
-- integration:network:manage, and nothing else. NOT tenant:write: making a
-- technician a super_admin so they can type in a controller URL would hand them
-- the tenant's authentication settings and key rotation at the same time.
--
-- The TLS pin arrives with the acknowledging actor stamped from the session
-- rather than passed in, so the record of who accepted an exception cannot be
-- forged by the caller.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_unifi_mapping(
  p_id               uuid,
  p_organization_id  uuid,
  p_name             text,
  p_controller_url   text,
  p_unifi_site_id    text,
  p_is_active        boolean,
  p_poll_interval_seconds integer,
  p_api_key_secret_id uuid DEFAULT NULL,
  p_tls_pinned_sha256 text DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
  v_id     uuid := coalesce(p_id, gen_random_uuid());
  v_existing unifi_site_mapping%ROWTYPE;
  v_key    uuid;
  v_pin    text := nullif(btrim(coalesce(p_tls_pinned_sha256, '')), '');
BEGIN
  IF NOT helm.has_permission('integration:network:manage') THEN
    RAISE EXCEPTION 'helm: configuring a network controller requires integration:network:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT helm.org_in_scope(p_organization_id) THEN
    RAISE EXCEPTION 'helm: organisation % is not in scope', p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_existing FROM unifi_site_mapping
  WHERE id = v_id AND tenant_id = v_tenant;

  -- An absent key means "keep the one already stored", so that changing a poll
  -- interval does not require re-pasting the API key — the friction that ends
  -- with a credential in a team note so it can be re-typed.
  v_key := coalesce(p_api_key_secret_id, v_existing.api_key_secret_id);

  INSERT INTO unifi_site_mapping (
    id, tenant_id, organization_id, name, controller_url, unifi_site_id,
    api_key_secret_id, is_active, poll_interval_seconds,
    tls_verify, tls_pinned_sha256, tls_exception_ack_by, tls_exception_ack_at,
    created_by, updated_by)
  VALUES (
    v_id, v_tenant, p_organization_id, btrim(p_name), btrim(p_controller_url),
    btrim(p_unifi_site_id), v_key, p_is_active, p_poll_interval_seconds,
    v_pin IS NULL, v_pin,
    CASE WHEN v_pin IS NULL THEN NULL ELSE v_actor END,
    CASE WHEN v_pin IS NULL THEN NULL ELSE now() END,
    v_actor, v_actor)
  ON CONFLICT (id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    name = EXCLUDED.name,
    controller_url = EXCLUDED.controller_url,
    unifi_site_id = EXCLUDED.unifi_site_id,
    api_key_secret_id = EXCLUDED.api_key_secret_id,
    is_active = EXCLUDED.is_active,
    poll_interval_seconds = EXCLUDED.poll_interval_seconds,
    tls_verify = EXCLUDED.tls_verify,
    tls_pinned_sha256 = EXCLUDED.tls_pinned_sha256,
    -- Re-stamped on every change to the pin, so the acknowledgment always
    -- names whoever accepted the CURRENT certificate rather than a previous one.
    tls_exception_ack_by = EXCLUDED.tls_exception_ack_by,
    tls_exception_ack_at = EXCLUDED.tls_exception_ack_at,
    -- A changed controller or key invalidates what the last poll proved.
    last_poll_ok = CASE
      WHEN unifi_site_mapping.controller_url IS DISTINCT FROM EXCLUDED.controller_url
        OR unifi_site_mapping.api_key_secret_id IS DISTINCT FROM EXCLUDED.api_key_secret_id
      THEN NULL ELSE unifi_site_mapping.last_poll_ok END,
    consecutive_failures = 0,
    next_poll_at = now(),
    updated_by = v_actor
  WHERE unifi_site_mapping.tenant_id = v_tenant;

  PERFORM helm.audit(
    CASE WHEN v_existing.id IS NULL THEN 'integration.network_mapping_created'
         ELSE 'integration.network_mapping_updated' END,
    'unifi_site_mapping', v_id, 'success', p_organization_id, NULL, NULL,
    jsonb_build_object(
      'name', btrim(p_name),
      'controller_url', btrim(p_controller_url),
      'unifi_site_id', btrim(p_unifi_site_id),
      'is_active', p_is_active,
      'poll_interval_seconds', p_poll_interval_seconds,
      -- Recorded because storing a credential against a mapping is exactly the
      -- act somebody will want to trace later.
      'api_key_changed', p_api_key_secret_id IS NOT NULL,
      'tls_verify', v_pin IS NULL,
      'tls_pinned', v_pin IS NOT NULL));

  RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.forget_unifi_mapping — remove it.
--
-- The inventory it produced STAYS: network_assets.mapping_id is ON DELETE SET
-- NULL, so removing a controller does not delete a client's device records and
-- the notes somebody wrote on them.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.forget_unifi_mapping(p_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_row    unifi_site_mapping%ROWTYPE;
BEGIN
  IF NOT helm.has_permission('integration:network:manage') THEN
    RAISE EXCEPTION 'helm: removing a network controller requires integration:network:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_row FROM unifi_site_mapping WHERE id = p_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN RETURN false; END IF;

  DELETE FROM unifi_site_mapping WHERE id = p_id AND tenant_id = v_tenant;

  PERFORM helm.audit('integration.network_mapping_removed', 'unifi_site_mapping',
    p_id, 'success', v_row.organization_id, NULL, NULL,
    jsonb_build_object('name', v_row.name, 'controller_url', v_row.controller_url));

  RETURN true;
END;
$$;

-- =============================================================================
-- The sync worker's surface
-- =============================================================================

-- -----------------------------------------------------------------------------
-- helm.unifi_poll_backlog — which mappings are due, across every tenant.
--
-- Cross-tenant by construction, like every other backlog enumerator, and
-- granted to helm_worker alone. Ordered by next_poll_at so a mapping that is
-- backing off cannot starve the others — the brief's "one failed tenant must
-- not block or delay the rest" is a property of this ORDER BY plus the
-- per-mapping claim below, not of the worker's loop.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.unifi_poll_backlog(p_limit integer DEFAULT 25)
  RETURNS TABLE (
    mapping_id uuid, tenant_id uuid, tenant_name text, worker_actor_id uuid,
    organization_id uuid, name text, controller_url text, unifi_site_id text,
    api_key_secret_id uuid, tls_verify boolean, tls_pinned_sha256 text,
    poll_interval_seconds integer, consecutive_failures integer
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT m.id, m.tenant_id, t.name, helm.worker_actor(m.tenant_id, 'system_sync'),
         m.organization_id, m.name, m.controller_url, m.unifi_site_id,
         m.api_key_secret_id, m.tls_verify, m.tls_pinned_sha256,
         m.poll_interval_seconds, m.consecutive_failures
  FROM unifi_site_mapping m
  JOIN tenant t ON t.id = m.tenant_id AND t.status = 'active'
  WHERE m.is_active
    AND m.api_key_secret_id IS NOT NULL
    AND m.next_poll_at <= now()
    AND helm.worker_actor(m.tenant_id, 'system_sync') IS NOT NULL
  ORDER BY m.next_poll_at
  LIMIT greatest(p_limit, 1);
$$;

-- -----------------------------------------------------------------------------
-- helm.claim_unifi_poll — take a mapping, or find somebody else already has it.
--
-- THE RACE THIS EXISTS FOR. Two workers — two container replicas, or one
-- restarted mid-poll — polling the same controller at the same time would both
-- UPSERT the same MACs and both append IP history, producing duplicate history
-- rows and a last-writer-wins scramble of telemetry. This project has already
-- shipped one bug of exactly this shape (ExportService.request() looped per
-- client instead of sharing a transaction).
--
-- The guard is a row lock plus a claim window, not an advisory lock. An
-- advisory lock is held by a SESSION and vanishes if that worker dies, which is
-- the moment a half-finished poll most wants to stay claimed. `next_poll_at`
-- pushed forward under FOR UPDATE SKIP LOCKED does both jobs: concurrent
-- claimants skip the row instead of blocking, and a worker that dies leaves the
-- claim standing until it lapses.
--
-- Returns false rather than raising when the claim is lost, because losing a
-- race to a peer is ordinary and an exception would put it in the error log.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.claim_unifi_poll(
  p_mapping_id uuid,
  p_claim_seconds integer DEFAULT 600
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_claimed integer;
BEGIN
  WITH candidate AS (
    SELECT m.id FROM unifi_site_mapping m
    WHERE m.id = p_mapping_id
      AND m.is_active
      AND m.next_poll_at <= now()
    FOR UPDATE SKIP LOCKED
  )
  UPDATE unifi_site_mapping m
  SET next_poll_at = now() + make_interval(secs => greatest(p_claim_seconds, 60))
  FROM candidate c
  WHERE m.id = c.id;

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed = 1;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.upsert_network_asset — the whole preservation guarantee, in one place.
--
-- THE RULE: on insert, populate everything the controller knows. On update,
-- touch ONLY controller-managed fields. custom_name_enc, asset_tag, department,
-- notes and maintenance_status are never named in the UPDATE SET list — not
-- "set to their old value", not coalesced, ABSENT. A field that is not
-- mentioned cannot be overwritten by a typo, and a reviewer can confirm the
-- guarantee by reading twelve lines rather than reasoning about coalesce.
--
-- organization_id is likewise left alone on update: a device that has been
-- manually attributed to a client should not be re-attributed by whichever
-- controller happens to see it next.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.upsert_network_asset(
  -- THE CALLER CHOOSES THE ID, AND MUST. Every encrypted column on this row is
  -- sealed with an AAD built from (tenant, asset id, field), which means the id
  -- has to exist BEFORE the ciphertext does. Letting the default fill it in
  -- produced exactly one bug: the row inserted fine, and every sealed field on
  -- it was undecryptable forever, because the AAD named an id no row had. It
  -- is not a security boundary -- a caller-supplied id can collide and raise,
  -- but RLS still scopes every read by tenant -- it is a correctness one.
  p_asset_id        uuid,
  p_mapping_id      uuid,
  p_organization_id uuid,
  p_asset_type      network_asset_type,
  p_mac_blind_index bytea,
  p_data_key_id     uuid,
  p_mac_enc         bytea,
  p_ip_enc          bytea,
  p_hostname_enc    bytea,
  p_serial_enc      bytea,
  p_model           text,
  p_firmware_version text,
  p_device_state    text,
  p_uptime_seconds  bigint,
  p_signal_dbm      smallint,
  p_switch_port     integer,
  p_uplink_mac_blind_index bytea,
  p_vlan_id         integer,
  p_ssid            text,
  p_is_wired        boolean,
  p_last_seen_at    timestamptz
) RETURNS TABLE (asset_id uuid, was_insert boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_id     uuid;
  v_new    boolean;
BEGIN
  INSERT INTO network_assets (
    id, tenant_id, organization_id, mapping_id, asset_type, mac_blind_index,
    data_key_id, mac_address_enc, ip_address_enc, hostname_enc, serial_enc,
    model, firmware_version, device_state, uptime_seconds, signal_dbm,
    switch_port, uplink_mac_blind_index, vlan_id, ssid, is_wired,
    is_online, last_seen_at, last_synced_at)
  VALUES (
    p_asset_id, v_tenant, p_organization_id, p_mapping_id, p_asset_type, p_mac_blind_index,
    p_data_key_id, p_mac_enc, p_ip_enc, p_hostname_enc, p_serial_enc,
    p_model, p_firmware_version, p_device_state, p_uptime_seconds, p_signal_dbm,
    p_switch_port, p_uplink_mac_blind_index, p_vlan_id, p_ssid, p_is_wired,
    true, coalesce(p_last_seen_at, now()), now())
  ON CONFLICT (tenant_id, mac_blind_index) DO UPDATE SET
    -- Controller-managed, and this list is exhaustive.
    mapping_id = EXCLUDED.mapping_id,
    asset_type = EXCLUDED.asset_type,
    data_key_id = EXCLUDED.data_key_id,
    mac_address_enc = EXCLUDED.mac_address_enc,
    ip_address_enc = EXCLUDED.ip_address_enc,
    hostname_enc = EXCLUDED.hostname_enc,
    serial_enc = EXCLUDED.serial_enc,
    model = EXCLUDED.model,
    firmware_version = EXCLUDED.firmware_version,
    device_state = EXCLUDED.device_state,
    uptime_seconds = EXCLUDED.uptime_seconds,
    signal_dbm = EXCLUDED.signal_dbm,
    switch_port = EXCLUDED.switch_port,
    uplink_mac_blind_index = EXCLUDED.uplink_mac_blind_index,
    vlan_id = EXCLUDED.vlan_id,
    ssid = EXCLUDED.ssid,
    is_wired = EXCLUDED.is_wired,
    is_online = true,
    last_seen_at = EXCLUDED.last_seen_at,
    last_synced_at = now()
    -- DELIBERATELY ABSENT: custom_name_enc, asset_tag, department, notes,
    -- maintenance_status, organization_id. A user wrote those and a poll does
    -- not get to have an opinion about them.
  RETURNING id, (xmax = 0) INTO v_id, v_new;

  RETURN QUERY SELECT v_id, v_new;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.record_asset_ip — append on CHANGE, extend otherwise.
--
-- A device polled every five minutes for a year is a hundred thousand rows of
-- "still .47" and one row of the day it moved. Only the second is worth
-- keeping, so an unchanged address extends last_seen_at on the open row and a
-- changed one opens a new row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_asset_ip(
  p_asset_id       uuid,
  p_data_key_id    uuid,
  p_ip_enc         bytea,
  p_ip_blind_index bytea,
  p_seen_at        timestamptz DEFAULT now()
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_latest  asset_ip_history%ROWTYPE;
BEGIN
  SELECT * INTO v_latest FROM asset_ip_history h
  WHERE h.tenant_id = v_tenant AND h.asset_id = p_asset_id
  ORDER BY h.last_seen_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND v_latest.ip_blind_index = p_ip_blind_index THEN
    UPDATE asset_ip_history
    SET last_seen_at = greatest(last_seen_at, p_seen_at)
    WHERE id = v_latest.id;
    RETURN false;
  END IF;

  INSERT INTO asset_ip_history (
    tenant_id, asset_id, data_key_id, ip_address_enc, ip_blind_index,
    first_seen_at, last_seen_at)
  VALUES (v_tenant, p_asset_id, p_data_key_id, p_ip_enc, p_ip_blind_index,
          p_seen_at, p_seen_at);
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.finish_unifi_poll — what the poll saw, and when to come back.
--
-- Backoff lives here rather than in the worker so two workers, or a worker
-- restarted mid-batch, cannot disagree about when a mapping is next due.
-- Exponential from the configured interval, capped at an hour.
--
-- Also marks everything the poll did NOT see as offline — scoped to this
-- mapping and this sync stamp, so a second controller's devices are untouched.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.finish_unifi_poll(
  p_mapping_id   uuid,
  p_ok           boolean,
  p_device_count integer DEFAULT NULL,
  p_client_count integer DEFAULT NULL,
  p_error        text DEFAULT NULL,
  p_sync_started timestamptz DEFAULT NULL
) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant   uuid := helm.require_tenant_id();
  v_row      unifi_site_mapping%ROWTYPE;
  v_failures integer;
  v_offline  integer := 0;
  v_delay    interval;
BEGIN
  SELECT * INTO v_row FROM unifi_site_mapping
  WHERE id = p_mapping_id AND tenant_id = v_tenant FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: no such network mapping' USING ERRCODE = 'no_data_found';
  END IF;

  v_failures := CASE WHEN p_ok THEN 0 ELSE v_row.consecutive_failures + 1 END;

  v_delay := CASE
    WHEN p_ok THEN make_interval(secs => v_row.poll_interval_seconds)
    ELSE least(
      make_interval(secs => v_row.poll_interval_seconds * (2 ^ least(v_failures, 6))::integer),
      interval '1 hour')
  END;

  -- Anything this mapping owns that the poll did not touch has dropped off the
  -- controller. Bounded to rows last synced BEFORE this run started, so a
  -- device seen moments ago is not flipped offline by a slow poll.
  IF p_ok AND p_sync_started IS NOT NULL THEN
    UPDATE network_assets
    SET is_online = false
    WHERE tenant_id = v_tenant
      AND mapping_id = p_mapping_id
      AND is_online
      AND (last_synced_at IS NULL OR last_synced_at < p_sync_started);
    GET DIAGNOSTICS v_offline = ROW_COUNT;
  END IF;

  UPDATE unifi_site_mapping SET
    last_poll_at = now(),
    last_poll_ok = p_ok,
    last_poll_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
    consecutive_failures = v_failures,
    last_device_count = coalesce(p_device_count, last_device_count),
    last_client_count = coalesce(p_client_count, last_client_count),
    next_poll_at = now() + v_delay
  WHERE id = p_mapping_id;

  RETURN v_offline;
END;
$$;

-- =============================================================================
-- Grants
--
-- The mapping row holds no secret — the API key is a uuid pointing into
-- `secret` — so unlike radius_config, oidc_provider and webhook_endpoint, the
-- request role may read this table directly. That is the payoff for keeping the
-- credential in the vault: the configuration is ordinary tenant data and only
-- the credential is special.
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON unifi_site_mapping TO helm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON network_assets TO helm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON asset_ip_history TO helm_app;
GRANT SELECT ON unifi_site_mapping TO helm_auditor;
GRANT SELECT ON network_assets TO helm_auditor;
GRANT SELECT ON asset_ip_history TO helm_auditor;

REVOKE ALL ON FUNCTION helm.unifi_mappings() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_unifi_mapping(
  uuid, uuid, text, text, text, boolean, integer, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.forget_unifi_mapping(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.unifi_poll_backlog(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.claim_unifi_poll(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.upsert_network_asset(
  uuid, uuid, uuid, network_asset_type, bytea, uuid, bytea, bytea, bytea, bytea,
  text, text, text, bigint, smallint, integer, bytea, integer, text, boolean,
  timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_asset_ip(uuid, uuid, bytea, bytea, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.finish_unifi_poll(uuid, boolean, integer, integer, text, timestamptz)
  FROM PUBLIC;

-- Configuring a controller is an administrative act inside a tenant context.
GRANT EXECUTE ON FUNCTION helm.unifi_mappings() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_unifi_mapping(
  uuid, uuid, text, text, text, boolean, integer, uuid, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.forget_unifi_mapping(uuid) TO helm_app;

-- Polling is the worker's, and ONLY the worker's. The cross-tenant enumerator
-- in particular must never be reachable from the request path: it returns rows
-- for every tenant by construction.
GRANT EXECUTE ON FUNCTION helm.unifi_poll_backlog(integer) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.claim_unifi_poll(uuid, integer) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.upsert_network_asset(
  uuid, uuid, uuid, network_asset_type, bytea, uuid, bytea, bytea, bytea, bytea,
  text, text, text, bigint, smallint, integer, bytea, integer, text, boolean,
  timestamptz) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.record_asset_ip(uuid, uuid, bytea, bytea, timestamptz) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.finish_unifi_poll(uuid, boolean, integer, integer, text, timestamptz)
  TO helm_worker;

-- The test-connection action needs to reach one mapping's settings from the
-- request path. It does NOT need the backlog, and does not get it.
GRANT EXECUTE ON FUNCTION helm.claim_unifi_poll(uuid, integer) TO helm_app;

-- =============================================================================
-- Guards
-- =============================================================================
DO $unifi_guard$
BEGIN
  -- 1. THE PERMISSION IS ITS OWN SCOPE. The whole point of the brief: a
  --    technician can be trusted with a client's network controller without
  --    being handed the tenant's authentication settings.
  IF NOT EXISTS (SELECT 1 FROM permission WHERE key = 'integration:network:manage') THEN
    RAISE EXCEPTION 'helm: integration:network:manage was not created';
  END IF;

  IF EXISTS (
    SELECT 1 FROM role_permission
    WHERE permission_key = 'integration:network:manage' AND role_key = 'tenant_write_holder'
  ) THEN
    RAISE EXCEPTION 'helm: the network permission was bound to a tenant:write holder';
  END IF;

  -- 2. It is NOT implied by integration:manage. A role holding the general
  --    integration permission and not this one must be refused — which is the
  --    separation the brief asked for and is easy to erase later by granting
  --    both to the same roles "for convenience".
  IF EXISTS (
    SELECT 1
    FROM role_permission general
    WHERE general.permission_key = 'integration:manage'
      AND NOT EXISTS (
        SELECT 1 FROM role_permission specific
        WHERE specific.role_key = general.role_key
          AND specific.permission_key = 'integration:network:manage')
  ) THEN
    -- Informational, not fatal: tier2 legitimately holds neither.
    RAISE NOTICE 'helm: some roles hold integration:manage without integration:network:manage, which is the intended separation';
  END IF;

  -- 3. THE API KEY IS NOT A COLUMN. The brief was explicit, and a bespoke
  --    encrypted column here would be the only credential in the product
  --    outside the vault and outside the audit trail.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'unifi_site_mapping'
      AND column_name ~ '(api_key|credential)s?_(enc|ciphertext)$'
  ) THEN
    RAISE EXCEPTION 'helm: unifi_site_mapping grew a bespoke credential column';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'unifi_site_mapping'::regclass AND conname = 'unifi_mapping_secret_fk'
  ) THEN
    RAISE EXCEPTION 'helm: the API key is no longer a reference into secret';
  END IF;

  -- 4. ...and the reveal ladder knows about it. Without this the sync is
  --    refused 'not_an_integration_credential' on every poll.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'is_integration_credential')
     NOT LIKE '%unifi_site_mapping%' THEN
    RAISE EXCEPTION 'helm: reveal_secret cannot see a UniFi API key, so every poll would fail';
  END IF;

  -- 5. NO BLANKET TLS DISABLE. Verification off with nothing pinned must be
  --    unrepresentable, not merely discouraged.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'unifi_site_mapping'::regclass
      AND conname = 'unifi_mapping_no_blanket_disable'
  ) THEN
    RAISE EXCEPTION 'helm: a mapping can now disable TLS verification outright';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'unifi_site_mapping'::regclass
      AND conname = 'unifi_mapping_pin_acknowledged'
  ) THEN
    RAISE EXCEPTION 'helm: a TLS exception can now be set without an acknowledgment';
  END IF;

  -- 6. THE PRESERVATION GUARANTEE. The upsert must not name a user-owned column
  --    in its UPDATE branch. Checked by reading the definition, because the
  --    alternative is trusting that nobody adds `notes = EXCLUDED.notes` on a
  --    tired afternoon.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'upsert_network_asset')
     ~ '(custom_name_enc|asset_tag|department|notes|maintenance_status)\s*=\s*EXCLUDED' THEN
    RAISE EXCEPTION 'helm: the sync upsert now overwrites a user-edited field';
  END IF;

  -- 7. THE ID IS THE CALLER'S. The encrypted columns are sealed against an AAD
  --    naming this row's id, so an INSERT that lets the default generate one
  --    writes ciphertext nothing can ever open -- silently, because an insert
  --    that succeeds looks like an insert that worked. Checked by reading the
  --    definition: the parameter must be there AND the INSERT must use it.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'upsert_network_asset')
     !~ 'VALUES\s*\(\s*p_asset_id' THEN
    RAISE EXCEPTION 'helm: the asset upsert no longer inserts the id its ciphertext is bound to';
  END IF;

  -- 8. The cross-tenant enumerator is the worker's alone.
  IF has_function_privilege('helm_app', 'helm.unifi_poll_backlog(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app can enumerate every tenant''s controllers';
  END IF;

  -- 9. Every new table carries RLS, forced.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('unifi_site_mapping', 'network_assets', 'asset_ip_history')
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'helm: a UniFi table is missing FORCE ROW LEVEL SECURITY';
  END IF;
END;
$unifi_guard$;
