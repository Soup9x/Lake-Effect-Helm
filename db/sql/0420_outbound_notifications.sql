-- =============================================================================
-- 0420_outbound_notifications.sql — telling somebody, outside Helm
--
-- 0400 removed two-person approval from credential exports and said, in as many
-- words, that detection replaces prevention. Detection that lives only in a log
-- nobody opens is not detection. This is the other half of that change: an
-- export shows up in a channel somebody reads, within a minute of happening.
--
-- THIS EXTENDS webhook_endpoint / webhook_delivery RATHER THAN ADDING A SECOND
-- WEBHOOK SYSTEM.
--
-- 0110 shipped both tables, with retry fields, a dedupe constraint and a
-- trigger that refuses secret-bearing payloads. Nothing was ever wired to them:
-- no route inserts a delivery and no worker drains one. They are scaffolding,
-- mirrored in Drizzle and otherwise dead.
--
-- The first attempt at this file created webhook_destination alongside them.
-- That would have left TWO webhook systems in the schema, one live and one
-- dead, which is exactly the "undocumented or stale" problem this project has
-- had to clean up twice. So the existing tables are brought up to the job
-- instead, and the parts of them that were wrong are corrected here rather than
-- worked around.
--
-- WHAT WAS WRONG WITH THEM
--
--   * `url` was PLAINTEXT, in a table any tenant-wide role of rank 60+ can
--     read. For Discord and Teams the URL *is* the credential: whoever holds it
--     can post to that channel as Helm. It is now enveloped, and helm_app
--     cannot read it back.
--
--   * `signing_secret_id` pointed into the credential vault. Elegant, and wrong
--     for this: reading it needs helm.reveal_secret(), which needs an actor and
--     writes an audit row — one per webhook delivery, in a product that is
--     about to deliver a webhook per audit row. The signing secret moves inside
--     the same envelope as the URL.
--
--   * One payload shape. The 0110 comment and the worker's notifier both claim
--     it covers "Slack, Teams and anything with an inbound URL". Slack and the
--     legacy Teams connector do accept a bare `text`. DISCORD DOES NOT — it
--     requires `content` or `embeds` and returns 400 otherwise. The Discord
--     case was never working.
--
--   * The no-secrets trigger checked TOP-LEVEL KEYS ONLY. `{"detail":
--     {"password": "..."}}` passed it. Strengthened below to recurse, because
--     this is the first time these payloads will actually leave the building.
--
-- EVENT NAMES ARE TEXT WITH A CHECK, NOT AN ENUM. Deliberate, and 0405 is why:
-- a new enum value cannot be used in the transaction that adds it, so every
-- future event type would need its own migration file. An allow-list function
-- in a CHECK is equally strict and adds a value in one place.
--
-- THE INVARIANT THAT MATTERS MOST HERE
--
-- A webhook payload leaves the building. helm.notification_payload() builds
-- every payload from an ALLOW-LIST of audit metadata keys: a key added to an
-- audit row later does not appear in a notification unless somebody adds it
-- here, deliberately. A denylist would have the opposite default, which is the
-- wrong one when the cost of being wrong is a password in a chat channel.
--
-- Notifications DO name clients, assets and credentials — "ACME Domain Admin
-- was revealed for export" is the whole point. The settings page says so
-- plainly, because the moment to decide whether a channel should carry that is
-- when choosing the channel.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- The payload shapes.
--
--   generic  Helm's own JSON, and the base the others are built from.
--   slack    { text, blocks } — also what most bespoke receivers accept.
--   discord  { content, embeds } — refuses a bare `text` with a 400.
--   teams    An Adaptive Card inside { type: 'message', attachments: [...] },
--            which is what Power Automate Workflows accepts. The older Office
--            365 connector MessageCard format is NOT emitted: those connectors
--            are retired, and defaulting to the dead format would send every
--            new deployment down a path Microsoft has closed.
-- -----------------------------------------------------------------------------
-- Guarded so the file can be re-applied against a database that already has
-- it. Same reasoning as 0400: a migration that cannot be re-run cannot be
-- TESTED against a database in the state it produces.
DO $fmt$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'webhook_format') THEN
    CREATE TYPE webhook_format AS ENUM ('generic', 'slack', 'discord', 'teams');
  END IF;
END
$fmt$;

-- -----------------------------------------------------------------------------
-- The subscribable event vocabulary.
--
-- Deliberately NOT one value per audit action. The audit vocabulary is an
-- internal record and it grows; this is a menu somebody reads in a settings
-- page, and forty checkboxes is a menu nobody configures. Each value maps to
-- one or more audit actions in helm.notification_event_for().
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.notification_events() RETURNS text[]
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT ARRAY[
    -- Exports. The reason this file exists.
    'export.requested',
    'export.rendered',
    'export.downloaded',
    'export.revoked',
    -- Credential access worth seeing as it happens.
    'secret.revealed',
    -- Anything refused: a reveal, a write, a download. Repeated refusals are
    -- the shape of both an attack and a broken permission grant, and telling
    -- those apart needs a person to look.
    'access.denied',
    -- The expiry alerts from 0100, routed through the same queue.
    'expiration.warning',
    -- Operational rather than security: a sync that keeps failing is
    -- documentation going quietly stale.
    'integration.failed',
    'key.rotated'
  ]::text[];
$$;

-- IMMUTABLE so a CHECK can use it. `<@` is the array containment operator and
-- is itself immutable; the whole expression depends only on its input.
CREATE OR REPLACE FUNCTION helm.notification_events_known(p_events text[])
  RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT p_events <@ helm.notification_events();
$$;

-- -----------------------------------------------------------------------------
-- webhook_endpoint, brought up to the job.
--
-- Safe to reshape destructively: nothing has ever written to this table. No
-- route inserts one, no worker reads one, and `url` is NOT NULL with no
-- default, so any deployment with rows would have had to put them there by
-- hand.
-- -----------------------------------------------------------------------------

-- The plaintext credential goes first, so nothing can be added later that still
-- reads it.
ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_endpoint_https;
ALTER TABLE webhook_endpoint DROP COLUMN IF EXISTS url;

