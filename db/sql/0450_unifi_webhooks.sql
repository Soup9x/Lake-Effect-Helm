-- =============================================================================
-- 0450 — UniFi webhooks: a low-latency supplement to the poll, never a
--        replacement for it
--
-- Part 1 (0430) polls each controller on a schedule. That remains the source of
-- truth and nothing here changes it. A webhook only shortens the gap between a
-- device changing state and Helm knowing: minutes become seconds, and when no
-- webhook ever arrives the poll produces exactly the same answer a little later.
--
-- THAT IS A DESIGN CONSTRAINT, NOT A DISCLAIMER. Webhook delivery on a UniFi
-- console is not guaranteed across versions or hardware, and an integration
-- whose correctness depended on it would be broken on an unknown fraction of
-- deployments with no way to tell which. So: nothing reads from the webhook
-- path that the poll does not also write, a mapping whose controller refuses
-- webhook registration is marked `unsupported` and carries on polling, and the
-- settings card says so rather than showing a silent green tick.
--
-- WHY THE SIGNING SECRET IS A COLUMN HERE AND THE API KEY IS NOT
--
-- 0430 was explicit that the controller's API key belongs in `secret`, behind
-- helm.reveal_secret(), with an audit row per access. That is right for a
-- credential a person can ask to see and a worker uses a few times an hour.
--
-- It is the wrong shape for this one, for the same reason 0420 moved the
-- outbound webhook signing secret out of the vault:
--
--   * The receiver is UNAUTHENTICATED. A controller POSTing an event has no
--     session, so there is no actor for reveal_secret() to attribute the read
--     to and no tenant context to open one under. The secret has to be readable
--     from the request path before we know whose request it is.
--
--   * A reveal per inbound event writes an audit row per inbound event. An IDS
--     alert storm would bury the audit log in records of Helm reading its own
--     key, which is the noise that hides the events worth seeing.
--
-- So it follows 0420 exactly: a self-contained envelope on the row, sealed
-- under a purpose-bound DEK. It is not reachable by a client role, not returned
-- by any settings function, and bound by AAD to this mapping — a row copied
-- between mappings or deployments fails to open rather than quietly verifying
-- somebody else's traffic.
-- =============================================================================
SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- The mapping learns to receive.
-- -----------------------------------------------------------------------------
ALTER TABLE unifi_site_mapping
  -- The envelope, self-contained: 0420's shape, for 0420's reasons.
  ADD COLUMN IF NOT EXISTS webhook_wrap_provider     text,
  ADD COLUMN IF NOT EXISTS webhook_kek_id            text,
  ADD COLUMN IF NOT EXISTS webhook_wrapped_dek       bytea,
  ADD COLUMN IF NOT EXISTS webhook_secret_ciphertext bytea,
  ADD COLUMN IF NOT EXISTS webhook_secret_nonce      bytea,
  ADD COLUMN IF NOT EXISTS webhook_secret_tag        bytea,
  ADD COLUMN IF NOT EXISTS webhook_secret_aad        text,

  -- Health, which the settings card from part 1 renders beside the poll's.
  --
  --   disabled     no secret configured; the receiver rejects everything
  --   pending      configured, nothing received yet
  --   active       a signed event has arrived
  --   unsupported  the controller refused webhook registration. NOT an error
  --                state: polling is unaffected and this is the expected answer
  --                on a console that predates the feature.
  --   failing      events are arriving and being rejected
  ADD COLUMN IF NOT EXISTS webhook_state text NOT NULL DEFAULT 'disabled',
  ADD COLUMN IF NOT EXISTS webhook_registered_at  timestamptz,
  ADD COLUMN IF NOT EXISTS webhook_last_event_at  timestamptz,
  ADD COLUMN IF NOT EXISTS webhook_last_error     text,
  ADD COLUMN IF NOT EXISTS webhook_events_received bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS webhook_events_rejected bigint NOT NULL DEFAULT 0;

