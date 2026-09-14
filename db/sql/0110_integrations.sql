-- =============================================================================
-- 0110_integrations.sql — RMM / PSA / Microsoft Graph sync and webhooks
--
-- Integration credentials are secrets like any other: stored in secret_version,
-- revealed through the audited API. An "api_key text" column on a connections
-- table is how an MSP platform ends up leaking every client's RMM key in a
-- single database dump.
--
-- external_identity is the correlation spine. Without a stable mapping, a
-- re-sync creates duplicates and the second sync's "cleanup" deletes real
-- documentation. The unique constraints here make that structurally impossible.
-- =============================================================================

SET search_path = public, extensions;

CREATE TYPE integration_provider AS ENUM (
  'ninja_one', 'n_able_ncentral', 'n_able_rmm', 'datto_rmm',
  'connectwise_manage', 'connectwise_automate', 'halo_psa', 'autotask',
  'microsoft_graph', 'custom'
);

CREATE TYPE integration_status AS ENUM ('configured', 'active', 'degraded', 'error', 'disabled');

CREATE TYPE sync_direction AS ENUM ('inbound', 'outbound', 'bidirectional');

CREATE TYPE sync_run_status AS ENUM ('queued', 'running', 'success', 'partial', 'failed', 'cancelled');

CREATE TYPE webhook_delivery_status AS ENUM ('pending', 'delivered', 'failed', 'dead');

-- -----------------------------------------------------------------------------
-- integration_connection
-- -----------------------------------------------------------------------------
CREATE TABLE integration_connection (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  -- NULL for a tenant-wide connection (one RMM covering every client);
  -- set for a per-client connection (that client's own M365 tenant).
  organization_id    uuid,

  provider           integration_provider NOT NULL,
  display_name       text NOT NULL,
  status             integration_status NOT NULL DEFAULT 'configured',
  direction          sync_direction NOT NULL DEFAULT 'inbound',

  base_url           text,
  -- Non-sensitive configuration only: instance ids, company filters, field maps.
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Every credential this connection needs, by role: 'client_secret',
  -- 'api_key', 'refresh_token'. Values are secret ids, never material.
  credential_secret_ids jsonb NOT NULL DEFAULT '{}'::jsonb,

  sync_enabled       boolean NOT NULL DEFAULT false,
  sync_interval_minutes integer NOT NULL DEFAULT 60,
  sync_cursor        text,
  last_sync_at       timestamptz,
  last_success_at    timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_error         text,

  -- Sync must never overwrite a field a technician edited by hand. When true,
  -- inbound values only fill fields that are still NULL.
  respect_manual_edits boolean NOT NULL DEFAULT true,

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  disabled_at        timestamptz,

  CONSTRAINT integration_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT integration_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT integration_config_object CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT integration_credentials_object CHECK (jsonb_typeof(credential_secret_ids) = 'object'),
  CONSTRAINT integration_interval_sane CHECK (sync_interval_minutes BETWEEN 5 AND 10080),
  CONSTRAINT integration_base_url_https CHECK (base_url IS NULL OR base_url ~ '^https://'),
  CONSTRAINT integration_failures_non_negative CHECK (consecutive_failures >= 0)
);
CREATE INDEX integration_due_idx ON integration_connection (tenant_id, last_sync_at)
  WHERE sync_enabled AND disabled_at IS NULL;
CREATE UNIQUE INDEX integration_provider_org_uk
  ON integration_connection (tenant_id, provider, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), display_name);

COMMENT ON COLUMN integration_connection.credential_secret_ids IS
  'Map of credential role -> secret uuid. Holds references, never material; the '
  'sync worker resolves them through helm.reveal_secret() so machine access to '
  'client credentials is audited exactly like human access.';

-- -----------------------------------------------------------------------------
-- integration_sync_run
-- -----------------------------------------------------------------------------
CREATE TABLE integration_sync_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  connection_id  uuid NOT NULL,

  status         sync_run_status NOT NULL DEFAULT 'queued',
  trigger_source text NOT NULL DEFAULT 'schedule',
  started_at     timestamptz,
  finished_at    timestamptz,

  records_seen     integer NOT NULL DEFAULT 0,
  records_created  integer NOT NULL DEFAULT 0,
  records_updated  integer NOT NULL DEFAULT 0,
  records_skipped  integer NOT NULL DEFAULT 0,
  records_failed   integer NOT NULL DEFAULT 0,

  cursor_before  text,
  cursor_after   text,
  error_summary  text,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT sync_run_connection_fk FOREIGN KEY (connection_id, tenant_id)
    REFERENCES integration_connection (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT sync_run_details_object CHECK (jsonb_typeof(details) = 'object'),
  CONSTRAINT sync_run_finish_after_start CHECK (
    finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at
  ),
  CONSTRAINT sync_run_trigger_known CHECK (
    trigger_source IN ('schedule', 'manual', 'webhook', 'backfill')
  )
);
CREATE INDEX sync_run_connection_idx ON integration_sync_run (connection_id, started_at DESC);

-- Only one run in flight per connection. Two concurrent syncs against the same
-- cursor is how duplicate assets get created.
CREATE UNIQUE INDEX sync_run_one_active
  ON integration_sync_run (connection_id) WHERE status IN ('queued', 'running');