-- The vault reference goes with it. Signing belongs inside the envelope now;
-- see the header for why routing it through reveal_secret() was wrong.
ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_endpoint_secret_fk;
ALTER TABLE webhook_endpoint DROP COLUMN IF EXISTS signing_secret_id;

ALTER TABLE webhook_endpoint
  ADD COLUMN IF NOT EXISTS format webhook_format NOT NULL DEFAULT 'generic',

  -- Display only, and plaintext on purpose. An administrator with three Discord
  -- webhooks has to tell them apart without seeing any of them; a host and a
  -- short digest do that. The digest covers the WHOLE url, so two hooks into
  -- different channels of one server are still distinguishable.
  ADD COLUMN IF NOT EXISTS url_host   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS url_digest text NOT NULL DEFAULT '',

  -- Whether a signing secret was supplied. The secret is inside the envelope;
  -- this is the flag the settings page renders.
  ADD COLUMN IF NOT EXISTS signing_secret_set boolean NOT NULL DEFAULT false,

  -- ONE envelope over a JSON document — {"url": "...", "signingSecret": "..."} —
  -- rather than two sets of envelope columns. The URL and the secret that signs
  -- requests to it are useless apart and are rewritten together, so sealing
  -- them together keeps the crypto surface to one seal and one open.
  ADD COLUMN IF NOT EXISTS wrap_provider     text,
  ADD COLUMN IF NOT EXISTS kek_id            text,
  ADD COLUMN IF NOT EXISTS wrapped_dek       bytea,
  ADD COLUMN IF NOT EXISTS secret_ciphertext bytea,
  ADD COLUMN IF NOT EXISTS secret_nonce      bytea,
  ADD COLUMN IF NOT EXISTS secret_tag        bytea,
  ADD COLUMN IF NOT EXISTS secret_aad        text,

  -- What happened last time. Stored so the settings page can answer "is this
  -- working" without sending anything.
  ADD COLUMN IF NOT EXISTS last_delivery_at     timestamptz,
  ADD COLUMN IF NOT EXISTS last_delivery_ok     boolean,
  ADD COLUMN IF NOT EXISTS last_delivery_error  text,
  -- Consecutive failures. A destination failing for a day is a different
  -- problem from one that failed once, and the page should say which.
  ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0,

  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES app_user(id) ON DELETE SET NULL;

-- The defaults existed only so the ADD COLUMN could be NOT NULL on a table that
-- might have rows. Dropped immediately: an endpoint with an empty host is not a
-- thing that should be insertable.
ALTER TABLE webhook_endpoint
  ALTER COLUMN url_host DROP DEFAULT,
  ALTER COLUMN url_digest DROP DEFAULT;

ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_host_present;
ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_digest_shape;
ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_nonce_len;
ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_tag_len;
ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_secret_present;
ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_failures_nonneg;
ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_envelope_complete;
ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_events_known;
ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_endpoint_name_unique;
ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_endpoint_name_present;

ALTER TABLE webhook_endpoint
  ADD CONSTRAINT webhook_host_present CHECK (length(btrim(url_host)) BETWEEN 1 AND 253),
  ADD CONSTRAINT webhook_digest_shape CHECK (url_digest ~ '^[0-9a-f]{12}$'),
  ADD CONSTRAINT webhook_nonce_len CHECK (octet_length(secret_nonce) = 12),
  ADD CONSTRAINT webhook_tag_len CHECK (octet_length(secret_tag) = 16),
  ADD CONSTRAINT webhook_secret_present CHECK (octet_length(secret_ciphertext) > 0),
  ADD CONSTRAINT webhook_failures_nonneg CHECK (consecutive_failures >= 0),
  -- The envelope is all-or-nothing. A half-written row is an endpoint that
  -- cannot be opened and cannot be seen to be broken.
  ADD CONSTRAINT webhook_envelope_complete CHECK (
    (wrap_provider IS NOT NULL AND kek_id IS NOT NULL AND wrapped_dek IS NOT NULL
     AND secret_ciphertext IS NOT NULL AND secret_nonce IS NOT NULL
     AND secret_tag IS NOT NULL AND secret_aad IS NOT NULL)
  ),
  -- Every subscribed event must be one Helm knows how to raise. A typo here is
  -- otherwise a channel that is simply never written to, with nothing to see.
  ADD CONSTRAINT webhook_events_known CHECK (helm.notification_events_known(events)),
  -- Two endpoints with the same name in one tenant is a configuration mistake
  -- that presents as "why did only one of them get it".
  ADD CONSTRAINT webhook_endpoint_name_unique UNIQUE (tenant_id, name),
  ADD CONSTRAINT webhook_endpoint_name_present CHECK (length(btrim(name)) BETWEEN 1 AND 80);

COMMENT ON TABLE webhook_endpoint IS
  'Outbound notification destinations. The URL is enveloped and readable only '
  'by helm_worker: for Discord and Teams the URL IS the credential.';

COMMENT ON COLUMN webhook_endpoint.url_digest IS
  'First 12 hex of sha256 over the full URL. Lets an administrator tell two '
  'webhooks apart without either being shown.';

-- -----------------------------------------------------------------------------
-- webhook_delivery gains what a readable notification needs.
--
-- The 0110 shape carried event_type, event_uid and a payload. A human-facing
-- notification also needs a one-line summary and the client it concerns, and
-- both belong in SQL so every format renders the same words.
-- -----------------------------------------------------------------------------
ALTER TABLE webhook_delivery
  ADD COLUMN IF NOT EXISTS subject         text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS occurred_at     timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS delivered_at    timestamptz;

ALTER TABLE webhook_delivery ALTER COLUMN subject DROP DEFAULT;

ALTER TABLE webhook_delivery DROP CONSTRAINT IF EXISTS webhook_delivery_subject_present;
ALTER TABLE webhook_delivery DROP CONSTRAINT IF EXISTS webhook_delivery_event_known;