ALTER TABLE unifi_site_mapping DROP CONSTRAINT IF EXISTS unifi_webhook_state_known;
ALTER TABLE unifi_site_mapping DROP CONSTRAINT IF EXISTS unifi_webhook_envelope_complete;
ALTER TABLE unifi_site_mapping DROP CONSTRAINT IF EXISTS unifi_webhook_nonce_len;
ALTER TABLE unifi_site_mapping DROP CONSTRAINT IF EXISTS unifi_webhook_tag_len;
ALTER TABLE unifi_site_mapping DROP CONSTRAINT IF EXISTS unifi_webhook_counters_nonneg;
ALTER TABLE unifi_site_mapping DROP CONSTRAINT IF EXISTS unifi_webhook_listening_needs_secret;

ALTER TABLE unifi_site_mapping
  ADD CONSTRAINT unifi_webhook_state_known CHECK (
    webhook_state IN ('disabled', 'pending', 'active', 'unsupported', 'failing')),
  -- All-or-nothing, as in 0420: a half-written envelope is a mapping that
  -- cannot verify anything and cannot be seen to be broken.
  ADD CONSTRAINT unifi_webhook_envelope_complete CHECK (
    (webhook_wrap_provider IS NULL AND webhook_kek_id IS NULL
     AND webhook_wrapped_dek IS NULL AND webhook_secret_ciphertext IS NULL
     AND webhook_secret_nonce IS NULL AND webhook_secret_tag IS NULL
     AND webhook_secret_aad IS NULL)
    OR
    (webhook_wrap_provider IS NOT NULL AND webhook_kek_id IS NOT NULL
     AND webhook_wrapped_dek IS NOT NULL AND webhook_secret_ciphertext IS NOT NULL
     AND webhook_secret_nonce IS NOT NULL AND webhook_secret_tag IS NOT NULL
     AND webhook_secret_aad IS NOT NULL)),
  ADD CONSTRAINT unifi_webhook_nonce_len CHECK (
    webhook_secret_nonce IS NULL OR octet_length(webhook_secret_nonce) = 12),
  ADD CONSTRAINT unifi_webhook_tag_len CHECK (
    webhook_secret_tag IS NULL OR octet_length(webhook_secret_tag) = 16),
  ADD CONSTRAINT unifi_webhook_counters_nonneg CHECK (
    webhook_events_received >= 0 AND webhook_events_rejected >= 0),
  -- A mapping cannot claim to be listening without something to verify with.
  -- `unsupported` is deliberately allowed with no secret: it records that the
  -- controller said no, which is worth keeping whether or not a secret was set.
  ADD CONSTRAINT unifi_webhook_listening_needs_secret CHECK (
    webhook_state NOT IN ('pending', 'active', 'failing')
    OR webhook_secret_ciphertext IS NOT NULL);

COMMENT ON COLUMN unifi_site_mapping.webhook_state IS
  'Receiver health. `unsupported` means the controller refused registration, '
  'which is expected on older consoles and does not affect polling.';