-- -----------------------------------------------------------------------------
-- external_identity — correlation between Helm nodes and external records.
-- -----------------------------------------------------------------------------
CREATE TABLE external_identity (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  connection_id  uuid NOT NULL,
  node_id        uuid NOT NULL,

  external_id    text NOT NULL,
  external_type  text NOT NULL,
  external_url   text,
  -- Hash of the last payload seen, so an unchanged record costs no writes.
  payload_sha256 bytea,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  is_authoritative boolean NOT NULL DEFAULT false,

  CONSTRAINT external_identity_connection_fk FOREIGN KEY (connection_id, tenant_id)
    REFERENCES integration_connection (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT external_identity_node_fk FOREIGN KEY (node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  -- One external record maps to exactly one node, and one node has at most one
  -- identity per external type within a connection. Both directions pinned.
  CONSTRAINT external_identity_external_uk UNIQUE (connection_id, external_type, external_id),
  CONSTRAINT external_identity_node_uk UNIQUE (connection_id, node_id, external_type),
  CONSTRAINT external_identity_sha_len CHECK (
    payload_sha256 IS NULL OR octet_length(payload_sha256) = 32
  )
);
CREATE INDEX external_identity_node_idx ON external_identity (node_id);

COMMENT ON COLUMN external_identity.is_authoritative IS
  'The external system owns this record; Helm edits to synced fields are '
  'overwritten on the next run and the UI says so rather than pretending the '
  'edit stuck.';

-- -----------------------------------------------------------------------------
-- webhook_endpoint / webhook_delivery — outbound events.
-- -----------------------------------------------------------------------------
CREATE TABLE webhook_endpoint (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  organization_id  uuid,

  name             text NOT NULL,
  url              text NOT NULL,
  -- HMAC signing key, stored as a secret so it rotates through the same path
  -- as everything else.
  signing_secret_id uuid NOT NULL,
  events           text[] NOT NULL DEFAULT '{}',
  is_active        boolean NOT NULL DEFAULT true,

  max_attempts     smallint NOT NULL DEFAULT 6,
  timeout_ms       integer NOT NULL DEFAULT 5000,
  custom_headers   jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT webhook_endpoint_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT webhook_endpoint_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT webhook_endpoint_secret_fk FOREIGN KEY (signing_secret_id, tenant_id)
    REFERENCES secret (id, tenant_id) ON DELETE RESTRICT,
  -- Plaintext webhooks would put event payloads on the wire in the clear.
  CONSTRAINT webhook_endpoint_https CHECK (url ~ '^https://'),
  CONSTRAINT webhook_endpoint_events_nonempty CHECK (cardinality(events) > 0),
  CONSTRAINT webhook_endpoint_headers_object CHECK (jsonb_typeof(custom_headers) = 'object'),
  CONSTRAINT webhook_endpoint_attempts_range CHECK (max_attempts BETWEEN 1 AND 20),
  CONSTRAINT webhook_endpoint_timeout_range CHECK (timeout_ms BETWEEN 500 AND 30000)
);

CREATE TABLE webhook_delivery (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  endpoint_id   uuid NOT NULL,

  event_type    text NOT NULL,
  event_uid     uuid NOT NULL,
  payload       jsonb NOT NULL,

  status        webhook_delivery_status NOT NULL DEFAULT 'pending',
  attempts      smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  response_code integer,
  response_body text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT webhook_delivery_endpoint_fk FOREIGN KEY (endpoint_id, tenant_id)
    REFERENCES webhook_endpoint (id, tenant_id) ON DELETE CASCADE,
  -- Same event to the same endpoint exactly once.
  CONSTRAINT webhook_delivery_uk UNIQUE (endpoint_id, event_uid),
  CONSTRAINT webhook_delivery_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT webhook_delivery_attempts_non_negative CHECK (attempts >= 0)
);
CREATE INDEX webhook_delivery_due_idx ON webhook_delivery (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX webhook_delivery_endpoint_idx ON webhook_delivery (endpoint_id, created_at DESC);

-- Webhook payloads describe events; they never carry secret material. The
-- application builds them from metadata only, and this trigger refuses the
-- obvious mistakes rather than trusting that it always will.
CREATE OR REPLACE FUNCTION helm.reject_secret_bearing_payload() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_forbidden text[] := ARRAY[
    'password', 'secret', 'ciphertext', 'private_key', 'totp_seed',
    'api_key', 'client_secret', 'refresh_token', 'plaintext'
  ];
  v_key text;
BEGIN
  FOREACH v_key IN ARRAY v_forbidden LOOP
    IF NEW.payload ? v_key THEN
      RAISE EXCEPTION 'helm: webhook payload must not contain a % field', v_key
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'Send a reference and let the receiver fetch through the audited API.';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_delivery_no_secrets
  BEFORE INSERT OR UPDATE OF payload ON webhook_delivery
  FOR EACH ROW EXECUTE FUNCTION helm.reject_secret_bearing_payload();

CREATE TRIGGER integration_connection_touch BEFORE UPDATE ON integration_connection
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();
CREATE TRIGGER webhook_endpoint_touch BEFORE UPDATE ON webhook_endpoint
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();