ALTER TABLE webhook_delivery
  ADD CONSTRAINT webhook_delivery_subject_present CHECK (length(btrim(subject)) > 0),
  ADD CONSTRAINT webhook_delivery_event_known CHECK (
    helm.notification_events_known(ARRAY[event_type])
  );

-- -----------------------------------------------------------------------------
-- The no-secrets trigger, strengthened to recurse.
--
-- 0110's version tested `NEW.payload ? key`, which is TOP-LEVEL ONLY. A payload
-- of {"detail": {"password": "..."}} passed it. That was survivable while
-- nothing wrote to this table; it is not survivable now that these rows are
-- POSTed to a chat platform.
--
-- Rebuilt as a recursive walk over every key at every depth. The forbidden list
-- is the 0110 one plus the fields this schema has grown since.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.reject_secret_bearing_payload() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_forbidden text[] := ARRAY[
    'password', 'secret', 'ciphertext', 'private_key', 'totp_seed',
    'api_key', 'client_secret', 'refresh_token', 'plaintext',
    -- Added in 0420. Each of these is a real column name in this schema, and a
    -- payload builder that reached for one by mistake would name it this way.
    'password_phc', 'previous_phc', 'wrapped_dek', 'shared_secret',
    'secret_ciphertext', 'auth_tag', 'nonce', 'session_token', 'token_hash'
  ];
  v_found text;
BEGIN
  -- Every key at every depth.
  --
  -- `$.**` descends through objects and arrays alike; the type filter keeps
  -- only the objects, so jsonb_object_keys() always has something to work on.
  -- The filter is not optional: `$.**.keyvalue()` without it RAISES on the
  -- first scalar it meets ("keyvalue() can only be applied to an object"),
  -- which is how the first version of this function came to accept every
  -- payload put to it — including a top-level "password", which 0110's much
  -- simpler check had caught.
  SELECT k INTO v_found
  FROM jsonb_path_query(NEW.payload, '$.** ? (@.type() == "object")') AS obj,
       LATERAL jsonb_object_keys(obj) AS k
  WHERE lower(k) = ANY (v_forbidden)
  LIMIT 1;

  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'helm: webhook payload must not contain a % field', v_found
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Send a reference and let the receiver fetch through the audited API.';
  END IF;

  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- notification_cursor — how far the audit fan-out has read.
--
-- chain_seq rather than a timestamp. The audit chain is contiguous from 1 per
-- tenant (§8 of the security suite asserts it), so a sequence number cannot
-- skip a row the way "everything since t" can when two transactions commit out
-- of order.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_cursor (
  tenant_id      uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  last_chain_seq bigint NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_cursor_seq_nonneg CHECK (last_chain_seq >= 0)
);

-- =============================================================================
-- Turning audit rows into notifications
-- =============================================================================

-- -----------------------------------------------------------------------------
-- helm.notification_event_for — which subscribable event an audit row is, if any.
--
-- Most audit actions are not notifications. Returning NULL for them is the
-- common case and is what keeps the fan-out cheap: a tenant doing ordinary work
-- produces hundreds of audit rows an hour and none of them queue anything.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.notification_event_for(p_action text, p_outcome audit_outcome)
  RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_action = 'export.requested'  AND p_outcome = 'success' THEN 'export.requested'
    WHEN p_action = 'export.rendered'   AND p_outcome = 'success' THEN 'export.rendered'
    WHEN p_action = 'export.downloaded' AND p_outcome = 'success' THEN 'export.downloaded'
    WHEN p_action = 'export.revoked'    AND p_outcome = 'success' THEN 'export.revoked'
    WHEN p_action = 'secret.revealed'   AND p_outcome = 'success' THEN 'secret.revealed'
    -- Every refusal, from any surface, under one subscription. Somebody
    -- watching for an attack does not want to pick three checkboxes and miss
    -- the fourth kind of denial added later.
    WHEN p_action IN ('secret.reveal_denied', 'secret.write_denied', 'export.download_denied')
      THEN 'access.denied'
    WHEN p_action = 'integration.sync_finished' AND p_outcome <> 'success' THEN 'integration.failed'
    WHEN p_action IN ('key.rotation_started', 'key.kek_rewrapped', 'key.retired')
      THEN 'key.rotated'
    ELSE NULL
  END;
$$;

-- -----------------------------------------------------------------------------
-- helm.notification_payload — the ALLOW-LIST.
--
-- THE LOAD-BEARING FUNCTION OF THIS FILE. Everything a webhook carries beyond
-- the subject line comes from here, and what comes from here is named, one key
-- at a time. An audit action that grows a new metadata field does NOT start
-- appearing in notifications; somebody has to come here and add it.
--
-- A denylist would default the other way: new field ships, notification carries
-- it, and the first anybody knows is when it is in a chat channel. The
-- reject_secret_bearing_payload trigger IS a denylist and stays as the belt to
-- this file's braces, but it is the second line, not the first.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.notification_payload(p_event text, p_metadata jsonb)
  RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT coalesce(
    jsonb_object_agg(k, p_metadata -> k) FILTER (WHERE p_metadata ? k),
    '{}'::jsonb)
  FROM unnest(
    CASE p_event
      WHEN 'export.requested' THEN
        ARRAY['kind', 'format', 'include_secrets', 'expires_in_hours']
      WHEN 'export.rendered' THEN
        ARRAY['record_count', 'secret_count', 'byte_size', 'omissions', 'encryption_method']
      WHEN 'export.downloaded' THEN
        ARRAY['download_number', 'byte_size']
      WHEN 'export.revoked' THEN
        ARRAY['previous_status', 'downloads']
      -- `label` is a credential's NAME, not its contents: "ACME Domain Admin".
      -- It is already in search_document, and without it the notification says
      -- only that something was revealed, which nobody can act on.
      WHEN 'secret.revealed' THEN
        ARRAY['purpose', 'sensitivity', 'label', 'version', 'step_up']
      WHEN 'access.denied' THEN
        ARRAY['cause', 'purpose', 'sensitivity', 'required_rank', 'actor_rank']
      WHEN 'integration.failed' THEN
        ARRAY['provider', 'error', 'consecutive_failures']
      WHEN 'key.rotated' THEN
        ARRAY['generation', 'data_key_id', 'wrap_provider']
      WHEN 'expiration.warning' THEN
        ARRAY['kind', 'label', 'days_remaining', 'severity', 'expires_at']
      ELSE ARRAY[]::text[]
    END
  ) AS k;