-- -----------------------------------------------------------------------------
-- network_threat_event — the encrypted half of a threat audit record.
--
-- WHY NOT A COLUMN ON audit_log
--
-- Two reasons, and the second is the one that decided it.
--
--   1. audit_log.metadata is documented and enforced as NON-SENSITIVE: a
--      trigger rejects secret-bearing keys. An IDS alert names a source IP, a
--      destination IP and often a MAC — all of which 0430 treats as identifying
--      and encrypts in network_assets. Putting them in metadata would
--      contradict the column's contract in the same schema that states it.
--
--   2. audit_log.row_hash is computed from a canonical form pinned field by
--      field, deliberately, so that adding a column does not invalidate every
--      hash already written. The flip side is that a new column would NOT be
--      covered by the chain — encrypted threat detail sitting in audit_log
--      would be the one part of the audit record that could be altered without
--      detection. Here it is covered instead by `detail_sha256` in the audit
--      row's metadata: the chain commits to a digest of the ciphertext, so the
--      detail is tamper-evident without the audit log ever holding it.
--
-- The audit row remains the record that something happened. This is the part
-- you need a key to read.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS network_threat_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  mapping_id      uuid REFERENCES unifi_site_mapping(id) ON DELETE SET NULL,
  -- The asset this was about, when the MAC matched one we know. Nullable: a
  -- threat involving a device Helm has never seen is exactly the kind worth
  -- keeping.
  asset_id        uuid REFERENCES network_assets(id) ON DELETE SET NULL,

  -- The audit row this belongs to. Not an FK: audit_log is partitioned on
  -- occurred_at and its primary key is (id, occurred_at), so a reference by
  -- event_uid alone cannot be one. The audit row is immutable and never
  -- deleted, which is the guarantee an FK would have been buying.
  audit_event_uid uuid NOT NULL,

  -- Queryable, and deliberately not encrypted: severity and rule name are how
  -- an operator finds the event, and neither identifies a person or a machine.
  severity        text NOT NULL,
  signature       text,
  category        text,
  detected_at     timestamptz NOT NULL DEFAULT now(),

  -- The controller's own id for this event, when it sends one. A valid webhook
  -- can be captured and replayed, and a replayed threat alert that produced a
  -- second audit row would turn one incident into two in a compliance report.
  -- Nullable because not every event carries an id, and deduplicated by a
  -- partial unique index rather than a constraint for exactly that reason.
  external_event_id text,

  -- The identifying parts, sealed with the tenant DEK exactly as network_assets
  -- seals a MAC. detail_enc holds the controller's raw event, which can contain
  -- addresses and hostnames anywhere in its structure and is therefore treated
  -- as sensitive in whole rather than picked over field by field.
  data_key_id     uuid NOT NULL REFERENCES tenant_data_key(id) ON DELETE RESTRICT,
  source_ip_enc   bytea,
  dest_ip_enc     bytea,
  detail_enc      bytea NOT NULL,

  -- Correlation without a queryable address, same mechanism as 0430.
  source_ip_blind_index bytea,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT network_threat_org_fk
    FOREIGN KEY (organization_id, tenant_id) REFERENCES organization(id, tenant_id)
    ON DELETE CASCADE,
  CONSTRAINT network_threat_severity_known CHECK (
    severity IN ('info', 'low', 'medium', 'high', 'critical')),
  CONSTRAINT network_threat_source_index_len CHECK (
    source_ip_blind_index IS NULL OR octet_length(source_ip_blind_index) = 32),
  CONSTRAINT network_threat_detail_present CHECK (octet_length(detail_enc) > 0)
);