$$;

-- -----------------------------------------------------------------------------
-- helm.notification_subject — the one line a human reads.
--
-- Built in SQL rather than per-format in TypeScript, so a Discord embed, a
-- Teams card and a generic POST all say the same words about the same event.
-- Formatting differs between platforms; facts should not.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.notification_subject(
  p_event   text,
  p_actor   text,
  p_org     text,
  p_payload jsonb
) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT CASE p_event
    WHEN 'export.requested' THEN
      format('%s requested a%s export for %s',
             p_actor,
             CASE WHEN p_payload ->> 'include_secrets' = 'true'
                  THEN ' CREDENTIAL-BEARING' ELSE 'n' END,
             coalesce(p_org, 'the tenant'))
    WHEN 'export.rendered' THEN
      format('An export for %s finished: %s records, %s credentials',
             coalesce(p_org, 'the tenant'),
             coalesce(p_payload ->> 'record_count', '0'),
             coalesce(p_payload ->> 'secret_count', '0'))
    WHEN 'export.downloaded' THEN
      format('%s downloaded an export for %s (download #%s)',
             p_actor, coalesce(p_org, 'the tenant'),
             coalesce(p_payload ->> 'download_number', '1'))
    WHEN 'export.revoked' THEN
      format('%s revoked an export for %s', p_actor, coalesce(p_org, 'the tenant'))
    WHEN 'secret.revealed' THEN
      format('%s revealed %s (%s) for %s',
             p_actor,
             coalesce(p_payload ->> 'label', 'a credential'),
             coalesce(p_payload ->> 'sensitivity', 'standard'),
             coalesce(p_payload ->> 'purpose', 'view'))
    WHEN 'access.denied' THEN
      format('%s was refused: %s',
             p_actor, coalesce(p_payload ->> 'cause', 'not permitted'))
    WHEN 'integration.failed' THEN
      format('The %s sync for %s is failing',
             coalesce(p_payload ->> 'provider', 'integration'),
             coalesce(p_org, 'the tenant'))
    WHEN 'key.rotated' THEN
      format('%s moved a tenant encryption key', p_actor)
    WHEN 'expiration.warning' THEN
      format('%s: %s %s',
             coalesce(p_org, 'the tenant'),
             coalesce(p_payload ->> 'label', 'an item'),
             CASE
               WHEN (p_payload ->> 'days_remaining')::int < 0
                 THEN format('expired %s day(s) ago', abs((p_payload ->> 'days_remaining')::int))
               WHEN (p_payload ->> 'days_remaining')::int = 0 THEN 'expires today'
               ELSE format('expires in %s day(s)', p_payload ->> 'days_remaining')
             END)
    ELSE format('%s: %s', p_event, p_actor)
  END;
$$;