CREATE INDEX IF NOT EXISTS network_threat_tenant_time_idx
  ON network_threat_event (tenant_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS network_threat_org_idx
  ON network_threat_event (tenant_id, organization_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS network_threat_audit_idx
  ON network_threat_event (audit_event_uid);
-- Replay protection. Partial, so events with no id are simply not deduplicated
-- rather than colliding with each other on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS network_threat_external_id_idx
  ON network_threat_event (tenant_id, mapping_id, external_event_id)
  WHERE external_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS network_threat_source_idx
  ON network_threat_event (tenant_id, source_ip_blind_index)
  WHERE source_ip_blind_index IS NOT NULL;

SELECT helm.apply_tenant_rls('network_threat_event', true, 80, NULL);

-- =============================================================================
-- Functions
-- =============================================================================

-- -----------------------------------------------------------------------------
-- helm.unifi_webhook_target — the one cross-tenant lookup, and why it is safe.
--
-- An inbound webhook has no session. Before Helm can open a tenant context it
-- has to know WHICH tenant, and the only thing the request carries is the
-- mapping id in its path. So exactly one lookup has to cross the boundary.
--
-- What keeps that acceptable is how narrow it is, and each of these is a
-- property to preserve rather than an accident:
--
--   * It takes a PRIMARY KEY and returns at most one row. It is not an
--     enumerator. 0430's guard #8 forbids helm_app reaching
--     helm.unifi_poll_backlog() precisely because that one returns every
--     tenant's controllers; this returns one mapping, named by an unguessable
--     uuid the caller already had.
--   * It returns NO CREDENTIAL the request path could misuse. The controller's
--     API key is not in the result and cannot be — it lives in `secret` behind
--     reveal_secret(). What comes back is the signing envelope, which is only
--     useful for verifying a signature and is itself sealed.
--   * It returns nothing for a mapping that is not listening, so a disabled or
--     unsupported mapping is indistinguishable from one that does not exist.
--
-- After this returns, everything else happens inside withTenant() under the
-- tenant it names, subject to RLS like any other request.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.unifi_webhook_target(p_mapping_id uuid)
RETURNS TABLE (
  tenant_id       uuid,
  organization_id uuid,
  unifi_site_id   text,
  webhook_state   text,
  -- The identity the receiver acts as once it has a tenant. system_sync, the
  -- same machine identity the poll uses: the webhook writes the same rows for
  -- the same reasons, so it should be the same actor in the audit trail rather
  -- than a second one nobody has heard of. helm_app cannot execute
  -- helm.worker_actor() itself, which is why it is resolved here.
  worker_actor_id uuid,
  wrap_provider   text,
  kek_id          text,
  wrapped_dek     bytea,
  secret_ciphertext bytea,
  secret_nonce    bytea,
  secret_tag      bytea,
  secret_aad      text
)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT m.tenant_id, m.organization_id, m.unifi_site_id, m.webhook_state,
         helm.worker_actor(m.tenant_id, 'system_sync'),
         m.webhook_wrap_provider, m.webhook_kek_id, m.webhook_wrapped_dek,
         m.webhook_secret_ciphertext, m.webhook_secret_nonce,
         m.webhook_secret_tag, m.webhook_secret_aad
  FROM unifi_site_mapping m
  WHERE m.id = p_mapping_id
    AND m.webhook_secret_ciphertext IS NOT NULL
    AND m.webhook_state IN ('pending', 'active', 'failing')
    AND helm.worker_actor(m.tenant_id, 'system_sync') IS NOT NULL;
$$;

-- -----------------------------------------------------------------------------
-- helm.note_unifi_webhook — record that something arrived, accepted or not.
--
-- Also cross-tenant by primary key, and for the same unavoidable reason: a
-- request that fails signature verification must still be counted, and at that
-- point Helm has decided NOT to trust the claim about whose tenant it is.
--
-- Rejections are counted and the reason kept, because "this mapping is being
-- sent events it refuses" is a real condition — a rotated secret, a misrouted
-- controller, or somebody probing — and the difference between that and silence
-- is the whole point of having the counter.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.note_unifi_webhook(
  p_mapping_id uuid,
  p_accepted   boolean,
  p_error      text DEFAULT NULL
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE unifi_site_mapping m
  SET webhook_events_received = m.webhook_events_received + (CASE WHEN p_accepted THEN 1 ELSE 0 END),
      webhook_events_rejected = m.webhook_events_rejected + (CASE WHEN p_accepted THEN 0 ELSE 1 END),
      webhook_last_event_at = CASE WHEN p_accepted THEN now() ELSE m.webhook_last_event_at END,
      webhook_last_error = CASE WHEN p_accepted THEN NULL ELSE left(p_error, 500) END,
      -- An accepted event proves the path works. A rejected one only downgrades
      -- a mapping that was already listening — it must not resurrect one that
      -- is disabled or mark an `unsupported` controller as failing, because
      -- neither of those is what a bad signature tells you.
      webhook_state = CASE
        WHEN p_accepted AND m.webhook_state IN ('pending', 'active', 'failing') THEN 'active'
        WHEN NOT p_accepted AND m.webhook_state IN ('pending', 'active', 'failing') THEN 'failing'
        ELSE m.webhook_state
      END
  WHERE m.id = p_mapping_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.set_unifi_webhook_secret — configuring the receiver.
--
-- Gated on integration:network:manage, the same permission 0430 requires for
-- every other part of mapping configuration, and checked HERE as well as in the
-- route: the route's check produces a good error message, this one is the check
-- that actually holds.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_unifi_webhook_secret(
  p_mapping_id    uuid,
  p_wrap_provider text,
  p_kek_id        text,
  p_wrapped_dek   bytea,
  p_ciphertext    bytea,
  p_nonce         bytea,
  p_tag           bytea,
  p_aad           text
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.has_permission('integration:network:manage') THEN
    RAISE EXCEPTION 'helm: integration:network:manage is required to configure a controller'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE unifi_site_mapping m
  SET webhook_wrap_provider = p_wrap_provider,
      webhook_kek_id = p_kek_id,
      webhook_wrapped_dek = p_wrapped_dek,
      webhook_secret_ciphertext = p_ciphertext,
      webhook_secret_nonce = p_nonce,
      webhook_secret_tag = p_tag,
      webhook_secret_aad = p_aad,
      -- Rotating the secret returns the mapping to `pending`: the old
      -- signature stops verifying at this instant, and claiming `active` until
      -- something proves otherwise would be claiming the controller has already
      -- been reconfigured.
      webhook_state = 'pending',
      webhook_last_error = NULL,
      updated_at = now()
  WHERE m.id = p_mapping_id AND m.tenant_id = v_tenant;

  RETURN FOUND;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.set_unifi_webhook_state — what the registration attempt writes.
--
-- The `unsupported` path is the one that matters. A console that has never
-- heard of webhook registration answers 404, and the honest thing to record is
-- "this controller does not do this", not an error — polling is unaffected and
-- the operator has nothing to fix.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_unifi_webhook_state(
  p_mapping_id uuid,
  p_state      text,
  p_error      text DEFAULT NULL
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.has_permission('integration:network:manage') THEN
    RAISE EXCEPTION 'helm: integration:network:manage is required to configure a controller'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE unifi_site_mapping m
  SET webhook_state = p_state,
      -- Disabling REVOKES. Leaving the envelope behind would mean a mapping
      -- that reads as "off" in the interface while a secret somebody pasted
      -- into a console still exists in the database — and the constraint
      -- permits that combination, so nothing else would catch it.
      webhook_wrap_provider = CASE WHEN p_state = 'disabled' THEN NULL ELSE m.webhook_wrap_provider END,
      webhook_kek_id = CASE WHEN p_state = 'disabled' THEN NULL ELSE m.webhook_kek_id END,
      webhook_wrapped_dek = CASE WHEN p_state = 'disabled' THEN NULL ELSE m.webhook_wrapped_dek END,
      webhook_secret_ciphertext = CASE WHEN p_state = 'disabled' THEN NULL ELSE m.webhook_secret_ciphertext END,
      webhook_secret_nonce = CASE WHEN p_state = 'disabled' THEN NULL ELSE m.webhook_secret_nonce END,
      webhook_secret_tag = CASE WHEN p_state = 'disabled' THEN NULL ELSE m.webhook_secret_tag END,
      webhook_secret_aad = CASE WHEN p_state = 'disabled' THEN NULL ELSE m.webhook_secret_aad END,
      webhook_last_error = left(p_error, 500),
      webhook_registered_at = CASE WHEN p_state IN ('pending', 'active') THEN now()
                                   ELSE m.webhook_registered_at END,
      updated_at = now()
  WHERE m.id = p_mapping_id AND m.tenant_id = v_tenant;

  RETURN FOUND;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.apply_webhook_telemetry — the fast path, and the same preservation rule.
--
-- UPDATE ONLY. A webhook never creates an asset, and that is deliberate rather
-- than an omission: the poll is the source of truth and enumerates a site with
-- the controller's own authority, whereas an event names one device and arrives
-- over a path whose only check is a shared secret. An unknown MAC returns 0
-- rows and the next poll picks the device up properly.
--
-- The SET list is the intersection of what a webhook can know and what 0430
-- lets a sync touch — and like helm.upsert_network_asset() it names no
-- user-owned column. The guard below checks that by reading this definition,
-- because "the webhook path forgot the rule the poll path follows" is exactly
-- the shape of divergence two write paths produce.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.apply_webhook_telemetry(
  p_mac_blind_index bytea,
  p_is_online       boolean,
  p_ip_enc          bytea    DEFAULT NULL,
  p_data_key_id     uuid     DEFAULT NULL,
  p_device_state    text     DEFAULT NULL,
  p_uptime_seconds  bigint   DEFAULT NULL,
  p_signal_dbm      smallint DEFAULT NULL,
  p_switch_port     integer  DEFAULT NULL,
  p_seen_at         timestamptz DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_id     uuid;
BEGIN
  UPDATE network_assets a
  SET is_online = p_is_online,
      -- coalesce throughout: an event that says "this device went offline"
      -- carries no signal strength, and overwriting the poll's value with NULL
      -- would make the webhook path lose information the poll had.
      ip_address_enc = coalesce(p_ip_enc, a.ip_address_enc),
      data_key_id = coalesce(p_data_key_id, a.data_key_id),
      device_state = coalesce(p_device_state, a.device_state),
      uptime_seconds = coalesce(p_uptime_seconds, a.uptime_seconds),
      signal_dbm = coalesce(p_signal_dbm, a.signal_dbm),
      switch_port = coalesce(p_switch_port, a.switch_port),
      last_seen_at = CASE WHEN p_is_online THEN coalesce(p_seen_at, now()) ELSE a.last_seen_at END,
      last_synced_at = now()
      -- DELIBERATELY ABSENT, exactly as in helm.upsert_network_asset:
      -- custom_name_enc, asset_tag, department, notes, maintenance_status,
      -- organization_id. A person wrote those and an event does not get to have
      -- an opinion about them either.
  WHERE a.tenant_id = v_tenant AND a.mac_blind_index = p_mac_blind_index
  RETURNING a.id INTO v_id;

  RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.record_network_threat — the audit row and its encrypted half, together.
--
-- One function and one transaction because the two are one record. An audit row
-- whose detail failed to write is a threat report with no content; detail with
-- no audit row is invisible to every existing compliance path.
--
-- The digest is what ties them: helm.audit() hash-chains the metadata, so the
-- chain commits to sha256(detail_enc) and the ciphertext cannot later be
-- swapped without the audit verifier noticing. The audit log still holds no
-- address, no MAC and no hostname.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_network_threat(
  p_mapping_id      uuid,
  p_organization_id uuid,
  p_asset_id        uuid,
  p_severity        text,
  p_signature       text,
  p_category        text,
  p_detected_at     timestamptz,
  p_data_key_id     uuid,
  p_source_ip_enc   bytea,
  p_dest_ip_enc     bytea,
  p_detail_enc      bytea,
  p_source_ip_blind_index bytea,
  p_external_event_id text DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant    uuid := helm.require_tenant_id();
  v_event_uid uuid;
BEGIN
  -- A replay arrives here having already passed signature verification, because
  -- a replay IS a validly signed request. Caught on the controller's event id
  -- instead, and treated as success: the caller is not wrong, the event is
  -- simply already recorded.
  IF p_external_event_id IS NOT NULL THEN
    SELECT t.audit_event_uid INTO v_event_uid
    FROM network_threat_event t
    WHERE t.tenant_id = v_tenant AND t.mapping_id = p_mapping_id
      AND t.external_event_id = p_external_event_id;
    IF FOUND THEN
      RETURN v_event_uid;
    END IF;
  END IF;

  -- Non-sensitive only. Severity and rule name are what an operator searches
  -- on; everything that identifies a machine is in detail_enc.
  v_event_uid := helm.audit(
    'network.threat_detected',
    'network_asset',
    p_asset_id,
    'error'::audit_outcome,
    p_organization_id,
    NULL,
    NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'severity', p_severity,
      'signature', p_signature,
      'category', p_category,
      'mapping_id', p_mapping_id,
      'asset_known', p_asset_id IS NOT NULL,
      'detail_sha256', encode(extensions.digest(p_detail_enc, 'sha256'), 'hex')
    )));

  INSERT INTO network_threat_event (
    tenant_id, organization_id, mapping_id, asset_id, audit_event_uid,
    severity, signature, category, detected_at, data_key_id,
    source_ip_enc, dest_ip_enc, detail_enc, source_ip_blind_index, external_event_id)
  VALUES (
    v_tenant, p_organization_id, p_mapping_id, p_asset_id, v_event_uid,
    p_severity, p_signature, p_category, coalesce(p_detected_at, now()), p_data_key_id,
    p_source_ip_enc, p_dest_ip_enc, p_detail_enc, p_source_ip_blind_index, p_external_event_id);

  RETURN v_event_uid;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.unifi_mappings() gains the receiver's health.
--
-- DROP then CREATE, not CREATE OR REPLACE: a function's RETURNS TABLE shape
-- cannot be widened in place. 0400 hit the same wall with request_export.
--
-- The signing envelope is NOT in the result and must never be. This function
-- feeds a settings page; `webhook_secret_set` is the only thing it says about
-- the secret, which is the same contract api_key_set has held since 0430.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS helm.unifi_mappings();
CREATE FUNCTION helm.unifi_mappings()
 RETURNS TABLE(id uuid, organization_id uuid, organization_name text, name text, controller_url text, unifi_site_id text, is_active boolean, api_key_set boolean, tls_verify boolean, tls_pinned_sha256 text, tls_exception_ack_at timestamp with time zone, tls_exception_ack_by_name text, poll_interval_seconds integer, last_poll_at timestamp with time zone, last_poll_ok boolean, last_poll_error text, consecutive_failures integer, next_poll_at timestamp with time zone, last_device_count integer, last_client_count integer, asset_count bigint, webhook_state text, webhook_secret_set boolean, webhook_registered_at timestamp with time zone, webhook_last_event_at timestamp with time zone, webhook_last_error text, webhook_events_received bigint, webhook_events_rejected bigint, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'helm', 'extensions', 'pg_catalog', 'pg_temp'
AS $function$
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
           m.webhook_state, m.webhook_secret_ciphertext IS NOT NULL,
           m.webhook_registered_at, m.webhook_last_event_at, m.webhook_last_error,
           m.webhook_events_received, m.webhook_events_rejected,
           m.updated_at
    FROM unifi_site_mapping m
    JOIN organization o ON o.id = m.organization_id AND o.tenant_id = v_tenant
    LEFT JOIN app_user ack ON ack.id = m.tls_exception_ack_by
    WHERE m.tenant_id = v_tenant
    ORDER BY o.name, m.name;
END;
$function$;

-- =============================================================================
-- Grants
-- =============================================================================
REVOKE ALL ON FUNCTION helm.unifi_webhook_target(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.note_unifi_webhook(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_unifi_webhook_secret(uuid, text, text, bytea, bytea, bytea, bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_unifi_webhook_state(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.apply_webhook_telemetry(bytea, boolean, bytea, uuid, text, bigint, smallint, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_network_threat(uuid, uuid, uuid, text, text, text, timestamptz, uuid, bytea, bytea, bytea, bytea, text) FROM PUBLIC;

-- The receiver runs on the request path, so these are helm_app's. Each one is
-- either scoped by primary key (the two that must run before a tenant context
-- exists) or by helm.require_tenant_id() inside the body.
GRANT EXECUTE ON FUNCTION helm.unifi_webhook_target(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.note_unifi_webhook(uuid, boolean, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_unifi_webhook_secret(uuid, text, text, bytea, bytea, bytea, bytea, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_unifi_webhook_state(uuid, text, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.apply_webhook_telemetry(bytea, boolean, bytea, uuid, text, bigint, smallint, integer, timestamptz) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.record_network_threat(uuid, uuid, uuid, text, text, text, timestamptz, uuid, bytea, bytea, bytea, bytea, text) TO helm_app;

GRANT EXECUTE ON FUNCTION helm.unifi_mappings() TO helm_app;

-- =============================================================================
-- Guards
-- =============================================================================
DO $webhook_guard$
BEGIN
  -- 1. THE WEBHOOK PATH OBEYS THE SAME PRESERVATION RULE AS THE POLL.
  --    Two write paths into one table is how a rule ends up enforced on one of
  --    them. Read out of the definition rather than demonstrated, because a
  --    behavioural test only catches the columns it happens to name.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'apply_webhook_telemetry')
     ~ '(custom_name_enc|asset_tag|department|notes|maintenance_status|organization_id)\s*=' THEN
    RAISE EXCEPTION 'helm: the webhook telemetry path now writes a user-owned field';
  END IF;

  -- 2. ...and it cannot CREATE an asset. The poll enumerates a site with the
  --    controller's own authority; an event arrives over a path whose only
  --    check is a shared secret. Only one of those should be able to put a new
  --    device into a client's documentation.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'apply_webhook_telemetry')
     ~* 'INSERT\s+INTO\s+network_assets' THEN
    RAISE EXCEPTION 'helm: the webhook path can now create assets, which belongs to the poll';
  END IF;

  -- 3. THE CROSS-TENANT LOOKUP IS NOT AN ENUMERATOR. It takes a primary key.
  --    A version of it that took, say, a site id or a host would return rows
  --    for every tenant using that string, which is the failure 0430's guard #8
  --    exists to prevent on the poll side.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'unifi_webhook_target'
        AND p.pronargs = 1 AND p.proargtypes[0] = 'uuid'::regtype) <> 1 THEN
    RAISE EXCEPTION 'helm: unifi_webhook_target no longer takes exactly one uuid';
  END IF;

  -- 4. ...and it hands back no credential the request path could misuse. The
  --    controller API key stays behind reveal_secret(); only the signing
  --    envelope crosses, and that is itself sealed.
  IF (SELECT pg_get_function_result(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'unifi_webhook_target')
     ~* 'api_key' THEN
    RAISE EXCEPTION 'helm: unifi_webhook_target returns the controller API key';
  END IF;

  -- 5. THE SETTINGS PAGE NEVER SEES THE SIGNING SECRET. Same contract
  --    api_key_set has held since 0430: whether one is set, never what it is.
  IF (SELECT pg_get_function_result(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'unifi_mappings')
     ~* '(ciphertext|wrapped_dek|secret_nonce|secret_tag)' THEN
    RAISE EXCEPTION 'helm: unifi_mappings leaks the webhook signing envelope';
  END IF;

  -- 6. Configuring the receiver needs the same permission as the rest of the
  --    mapping. A webhook secret is a way in; it must not be easier to set than
  --    the controller URL it belongs to.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'set_unifi_webhook_secret')
     NOT LIKE '%integration:network:manage%' THEN
    RAISE EXCEPTION 'helm: the webhook secret can be set without integration:network:manage';
  END IF;

  -- 7. The threat detail is tenant data under RLS like anything else.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'network_threat_event'
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'helm: network_threat_event is missing FORCE ROW LEVEL SECURITY';
  END IF;

  -- 8. NOTHING THE POLL DOES DEPENDS ON ANY OF THIS. The sync worker's
  --    functions must not have grown a reference to webhook state: a poll that
  --    consulted webhook_state would make the supplement load-bearing, which is
  --    the one thing this whole file is not allowed to be.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm'
      AND p.proname IN ('unifi_poll_backlog', 'claim_unifi_poll', 'finish_unifi_poll',
                        'upsert_network_asset')
      AND pg_get_functiondef(p.oid) ~* 'webhook'
  ) THEN
    RAISE EXCEPTION 'helm: the polling path now depends on webhook state';
  END IF;
END;
$webhook_guard$;