-- -----------------------------------------------------------------------------
-- helm.fan_out_notifications — read new audit rows, queue what is subscribed.
--
-- Runs as the worker, inside a tenant context. Reads forward from the tenant's
-- cursor, maps each row to an event, and inserts one delivery per subscribed
-- endpoint.
--
-- SAFE TO RE-RUN AND SAFE TO RACE. The unique constraint on
-- (endpoint_id, event_uid) means a cursor that rewinds, a crash between the
-- insert and the cursor update, or two workers overlapping all produce the same
-- row rather than a second message. ON CONFLICT DO NOTHING makes that ordinary
-- rather than an error.
--
-- The cursor advances to the highest chain_seq READ, not the highest queued, so
-- a batch of a hundred uninteresting audit rows is not re-examined every run.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.fan_out_notifications(p_limit integer DEFAULT 500)
  RETURNS TABLE (examined integer, queued integer, cursor_at bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant   uuid := helm.require_tenant_id();
  v_from     bigint;
  v_high     bigint;
  v_examined integer := 0;
  v_queued   integer := 0;
BEGIN
  INSERT INTO notification_cursor (tenant_id, last_chain_seq)
  VALUES (v_tenant, 0)
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT last_chain_seq INTO v_from
  FROM notification_cursor WHERE tenant_id = v_tenant
  FOR UPDATE;

  WITH candidate AS (
    SELECT a.event_uid, a.chain_seq, a.action, a.outcome, a.actor_label,
           a.organization_id, a.occurred_at, a.metadata,
           helm.notification_event_for(a.action, a.outcome) AS event
    FROM audit_log a
    WHERE a.tenant_id = v_tenant
      AND a.chain_seq > v_from
    ORDER BY a.chain_seq
    LIMIT greatest(p_limit, 1)
  ),
  counted AS (
    SELECT count(*)::integer AS n, max(chain_seq) AS high FROM candidate
  ),
  queued AS (
    INSERT INTO webhook_delivery (
      tenant_id, endpoint_id, event_type, event_uid,
      organization_id, subject, payload, occurred_at)
    SELECT
      v_tenant, e.id, c.event, c.event_uid,
      c.organization_id,
      helm.notification_subject(
        c.event, c.actor_label, o.name,
        helm.notification_payload(c.event, c.metadata)),
      helm.notification_payload(c.event, c.metadata),
      c.occurred_at
    FROM candidate c
    JOIN webhook_endpoint e
      ON e.tenant_id = v_tenant
     AND e.is_active
     AND c.event = ANY (e.events)
     -- An endpoint scoped to one client hears only about that client. A
     -- tenant-wide endpoint (organization_id IS NULL) hears everything.
     AND (e.organization_id IS NULL OR e.organization_id = c.organization_id)
    LEFT JOIN organization o
      ON o.id = c.organization_id AND o.tenant_id = v_tenant
    WHERE c.event IS NOT NULL
    ON CONFLICT (endpoint_id, event_uid) DO NOTHING
    RETURNING 1
  )
  SELECT counted.n, counted.high, (SELECT count(*)::integer FROM queued)
    INTO v_examined, v_high, v_queued
  FROM counted;

  IF v_high IS NOT NULL THEN
    UPDATE notification_cursor
    SET last_chain_seq = v_high, updated_at = now()
    WHERE tenant_id = v_tenant;
  END IF;

  RETURN QUERY SELECT coalesce(v_examined, 0), coalesce(v_queued, 0),
                      coalesce(v_high, v_from);
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.enqueue_notification — the other source.
--
-- Expiry warnings do not pass through the audit log: they come from the
-- projection in 0100, via alert_event, which already has the lead-day
-- idempotency that stops a nightly job re-alerting. This is how that path, and
-- the settings page's Send a test, put something on the same queue.
--
-- p_source_uid is what makes it idempotent — an alert_event id, or a fresh uuid
-- for a test send.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.enqueue_notification(
  p_event           text,
  p_source_uid      uuid,
  p_organization_id uuid,
  p_payload         jsonb DEFAULT '{}'::jsonb,
  p_endpoint_id     uuid DEFAULT NULL
) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_payload jsonb := helm.notification_payload(p_event, coalesce(p_payload, '{}'::jsonb));
  v_org     text;
  -- The same setting helm.audit() reads for actor_label. There is no
  -- current_actor_label() helper; reaching for one that felt like it should
  -- exist is how this first shipped a body that only fails at call time,
  -- because plpgsql does not resolve function names until then.
  v_actor   text := coalesce(nullif(current_setting('helm.actor_label', true), ''), 'Helm');
  v_rows    integer;
BEGIN
  IF NOT helm.notification_events_known(ARRAY[p_event]) THEN
    RAISE EXCEPTION 'helm: % is not a notification event', p_event
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT o.name INTO v_org
  FROM organization o WHERE o.id = p_organization_id AND o.tenant_id = v_tenant;

  INSERT INTO webhook_delivery (
    tenant_id, endpoint_id, event_type, event_uid,
    organization_id, subject, payload)
  SELECT v_tenant, e.id, p_event, p_source_uid, p_organization_id,
         helm.notification_subject(p_event, v_actor, v_org, v_payload),
         v_payload
  FROM webhook_endpoint e
  WHERE e.tenant_id = v_tenant
    AND (p_endpoint_id IS NULL OR e.id = p_endpoint_id)
    -- A test send goes to the endpoint named even when it is switched off and
    -- even when it is not subscribed: that is what makes it a test.
    AND (p_endpoint_id IS NOT NULL OR (e.is_active AND p_event = ANY (e.events)))
    AND (e.organization_id IS NULL OR e.organization_id = p_organization_id)
  ON CONFLICT (endpoint_id, event_uid) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

-- =============================================================================
-- Delivery: what the worker claims, and what it reports back
-- =============================================================================

-- -----------------------------------------------------------------------------
-- helm.notification_backlog — which tenants have anything due.
--
-- Mirrors helm.alert_backlog(): the worker holds no tenant context of its own,
-- so it asks which tenants to iterate and then enters each one. Only tenants
-- with a due delivery are returned, so an idle deployment does no work.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.notification_backlog(p_limit integer DEFAULT 50)
  RETURNS TABLE (tenant_id uuid, tenant_name text, worker_actor_id uuid, due bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT t.id, t.name, helm.worker_actor(t.id, 'system_alerts'), count(d.id)
  FROM tenant t
  JOIN webhook_delivery d
    ON d.tenant_id = t.id AND d.status = 'pending' AND d.next_attempt_at <= now()
  WHERE t.status = 'active'
    AND helm.worker_actor(t.id, 'system_alerts') IS NOT NULL
  GROUP BY t.id, t.name
  ORDER BY count(d.id) DESC
  LIMIT greatest(p_limit, 1);
$$;

-- -----------------------------------------------------------------------------
-- helm.claim_notifications — the due deliveries, WITH the envelope.
--
-- Returns the sealed URL because the worker is the only thing that can open it
-- and the only thing that needs to. The plaintext URL exists for the duration
-- of one fetch, in the worker process, and is never written anywhere.
--
-- Marks nothing: a claim that flipped status here would lose the delivery if
-- the worker died mid-batch. Status moves only in record_notification_delivery,
-- after the attempt, one row at a time.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.claim_notifications(p_limit integer DEFAULT 50)
  RETURNS TABLE (
    delivery_id uuid, endpoint_id uuid, endpoint_name text, format webhook_format,
    event_type text, subject text, payload jsonb, occurred_at timestamptz,
    organization_name text, attempts smallint, max_attempts smallint,
    timeout_ms integer, custom_headers jsonb,
    wrap_provider text, kek_id text, wrapped_dek bytea,
    secret_ciphertext bytea, secret_nonce bytea, secret_tag bytea, secret_aad text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT d.id, e.id, e.name, e.format,
         d.event_type, d.subject, d.payload, d.occurred_at,
         o.name, d.attempts, e.max_attempts, e.timeout_ms, e.custom_headers,
         e.wrap_provider, e.kek_id, e.wrapped_dek,
         e.secret_ciphertext, e.secret_nonce, e.secret_tag, e.secret_aad
  FROM webhook_delivery d
  JOIN webhook_endpoint e ON e.id = d.endpoint_id AND e.tenant_id = d.tenant_id
  LEFT JOIN organization o ON o.id = d.organization_id AND o.tenant_id = d.tenant_id
  WHERE d.tenant_id = helm.require_tenant_id()
    AND d.status = 'pending'
    AND d.next_attempt_at <= now()
  ORDER BY d.occurred_at
  LIMIT greatest(p_limit, 1);
$$;

-- -----------------------------------------------------------------------------
-- helm.record_notification_delivery — what happened, and when to try again.
--
-- Backoff is computed here rather than in the worker so that two workers, or a
-- worker restarted mid-batch, cannot disagree about when a delivery is next
-- due. Exponential from one minute, capped at an hour: a chat platform that is
-- down comes back within that, and a misconfigured URL should not be retried
-- every minute for a week.
--
-- 'dead' rather than 'failed' when the attempts run out, because those are
-- different things to look at: failed means it will try again, dead means a
-- human has to.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_notification_delivery(
  p_delivery_id   uuid,
  p_ok            boolean,
  p_response_code integer DEFAULT NULL,
  p_error         text DEFAULT NULL
) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant   uuid := helm.require_tenant_id();
  v_row      webhook_delivery%ROWTYPE;
  v_max      smallint;
  v_attempts smallint;
  v_status   webhook_delivery_status;
  v_backoff  interval;
BEGIN
  SELECT * INTO v_row FROM webhook_delivery
  WHERE id = p_delivery_id AND tenant_id = v_tenant FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: no such delivery' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT e.max_attempts INTO v_max FROM webhook_endpoint e WHERE e.id = v_row.endpoint_id;
  v_attempts := least(v_row.attempts + 1, 20);

  IF p_ok THEN
    v_status := 'delivered';
  ELSIF v_attempts >= coalesce(v_max, 6) THEN
    v_status := 'dead';
  ELSE
    v_status := 'pending';
  END IF;

  -- 1, 2, 4, 8, 16, 32 minutes, then held at 60.
  v_backoff := least(make_interval(mins => (2 ^ greatest(v_attempts - 1, 0))::integer), interval '60 minutes');

  UPDATE webhook_delivery SET
    status = v_status,
    attempts = v_attempts,
    last_attempt_at = now(),
    response_code = p_response_code,
    error = left(p_error, 500),
    delivered_at = CASE WHEN p_ok THEN now() ELSE delivered_at END,
    next_attempt_at = CASE WHEN v_status = 'pending' THEN now() + v_backoff ELSE next_attempt_at END
  WHERE id = p_delivery_id;

  -- The endpoint carries the summary the settings page shows, so an operator
  -- does not have to read the queue to find out a channel has been failing.
  UPDATE webhook_endpoint SET
    last_delivery_at = now(),
    last_delivery_ok = p_ok,
    last_delivery_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
    consecutive_failures = CASE WHEN p_ok THEN 0 ELSE consecutive_failures + 1 END
  WHERE id = v_row.endpoint_id;

  RETURN v_status::text;
END;
$$;

-- =============================================================================
-- The administrative surface
--
-- Same shape as RADIUS (0360) and OIDC (0410): helm_app writes the sealed URL
-- through a SECURITY DEFINER function and reads everything EXCEPT the envelope
-- back. What is different is which role may read the secret — helm_worker here,
-- because delivery is a background job rather than a pre-authentication step.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- helm.webhook_endpoints — what helm_app is allowed to know.
--
-- The envelope columns are not in the result type at all; not filtered out
-- downstream, absent. What an administrator gets instead is the host, a short
-- digest, and whether a signing secret exists — enough to tell three Discord
-- webhooks apart without being shown any of them.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.webhook_endpoints()
  RETURNS TABLE (
    id uuid, name text, format webhook_format, is_active boolean,
    organization_id uuid, organization_name text, events text[],
    url_host text, url_digest text, signing_secret_set boolean,
    max_attempts smallint, timeout_ms integer,
    last_delivery_at timestamptz, last_delivery_ok boolean,
    last_delivery_error text, consecutive_failures integer,
    pending_count bigint, dead_count bigint, updated_at timestamptz
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.is_tenant_wide() THEN
    RAISE EXCEPTION 'helm: notification settings are not visible to a client-side role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT e.id, e.name, e.format, e.is_active,
           e.organization_id, o.name, e.events,
           e.url_host, e.url_digest, e.signing_secret_set,
           e.max_attempts, e.timeout_ms,
           e.last_delivery_at, e.last_delivery_ok,
           e.last_delivery_error, e.consecutive_failures,
           count(d.id) FILTER (WHERE d.status = 'pending'),
           count(d.id) FILTER (WHERE d.status = 'dead'),
           e.updated_at
    FROM webhook_endpoint e
    LEFT JOIN organization o ON o.id = e.organization_id AND o.tenant_id = v_tenant
    LEFT JOIN webhook_delivery d
      ON d.endpoint_id = e.id AND d.created_at > now() - interval '7 days'
    WHERE e.tenant_id = v_tenant
    GROUP BY e.id, o.name
    ORDER BY e.name;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.set_webhook_endpoint — create or replace one, envelope and all.
--
-- The caller encrypts. It has the KEK provider; the database has never had it.
-- What arrives here is ciphertext, a host and a digest.
--
-- Returns the id so a create can be followed by a test send without a second
-- round trip to find out what was just made.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_webhook_endpoint(
  p_id              uuid,
  p_name            text,
  p_format          webhook_format,
  p_is_active       boolean,
  p_organization_id uuid,
  p_events          text[],
  p_url_host        text,
  p_url_digest      text,
  p_signing_secret_set boolean,
  p_max_attempts    smallint,
  p_timeout_ms      integer,
  p_wrap_provider   text,
  p_kek_id          text,
  p_wrapped_dek     bytea,
  p_ciphertext      bytea,
  p_nonce           bytea,
  p_tag             bytea,
  p_aad             text
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
  v_id     uuid := coalesce(p_id, gen_random_uuid());
BEGIN
  IF NOT helm.has_permission('integration:manage') THEN
    RAISE EXCEPTION 'helm: configuring notifications requires integration:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_organization_id IS NOT NULL AND NOT helm.org_in_scope(p_organization_id) THEN
    RAISE EXCEPTION 'helm: organisation % is not in scope', p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO webhook_endpoint (
    id, tenant_id, name, format, is_active, organization_id, events,
    url_host, url_digest, signing_secret_set, max_attempts, timeout_ms,
    wrap_provider, kek_id, wrapped_dek,
    secret_ciphertext, secret_nonce, secret_tag, secret_aad,
    created_by, updated_by)
  VALUES (
    v_id, v_tenant, btrim(p_name), p_format, p_is_active, p_organization_id, p_events,
    btrim(p_url_host), p_url_digest, p_signing_secret_set, p_max_attempts, p_timeout_ms,
    p_wrap_provider, p_kek_id, p_wrapped_dek,
    p_ciphertext, p_nonce, p_tag, p_aad, v_actor, v_actor)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    format = EXCLUDED.format,
    is_active = EXCLUDED.is_active,
    organization_id = EXCLUDED.organization_id,
    events = EXCLUDED.events,
    url_host = EXCLUDED.url_host,
    url_digest = EXCLUDED.url_digest,
    signing_secret_set = EXCLUDED.signing_secret_set,
    max_attempts = EXCLUDED.max_attempts,
    timeout_ms = EXCLUDED.timeout_ms,
    wrap_provider = EXCLUDED.wrap_provider,
    kek_id = EXCLUDED.kek_id,
    wrapped_dek = EXCLUDED.wrapped_dek,
    secret_ciphertext = EXCLUDED.secret_ciphertext,
    secret_nonce = EXCLUDED.secret_nonce,
    secret_tag = EXCLUDED.secret_tag,
    secret_aad = EXCLUDED.secret_aad,
    -- A URL change invalidates what the last delivery proved about the old one.
    last_delivery_at = NULL,
    last_delivery_ok = NULL,
    last_delivery_error = NULL,
    consecutive_failures = 0,
    updated_by = v_actor
  WHERE webhook_endpoint.tenant_id = v_tenant;

  RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.update_webhook_endpoint — everything but the URL.
--
-- Exists so that adding an event type does not require re-pasting the webhook
-- URL, which is the friction that ends with the URL in a shared note.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.update_webhook_endpoint(
  p_id              uuid,
  p_name            text,
  p_format          webhook_format,
  p_is_active       boolean,
  p_organization_id uuid,
  p_events          text[],
  p_max_attempts    smallint,
  p_timeout_ms      integer
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
  v_rows   integer;
BEGIN
  IF NOT helm.has_permission('integration:manage') THEN
    RAISE EXCEPTION 'helm: configuring notifications requires integration:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_organization_id IS NOT NULL AND NOT helm.org_in_scope(p_organization_id) THEN
    RAISE EXCEPTION 'helm: organisation % is not in scope', p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE webhook_endpoint SET
    name = btrim(p_name),
    format = p_format,
    is_active = p_is_active,
    organization_id = p_organization_id,
    events = p_events,
    max_attempts = p_max_attempts,
    timeout_ms = p_timeout_ms,
    updated_by = v_actor
  WHERE id = p_id AND tenant_id = v_tenant;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.forget_webhook_endpoint — remove it, and its URL with it.
--
-- Deletes rather than clearing is_active, so a decommissioned channel does not
-- leave a live webhook URL in the database indefinitely. Same reasoning as
-- forget_radius_config() and forget_oidc_provider().
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.forget_webhook_endpoint(p_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_rows   integer;
BEGIN
  IF NOT helm.has_permission('integration:manage') THEN
    RAISE EXCEPTION 'helm: configuring notifications requires integration:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM webhook_endpoint WHERE id = p_id AND tenant_id = v_tenant;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.send_test_notification — put one synthetic message on the queue.
--
-- Goes through the SAME path as a real notification rather than sending
-- directly from the request. That is the point: a test that took a different
-- route would prove the URL reachable and nothing else, and the thing most
-- likely to be broken is the part in between.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.send_test_notification(p_id uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  text := coalesce(nullif(current_setting('helm.actor_label', true), ''), 'Helm');
  v_uid    uuid := gen_random_uuid();
  v_rows   integer;
BEGIN
  IF NOT helm.has_permission('integration:manage') THEN
    RAISE EXCEPTION 'helm: sending a test notification requires integration:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO webhook_delivery (
    tenant_id, endpoint_id, event_type, event_uid, subject, payload)
  SELECT v_tenant, e.id, 'export.requested', v_uid,
         format('Test from Lake Effect Helm, sent by %s. If you can read this, ' ||
                'notifications reach this channel.', v_actor),
         jsonb_build_object('kind', 'test', 'format', 'none', 'include_secrets', false)
  FROM webhook_endpoint e
  WHERE e.id = p_id AND e.tenant_id = v_tenant;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'helm: no such notification destination' USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_uid;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.recent_notifications — the delivery log, for the settings page.
--
-- No envelope, no URL. Subjects and outcomes only: enough to answer "did the
-- export alert go out" without going near the credential.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.recent_notifications(p_limit integer DEFAULT 20)
  RETURNS TABLE (
    id uuid, endpoint_name text, event_type text, subject text,
    status webhook_delivery_status, attempts smallint, response_code integer,
    error text, created_at timestamptz, delivered_at timestamptz
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.is_tenant_wide() THEN
    RAISE EXCEPTION 'helm: notification history is not visible to a client-side role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT d.id, e.name, d.event_type, d.subject, d.status, d.attempts,
           d.response_code, d.error, d.created_at, d.delivered_at
    FROM webhook_delivery d
    JOIN webhook_endpoint e ON e.id = d.endpoint_id
    WHERE d.tenant_id = v_tenant
    ORDER BY d.created_at DESC
    LIMIT least(greatest(p_limit, 1), 200);
END;
$$;

-- =============================================================================
-- Grants
--
-- The shape here is the same one RADIUS and OIDC use — write without read — but
-- the reading role is different. helm_worker, not helm_auth: delivering a
-- notification is a background job, not a pre-authentication step.
--
-- helm_worker is a MEMBER of helm_app. Membership runs ONE WAY: helm_worker
-- inherits helm_app's privileges, not the reverse. So a grant to helm_worker
-- does not reach the request path — and the corresponding trap, that a REVOKE
-- naming helm_worker is a no-op against a privilege it inherits, is why the
-- guards below test helm_app's own grants rather than helm_worker's.
-- =============================================================================

-- 0110 granted this table to helm_app through the default privileges in 0220.
-- Now that it holds a credential, that has to go.
REVOKE ALL ON webhook_endpoint FROM PUBLIC, helm_app, helm_auditor, helm_key_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoint TO helm_worker;

-- webhook_delivery carries no credential — subjects and allow-listed payloads —
-- so the request path may read it for the settings page. It may not write one:
-- queueing goes through enqueue_notification and the fan-out, which is where
-- the allow-list is applied.
REVOKE ALL ON webhook_delivery FROM PUBLIC, helm_app, helm_auditor, helm_key_admin;
GRANT SELECT ON webhook_delivery TO helm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_delivery TO helm_worker;

REVOKE ALL ON notification_cursor FROM PUBLIC, helm_app, helm_auditor, helm_key_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_cursor TO helm_worker;

REVOKE ALL ON FUNCTION helm.notification_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.notification_events_known(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.notification_event_for(text, audit_outcome) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.notification_payload(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.notification_subject(text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.fan_out_notifications(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.enqueue_notification(text, uuid, uuid, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.notification_backlog(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.claim_notifications(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_notification_delivery(uuid, boolean, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.webhook_endpoints() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_webhook_endpoint(
  uuid, text, webhook_format, boolean, uuid, text[], text, text, boolean,
  smallint, integer, text, text, bytea, bytea, bytea, bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.update_webhook_endpoint(
  uuid, text, webhook_format, boolean, uuid, text[], smallint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.forget_webhook_endpoint(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.send_test_notification(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.recent_notifications(integer) FROM PUBLIC;

-- The vocabulary is needed by a CHECK constraint, so every role that can write
-- either table must be able to execute it.
GRANT EXECUTE ON FUNCTION helm.notification_events() TO helm_app, helm_worker;
GRANT EXECUTE ON FUNCTION helm.notification_events_known(text[]) TO helm_app, helm_worker;

-- The classifier takes an action name and returns an event name. Nothing
-- sensitive passes through it, and helm_app needs it to explain in a settings
-- page which audit actions a subscription covers — so it is granted to both
-- rather than withheld on the general principle that the worker owns the queue.
GRANT EXECUTE ON FUNCTION helm.notification_event_for(text, audit_outcome)
  TO helm_worker, helm_app;

-- Reading the sealed URL and draining the queue belong to the worker.
GRANT EXECUTE ON FUNCTION helm.notification_payload(text, jsonb) TO helm_worker, helm_app;
GRANT EXECUTE ON FUNCTION helm.notification_subject(text, text, text, jsonb) TO helm_worker, helm_app;
GRANT EXECUTE ON FUNCTION helm.fan_out_notifications(integer) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.enqueue_notification(text, uuid, uuid, jsonb, uuid) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.notification_backlog(integer) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.claim_notifications(integer) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.record_notification_delivery(uuid, boolean, integer, text) TO helm_worker;

-- Configuring one is an administrative act inside a tenant context, so it
-- belongs to the application role — which still cannot read back what it wrote.
GRANT EXECUTE ON FUNCTION helm.webhook_endpoints() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.set_webhook_endpoint(
  uuid, text, webhook_format, boolean, uuid, text[], text, text, boolean,
  smallint, integer, text, text, bytea, bytea, bytea, bytea, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.update_webhook_endpoint(
  uuid, text, webhook_format, boolean, uuid, text[], smallint, integer) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.forget_webhook_endpoint(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.send_test_notification(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.recent_notifications(integer) TO helm_app;

-- =============================================================================
-- Guards
--
-- Structural, checked at migration time rather than asserted in a test that may
-- not be run. Each is a boundary one convenient grant would erase.
-- =============================================================================
DO $notify_guard$
DECLARE
  v_col text;
BEGIN
  -- 1. THE CREDENTIAL. helm_app renders every page; it must not be able to read
  --    a webhook URL, by any column. Checked per column because a column-level
  --    grant added later to "just show the host on the settings page" is
  --    exactly the shortcut somebody takes, and would not show up in a
  --    table-level test.
  FOR v_col IN
    SELECT column_name FROM information_schema.columns WHERE table_name = 'webhook_endpoint'
  LOOP
    IF has_column_privilege('helm_app', 'webhook_endpoint', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'helm: helm_app can read webhook_endpoint.%', v_col;
    END IF;
  END LOOP;

  -- 2. The worker can, because delivering is its job.
  IF NOT has_table_privilege('helm_worker', 'webhook_endpoint', 'SELECT') THEN
    RAISE EXCEPTION 'helm: helm_worker cannot read webhook_endpoint, so nothing is ever delivered';
  END IF;

  -- 3. ...but helm_app can still CONFIGURE one. Write without read is the whole
  --    shape of this boundary, and a settings page that cannot save is as
  --    broken as one that leaks.
  IF NOT has_function_privilege('helm_app',
        'helm.set_webhook_endpoint(uuid, text, webhook_format, boolean, uuid, text[], text, text, boolean, smallint, integer, text, text, bytea, bytea, bytea, bytea, text)',
        'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app cannot configure a notification destination';
  END IF;

  -- 4. helm_app must not be able to write a delivery directly. The allow-list
  --    in notification_payload() is only a control if every queued row goes
  --    through it.
  IF has_table_privilege('helm_app', 'webhook_delivery', 'INSERT') THEN
    RAISE EXCEPTION 'helm: helm_app can insert a webhook_delivery, bypassing the payload allow-list';
  END IF;

  -- 5. The no-secrets trigger is still attached. It is the second line behind
  --    the allow-list, and a table rebuilt without it would look fine.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'webhook_delivery'
      AND t.tgname = 'webhook_delivery_no_secrets'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'helm: the secret-bearing payload trigger is gone';
  END IF;

  -- 6. And it really recurses. The 0110 version tested top-level keys only, so
  --    a nested password passed; asserting the behaviour rather than the
  --    trigger's presence is what makes that non-repeatable.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'reject_secret_bearing_payload'
      AND pg_get_functiondef(p.oid) LIKE '%$.**%'
  ) THEN
    RAISE EXCEPTION 'helm: the payload check no longer walks nested objects';
  END IF;

  -- 7. The plaintext URL column is really gone.
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.webhook_endpoint'::regclass AND attname = 'url'
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'helm: webhook_endpoint.url is still present in plaintext';
  END IF;
END;
$notify_guard$;
