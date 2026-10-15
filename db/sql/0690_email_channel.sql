-- =============================================================================
-- 0690 — Email: a transport, a per-person switch, and the reminders that need both
--
-- THIS IS NOT A SECOND NOTIFICATION SYSTEM, which is the rule §1 of
-- docs/architecture/10-notifications.md was written to enforce after 0420
-- nearly created a second webhook table beside a dead one. Email becomes a
-- TRANSPORT on the destinations that already exist: the same queue, the same
-- database-side backoff, the same delivery log, the same payload allow-list in
-- helm.notification_payload(), and the same test button that queues rather than
-- sends. `webhook_delivery` keeps meaning "one event, one destination, exactly
-- once".
--
-- Three things are genuinely new, and each is new because it answers a question
-- the webhook path never had to:
--
--   WHERE TO SEND FROM. A webhook destination carries its own address; email
--   needs a relay, and there is one relay per install rather than one per
--   destination. smtp_setting.
--
--   WHETHER A PERSON WANTS TO BE EMAILED. A team channel is configured by an
--   administrator for everybody; personal mail is the person's own business.
--   user_notification_preference.
--
--   REMINDERS, which are addressed to a PERSON about their OWN work rather than
--   to a channel about an event. task_reminder.
--
-- =============================================================================
-- PART 1: THE RELAY, AND WHY PLAINTEXT NEEDS A SIGNATURE
-- =============================================================================
--
-- OFF UNTIL SOMEBODY TURNS IT ON, structurally, the same way 0670's external
-- checks are: a tenant with no smtp_setting row sends nothing, and the enqueue
-- path checks for one. An air-gapped install needs no configuration to stay
-- silent, and no upgrade starts sending mail on anybody's behalf.
--
-- TLS IS REQUIRED UNLESS SOMEBODY SIGNS FOR IT. 'starttls' and 'tls' are the
-- two ordinary modes. 'plaintext' exists because an on-premises MSP relay on
-- port 25 with no TLS is a real deployment and refusing it outright pushes
-- people towards putting Helm's credentials into a cloud relay instead — but it
-- is not a quiet default:
--
--   plaintext_acknowledged_at AND plaintext_acknowledged_by are NOT NULL when
--   security = 'plaintext', enforced by a CHECK. A timestamp and an actor
--   rather than a boolean, because "who accepted this and when" is the question
--   somebody asks a year later, and a boolean cannot answer it.
--
-- A SELF-SIGNED RELAY IS PINNED BY ITS CERTIFICATE, NOT BY A FINGERPRINT, and
-- the difference is not cosmetic — the first version of this stored a
-- fingerprint and compared it in `checkServerIdentity`, which DOES NOT WORK.
-- Measured rather than assumed:
--
--   rejectUnauthorized=false  → checkServerIdentity is NEVER CALLED. The
--                               connection succeeds whatever the pin says.
--   rejectUnauthorized=true   → a self-signed chain is refused BEFORE
--                               checkServerIdentity runs.
--
-- So a fingerprint comparison in that hook is dead code in both directions. It
-- looked implemented, it was stored, a unit test of the comparison function
-- passed in isolation, and the pin accepted any certificate at all. 0430's
-- UniFi client avoids this by taking over socket creation and checking the
-- fingerprint before returning the socket — "THE ORDERING IS THE SECURITY
-- PROPERTY" — which is available there because it owns the HTTP agent, and is
-- not available here because nodemailer performs the STARTTLS upgrade itself.
--
-- What works, and is strictly stronger: store the CERTIFICATE and hand it to
-- Node as the only acceptable CA. Verification is then real
-- (`socket.authorized` is true), it covers implicit TLS and STARTTLS alike
-- because the options are passed into the upgrade, and a different certificate
-- is refused by OpenSSL rather than by our own `if`. The fingerprint an
-- operator compares is DERIVED from the stored certificate at read time, so
-- there is no second copy to disagree with it.
--
-- THE PASSWORD IS AN ENVELOPE, readable by helm_worker and not by helm_app,
-- exactly as 0420's webhook URL is. helm_app writes it through a SECURITY
-- DEFINER function and reads back a flag saying whether one is set. SMTP AUTH
-- sends the password to the relay on every connection, so it is a credential
-- in the ordinary sense and goes where credentials go.
--
-- =============================================================================
-- PART 2: WHO MAY BE EMAILED
-- =============================================================================
--
-- Notifications name clients, assets and credential LABELS — §3 of the
-- notifications document says so, and the settings page says so to whoever is
-- choosing a channel. A destination pointed at an address outside the business
-- is therefore a feed of that to whoever owns the address, and email is far
-- easier to set up and far harder to notice than a chat webhook.
--
-- So allowed_recipient_domains gates it, and an EMPTY ARRAY means "the sending
-- address's own domain", which is the useful default and needs no backfill. A
-- tenant that wants to notify a client's own helpdesk adds that domain
-- deliberately, which is a different act from typing an address into a form.
-- helm.email_recipient_allowed() is the one place that decides, called by the
-- CHECK path on the destination and by the sender.
--
-- A DISTRIBUTION LIST IS THE POINT, which is why this is domains rather than
-- memberships: helpdesk@msp.test is where an MSP wants notifications to land
-- and it is not a Helm user.
--
-- =============================================================================
-- PART 3: REMINDERS ARE NOT NOTIFICATIONS
-- =============================================================================
--
-- F2 gave runs and steps an assignee and a due date; nothing has ever told
-- anybody about either. These reminders are addressed to a PERSON about their
-- OWN work, which is a different shape from a destination delivery, so they get
-- a queue of their own rather than a nullable endpoint on somebody else's.
--
-- KEYED (step, kind, lead_day), which is 0100's alert_event construction
-- verbatim and for the same reason: a job that runs every hour must not remind
-- somebody hourly. The row IS the idempotency record, so a reminder that was
-- suppressed is visible as a row saying so rather than as an absence.
--
-- AND ONLY THE SMALLEST CROSSED THRESHOLD IS SENT, also 0100's rule: adding a
-- step already due in two days must produce one reminder, not one per lead day
-- it has passed. The larger ones are written as 'suppressed', which keeps the
-- unique constraint doing its job while making it visible in the table that
-- they were deliberate.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'smtp_security') THEN
    CREATE TYPE smtp_security AS ENUM ('starttls', 'tls', 'plaintext');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_transport') THEN
    CREATE TYPE notification_transport AS ENUM ('webhook', 'email');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_reminder_kind') THEN
    CREATE TYPE task_reminder_kind AS ENUM ('assigned', 'due');
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- The relay.
-- -----------------------------------------------------------------------------
CREATE TABLE smtp_setting (
  tenant_id   uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,

  -- Off is a complete state. Nothing is sent until this is true, and a tenant
  -- with no row at all is the default.
  enabled     boolean NOT NULL DEFAULT false,

  host        text    NOT NULL,
  port        integer NOT NULL DEFAULT 587,
  security    smtp_security NOT NULL DEFAULT 'starttls',

  -- A pin rather than a disable. The CERTIFICATE, in PEM, because a
  -- fingerprint cannot be enforced — see the header. Node is given this as the
  -- only acceptable CA, so a self-signed relay is verified against exactly one
  -- certificate instead of being trusted blindly.
  tls_verify        boolean NOT NULL DEFAULT true,
  tls_pinned_certificate text,

  -- Signed for, not defaulted to. See the header.
  plaintext_acknowledged_at timestamptz,
  plaintext_acknowledged_by uuid REFERENCES app_user(id) ON DELETE SET NULL,

  -- A relay on a trusted network may need no credentials at all.
  username     text,
  password_set boolean NOT NULL DEFAULT false,

  -- The envelope, same shape and same column names as webhook_endpoint's, so
  -- the TypeScript that seals one seals the other.
  wrap_provider     text,
  kek_id            text,
  wrapped_dek       bytea,
  secret_ciphertext bytea,
  secret_nonce      bytea,
  secret_tag        bytea,
  secret_aad        text,

  from_address citext NOT NULL,
  from_name    text,

  -- Empty means "the from_address's own domain". See the header.
  allowed_recipient_domains text[] NOT NULL DEFAULT '{}',

  -- What happened last time, so the settings page can answer "is this working"
  -- without sending anything.
  last_send_at         timestamptz,
  last_send_ok         boolean,
  last_send_error      text,
  consecutive_failures integer NOT NULL DEFAULT 0,

  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT smtp_port_range CHECK (port BETWEEN 1 AND 65535),
  CONSTRAINT smtp_host_present CHECK (length(trim(host)) > 0),
  CONSTRAINT smtp_from_shape CHECK (
    from_address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  -- A PEM certificate, not a fingerprint and not a private key. The BEGIN
  -- CERTIFICATE check also refuses the obvious paste accident of putting the
  -- relay's KEY here, which would be a private key sitting in a settings
  -- table.
  CONSTRAINT smtp_pin_shape CHECK (
    tls_pinned_certificate IS NULL
    OR (tls_pinned_certificate LIKE '%BEGIN CERTIFICATE%'
        AND tls_pinned_certificate LIKE '%END CERTIFICATE%'
        AND tls_pinned_certificate NOT LIKE '%PRIVATE KEY%'
        AND length(tls_pinned_certificate) BETWEEN 100 AND 16384)
  ),
  -- Verification off with no pin accepts anybody. That is the combination this
  -- refuses; a pin IS the verification in that case.
  CONSTRAINT smtp_unverified_needs_pin CHECK (
    tls_verify OR tls_pinned_certificate IS NOT NULL OR security = 'plaintext'
  ),
  -- Plaintext is signed for. Both columns, so the record names a person.
  CONSTRAINT smtp_plaintext_acknowledged CHECK (
    (security = 'plaintext')
      = (plaintext_acknowledged_at IS NOT NULL AND plaintext_acknowledged_by IS NOT NULL)
  ),
  -- A password that is "set" has an envelope, and an envelope means a password.
  CONSTRAINT smtp_password_paired CHECK (
    password_set = (secret_ciphertext IS NOT NULL)
  ),
  CONSTRAINT smtp_envelope_complete CHECK (
    secret_ciphertext IS NULL
    OR (wrap_provider IS NOT NULL AND kek_id IS NOT NULL AND wrapped_dek IS NOT NULL
        AND secret_nonce IS NOT NULL AND secret_tag IS NOT NULL AND secret_aad IS NOT NULL)
  ),
  CONSTRAINT smtp_nonce_len CHECK (secret_nonce IS NULL OR octet_length(secret_nonce) = 12),
  CONSTRAINT smtp_tag_len CHECK (secret_tag IS NULL OR octet_length(secret_tag) = 16),
  -- A password with no username is a configuration nobody meant.
  CONSTRAINT smtp_password_needs_username CHECK (
    NOT password_set OR (username IS NOT NULL AND length(trim(username)) > 0)
  ),
  -- Stored lower-case so a comparison never has to guess. Written without a
  -- subquery because a CHECK cannot contain one: the array's text form is
  -- compared against its own lower-cased form, which is equivalent for
  -- hostnames and legal in a constraint.
  CONSTRAINT smtp_domains_lowercase CHECK (
    allowed_recipient_domains::text = lower(allowed_recipient_domains::text)
  )
);

COMMENT ON TABLE smtp_setting IS
  'One relay per tenant. Off until enabled; plaintext requires a recorded '
  'acknowledgement; the password is an envelope helm_app cannot read.';

-- -----------------------------------------------------------------------------
-- Email as a transport on the destinations that already exist.
-- -----------------------------------------------------------------------------
ALTER TABLE webhook_endpoint
  ADD COLUMN IF NOT EXISTS transport notification_transport NOT NULL DEFAULT 'webhook',
  -- Plaintext, unlike the webhook URL, and deliberately: a URL IS the
  -- credential for Discord and Teams, while an address is a destination an
  -- administrator has to be able to read to know where notifications are
  -- going. Every member's address is already on the users screen.
  ADD COLUMN IF NOT EXISTS email_address citext;

-- url_host and url_digest describe a URL. An email destination has none, so
-- they stop being NOT NULL and a CHECK ties each column to its transport
-- instead — which says more than NOT NULL did.
ALTER TABLE webhook_endpoint ALTER COLUMN url_host DROP NOT NULL;
ALTER TABLE webhook_endpoint ALTER COLUMN url_digest DROP NOT NULL;

ALTER TABLE webhook_endpoint
  DROP CONSTRAINT IF EXISTS webhook_transport_shape,
  ADD CONSTRAINT webhook_transport_shape CHECK (
    CASE transport
      WHEN 'webhook' THEN url_host IS NOT NULL AND url_digest IS NOT NULL
                          AND email_address IS NULL
      WHEN 'email'   THEN email_address IS NOT NULL
                          AND url_host IS NULL AND url_digest IS NULL
    END
  ),
  DROP CONSTRAINT IF EXISTS webhook_email_shape,
  ADD CONSTRAINT webhook_email_shape CHECK (
    email_address IS NULL
    OR email_address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  );

-- An email destination has no URL to seal and no HMAC to sign with, so 0420's
-- "there is always an envelope" constraints become conditional on the
-- transport. Reproduced rather than edited, because an applied migration is
-- immutable.
ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_secret_present;
ALTER TABLE webhook_endpoint
  ADD CONSTRAINT webhook_secret_present CHECK (
    transport <> 'webhook' OR octet_length(secret_ciphertext) > 0
  );

COMMENT ON COLUMN webhook_endpoint.transport IS
  'How this destination is reached. 0690 added email; the queue, the backoff '
  'and the payload allow-list are shared — see 10-notifications.md §1.';

-- -----------------------------------------------------------------------------
-- Whether a recipient is allowed. One place decides.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.email_recipient_allowed(
  p_tenant_id uuid,
  p_address   text
) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM smtp_setting s
    WHERE s.tenant_id = p_tenant_id
      AND lower(split_part(p_address, '@', 2)) = ANY (
        CASE
          -- Empty means the sending address's own domain, which is the useful
          -- default: a tenant that has configured a relay can always notify
          -- itself.
          WHEN cardinality(s.allowed_recipient_domains) = 0
            THEN ARRAY[lower(split_part(s.from_address::text, '@', 2))]
          ELSE s.allowed_recipient_domains
        END
      )
  );
$$;

COMMENT ON FUNCTION helm.email_recipient_allowed(uuid, text) IS
  'Whether a tenant may send to this address. Empty allowed_recipient_domains '
  'means the sending domain only. Notifications name clients and credential '
  'labels, so this is a disclosure boundary rather than a convenience.';

-- -----------------------------------------------------------------------------
-- What a person wants to be emailed about.
--
-- A jsonb set with a SQL validator and a TypeScript mirror, which is 0370's
-- construction for user_dashboard.widgets and 0620's for user_sidebar — and the
-- agreement test that comes with it is the thing that stops a kind being added
-- in one place only.
--
-- NOT COLUMNS, because the list grows: L adds an in-app surface, and a boolean
-- per kind means a migration per kind.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.notification_kinds_valid(p_kinds jsonb)
  RETURNS boolean
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT jsonb_typeof(p_kinds) = 'array'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(p_kinds) k
       WHERE k NOT IN ('task_assigned', 'task_due')
     )
     -- A duplicate would make "is this enabled" depend on which copy is read.
     AND (SELECT count(DISTINCT k) FROM jsonb_array_elements_text(p_kinds) k)
       = jsonb_array_length(p_kinds);
$$;

COMMENT ON FUNCTION helm.notification_kinds_valid(jsonb) IS
  'The legal personal notification kinds. Mirrored by NOTIFICATION_KINDS in '
  'src/lib/notifications/kinds.ts, with a test asserting the two agree.';

CREATE TABLE user_notification_preference (
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,

  -- An ABSENT ROW means the shipped default (both kinds on), and an EMPTY ARRAY
  -- means somebody turned everything off. They are different answers: if `[]`
  -- fell through to the default, a person who unticked both boxes would watch
  -- the control appear to do nothing. 0620 learned this the same way.
  kinds      jsonb NOT NULL DEFAULT '["task_assigned", "task_due"]'::jsonb,

  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_notification_preference_pk PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT user_notification_preference_member_fk
    FOREIGN KEY (tenant_id, user_id) REFERENCES membership (tenant_id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT user_notification_preference_kinds
    CHECK (helm.notification_kinds_valid(kinds))
);

COMMENT ON TABLE user_notification_preference IS
  'Per-person email toggles. Keyed to the MEMBERSHIP rather than the user, so '
  'somebody belonging to two tenants decides separately for each and leaving '
  'one takes the preference with it.';

-- -----------------------------------------------------------------------------
-- The reminder queue.
--
-- FIRST, THE KEY IT NEEDS. Every table in this schema that other tables point
-- at carries UNIQUE (id, tenant_id) — asset_node, attachment, organization,
-- site — because that is what lets a referencing row bind to the same tenant in
-- the foreign key itself rather than in whatever code writes it. §2 of
-- docs/architecture/02-data-model.md calls that "free and unforgettable".
--
-- sop_run_step never got one. 0090 created it and 0650 added an assignee
-- without needing to point AT it, so the omission has been invisible: this is
-- the first table that references a step. Added here rather than worked around
-- with a single-column foreign key, because a single-column key is exactly how
-- a reminder for one tenant's step ends up carrying another tenant's id.
-- -----------------------------------------------------------------------------
ALTER TABLE sop_run_step
  DROP CONSTRAINT IF EXISTS sop_run_step_tenant_uk,
  ADD CONSTRAINT sop_run_step_tenant_uk UNIQUE (id, tenant_id);

CREATE TABLE task_reminder (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  step_id    uuid NOT NULL,
  -- Who it is for. The step's assignee at the moment the reminder was raised —
  -- stored rather than joined, because reassigning a step must not redirect a
  -- reminder already queued for somebody else.
  user_id    uuid NOT NULL,
  kind       task_reminder_kind NOT NULL,
  -- Days before the due date this reminder is for. 0 is due today or overdue.
  -- 'assigned' reminders use -1, which no lead day can collide with.
  lead_day   integer NOT NULL,

  status     text NOT NULL DEFAULT 'pending',
  attempts   smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,

  CONSTRAINT task_reminder_step_fk FOREIGN KEY (step_id, tenant_id)
    REFERENCES sop_run_step (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT task_reminder_member_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES membership (tenant_id, user_id) ON DELETE CASCADE,
  -- 0100's alert_event key, verbatim in spirit: one reminder per step per kind
  -- per threshold, forever.
  CONSTRAINT task_reminder_uk UNIQUE (step_id, kind, lead_day),
  CONSTRAINT task_reminder_status_known CHECK (
    status IN ('pending', 'sent', 'failed', 'suppressed', 'dead')
  ),
  CONSTRAINT task_reminder_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT task_reminder_lead_range CHECK (lead_day BETWEEN -1 AND 365)
);

CREATE INDEX task_reminder_due_idx ON task_reminder (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX task_reminder_step_idx ON task_reminder (step_id);

COMMENT ON TABLE task_reminder IS
  'Personal reminders about assigned checklist steps. Its own queue rather '
  'than webhook_delivery: that table keys on (endpoint, event) and every row '
  'belongs to a destination, while these belong to a person.';

-- =============================================================================
-- Reading and writing the relay
--
-- helm_app NEVER SELECTS THE ENVELOPE. It calls these, exactly as 0420 has it
-- call helm.webhook_endpoints() and helm.set_webhook_endpoint() — the column
-- grants below make that structural rather than a convention.
-- =============================================================================
CREATE OR REPLACE FUNCTION helm.smtp_settings()
  RETURNS TABLE (
    enabled boolean, host text, port integer, security smtp_security,
    tls_verify boolean, tls_pinned_certificate text,
    plaintext_acknowledged_at timestamptz, plaintext_acknowledged_by uuid,
    username text, password_set boolean,
    from_address text, from_name text, allowed_recipient_domains text[],
    last_send_at timestamptz, last_send_ok boolean, last_send_error text,
    consecutive_failures integer, updated_at timestamptz, configured boolean
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT s.enabled, s.host, s.port, s.security,
         s.tls_verify, s.tls_pinned_certificate,
         s.plaintext_acknowledged_at, s.plaintext_acknowledged_by,
         s.username, s.password_set,
         s.from_address::text, s.from_name, s.allowed_recipient_domains,
         s.last_send_at, s.last_send_ok, s.last_send_error,
         s.consecutive_failures, s.updated_at, true
  FROM smtp_setting s
  WHERE s.tenant_id = helm.require_tenant_id();
$$;

CREATE OR REPLACE FUNCTION helm.set_smtp_setting(
  p_enabled      boolean,
  p_host         text,
  p_port         integer,
  p_security     smtp_security,
  p_tls_verify   boolean,
  p_pin          text,
  p_username     text,
  p_from_address text,
  p_from_name    text,
  p_domains      text[],
  -- NULL leaves whatever password is stored alone, so saving the host does not
  -- require re-typing the password. An empty string clears it.
  p_wrap_provider text,
  p_kek_id        text,
  p_wrapped_dek   bytea,
  p_ciphertext    bytea,
  p_nonce         bytea,
  p_tag           bytea,
  p_aad           text,
  p_clear_password boolean DEFAULT false
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
BEGIN
  IF NOT helm.has_permission('tenant:write') THEN
    RAISE EXCEPTION 'helm: tenant:write is required to configure the mail relay'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO smtp_setting AS s (
    tenant_id, enabled, host, port, security, tls_verify, tls_pinned_certificate,
    plaintext_acknowledged_at, plaintext_acknowledged_by,
    username, password_set,
    wrap_provider, kek_id, wrapped_dek, secret_ciphertext, secret_nonce,
    secret_tag, secret_aad,
    from_address, from_name, allowed_recipient_domains, updated_by
  )
  VALUES (
    v_tenant, p_enabled, p_host, p_port, p_security, p_tls_verify, p_pin,
    CASE WHEN p_security = 'plaintext' THEN now() END,
    CASE WHEN p_security = 'plaintext' THEN v_actor END,
    p_username, p_ciphertext IS NOT NULL,
    p_wrap_provider, p_kek_id, p_wrapped_dek, p_ciphertext, p_nonce,
    p_tag, p_aad,
    p_from_address::citext, p_from_name,
    ARRAY(SELECT lower(d) FROM unnest(coalesce(p_domains, '{}')) d), v_actor
  )
  ON CONFLICT (tenant_id) DO UPDATE SET
    enabled   = EXCLUDED.enabled,
    host      = EXCLUDED.host,
    port      = EXCLUDED.port,
    security  = EXCLUDED.security,
    tls_verify = EXCLUDED.tls_verify,
    tls_pinned_certificate = EXCLUDED.tls_pinned_certificate,
    -- The acknowledgement is re-stamped when plaintext is chosen and cleared
    -- when it is not, so the record always describes the CURRENT setting. A
    -- stale timestamp against a TLS relay would read as somebody having
    -- accepted a risk that is not being taken.
    plaintext_acknowledged_at = CASE
      WHEN EXCLUDED.security <> 'plaintext' THEN NULL
      WHEN s.security = 'plaintext' THEN s.plaintext_acknowledged_at
      ELSE now()
    END,
    plaintext_acknowledged_by = CASE
      WHEN EXCLUDED.security <> 'plaintext' THEN NULL
      WHEN s.security = 'plaintext' THEN s.plaintext_acknowledged_by
      ELSE v_actor
    END,
    username  = EXCLUDED.username,
    from_address = EXCLUDED.from_address,
    from_name = EXCLUDED.from_name,
    allowed_recipient_domains = EXCLUDED.allowed_recipient_domains,
    -- A NULL ciphertext with p_clear_password false means "leave it alone".
    password_set = CASE
      WHEN p_clear_password THEN false
      WHEN EXCLUDED.secret_ciphertext IS NOT NULL THEN true
      ELSE s.password_set
    END,
    wrap_provider = CASE WHEN p_clear_password THEN NULL
      ELSE coalesce(EXCLUDED.wrap_provider, s.wrap_provider) END,
    kek_id = CASE WHEN p_clear_password THEN NULL
      ELSE coalesce(EXCLUDED.kek_id, s.kek_id) END,
    wrapped_dek = CASE WHEN p_clear_password THEN NULL
      ELSE coalesce(EXCLUDED.wrapped_dek, s.wrapped_dek) END,
    secret_ciphertext = CASE WHEN p_clear_password THEN NULL
      ELSE coalesce(EXCLUDED.secret_ciphertext, s.secret_ciphertext) END,
    secret_nonce = CASE WHEN p_clear_password THEN NULL
      ELSE coalesce(EXCLUDED.secret_nonce, s.secret_nonce) END,
    secret_tag = CASE WHEN p_clear_password THEN NULL
      ELSE coalesce(EXCLUDED.secret_tag, s.secret_tag) END,
    secret_aad = CASE WHEN p_clear_password THEN NULL
      ELSE coalesce(EXCLUDED.secret_aad, s.secret_aad) END,
    updated_at = now(),
    updated_by = v_actor;
END;
$$;

-- -----------------------------------------------------------------------------
-- What the worker needs to open a connection. The envelope leaves the database
-- only through this, and only to helm_worker.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.smtp_transport(p_tenant_id uuid)
  RETURNS TABLE (
    host text, port integer, security smtp_security,
    tls_verify boolean, tls_pinned_certificate text,
    username text, from_address text, from_name text,
    wrap_provider text, kek_id text, wrapped_dek bytea,
    secret_ciphertext bytea, secret_nonce bytea, secret_tag bytea, secret_aad text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT s.host, s.port, s.security, s.tls_verify, s.tls_pinned_certificate,
         s.username, s.from_address::text, s.from_name,
         s.wrap_provider, s.kek_id, s.wrapped_dek,
         s.secret_ciphertext, s.secret_nonce, s.secret_tag, s.secret_aad
  FROM smtp_setting s
  WHERE s.tenant_id = p_tenant_id AND s.enabled;
$$;

CREATE OR REPLACE FUNCTION helm.record_smtp_result(
  p_tenant_id uuid, p_ok boolean, p_error text
) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  UPDATE smtp_setting SET
    last_send_at = now(),
    last_send_ok = p_ok,
    last_send_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
    consecutive_failures = CASE WHEN p_ok THEN 0 ELSE consecutive_failures + 1 END
  WHERE tenant_id = p_tenant_id;
$$;

-- =============================================================================
-- Raising reminders
--
-- LEAD DAYS ARE FIXED AT {3, 1, 0} and that is deliberate rather than lazy.
-- alert_rule makes expiry lead days configurable because a certificate renewal
-- is a procurement timeline that genuinely differs between MSPs; a checklist
-- step is somebody's afternoon. Three days, one day, and the day it is due is
-- enough resolution for that, and a configurable set here would be a screen
-- nobody opens.
--
-- ONLY THE SMALLEST CROSSED THRESHOLD IS SENT, which is 0100's firing rule and
-- the reason it exists: adding a step already due in two days must produce ONE
-- reminder, not one for the 3-day threshold it has passed as well. The larger
-- ones are written as 'suppressed' in the same statement, so the unique
-- constraint keeps them from ever firing later and the table shows that it was
-- deliberate rather than missed.
-- =============================================================================
CREATE OR REPLACE FUNCTION helm.raise_task_reminders(p_limit integer DEFAULT 500)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_leads constant integer[] := ARRAY[3, 1, 0];
  v_raised integer := 0;
BEGIN
  WITH candidate AS (
    SELECT s.id AS step_id, s.tenant_id, s.assigned_to, s.due_at,
           -- Every threshold this step has crossed, smallest first.
           (SELECT array_agg(l ORDER BY l)
              FROM unnest(v_leads) l
             WHERE s.due_at <= now() + make_interval(days => l)) AS crossed
    FROM sop_run_step s
    JOIN sop_run r ON r.id = s.run_id AND r.tenant_id = s.tenant_id
    JOIN smtp_setting m ON m.tenant_id = s.tenant_id AND m.enabled
    WHERE s.assigned_to IS NOT NULL
      AND s.due_at IS NOT NULL
      AND s.status = 'pending'
      AND r.status IN ('in_progress', 'blocked')
      -- The person has to want it. An absent row is the shipped default, which
      -- is both kinds on — see the table's comment.
      AND coalesce(
            (SELECT p.kinds @> '["task_due"]'::jsonb
               FROM user_notification_preference p
              WHERE p.tenant_id = s.tenant_id AND p.user_id = s.assigned_to),
            true)
      -- And still be a member, because the reminder's foreign key says so and
      -- because work assigned to somebody who left is not a reminder, it is a
      -- reassignment somebody has to do.
      -- `status = 'active'` AND an unexpired membership, which is the same
      -- pair listAssignableUsers() uses (0650). membership has no is_active
      -- column; the first version of this assumed one and failed on every row.
      AND EXISTS (
        SELECT 1 FROM membership mb
        WHERE mb.tenant_id = s.tenant_id AND mb.user_id = s.assigned_to
          AND mb.status = 'active'
          AND (mb.expires_at IS NULL OR mb.expires_at > now())
      )
    ORDER BY s.due_at
    LIMIT greatest(p_limit, 1)
  ),
  queued AS (
    INSERT INTO task_reminder (tenant_id, step_id, user_id, kind, lead_day, status)
    SELECT c.tenant_id, c.step_id, c.assigned_to, 'due', l,
           -- The smallest crossed threshold is the one that is sent. Everything
           -- larger is recorded as deliberately skipped.
           CASE WHEN l = c.crossed[1] THEN 'pending' ELSE 'suppressed' END
    FROM candidate c
    CROSS JOIN unnest(c.crossed) l
    ON CONFLICT (step_id, kind, lead_day) DO NOTHING
    RETURNING status
  )
  SELECT count(*) FILTER (WHERE status = 'pending') INTO v_raised FROM queued;

  RETURN v_raised;
END;
$$;

-- -----------------------------------------------------------------------------
-- One reminder when a step is first given to somebody.
--
-- Separate from the due-date sweep because it is a different event: being handed
-- work is news whatever the due date is, and a step with no due date would
-- otherwise never produce anything. lead_day is -1, which no real threshold can
-- collide with, so the unique constraint still means "once".
--
-- Called from the application at the moment of assignment rather than swept
-- for: "assigned" is an act, not a state, and a sweep cannot tell a step
-- assigned yesterday from one assigned a moment ago.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.raise_assignment_reminder(p_step_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_rows   integer;
BEGIN
  INSERT INTO task_reminder (tenant_id, step_id, user_id, kind, lead_day)
  SELECT s.tenant_id, s.id, s.assigned_to, 'assigned', -1
  FROM sop_run_step s
  JOIN smtp_setting m ON m.tenant_id = s.tenant_id AND m.enabled
  WHERE s.id = p_step_id
    AND s.tenant_id = v_tenant
    AND s.assigned_to IS NOT NULL
    -- Nobody needs an email saying they gave themselves a job.
    AND s.assigned_to <> coalesce(helm.current_actor_id(), '00000000-0000-0000-0000-000000000000'::uuid)
    AND coalesce(
          (SELECT p.kinds @> '["task_assigned"]'::jsonb
             FROM user_notification_preference p
            WHERE p.tenant_id = s.tenant_id AND p.user_id = s.assigned_to),
          true)
  ON CONFLICT (step_id, kind, lead_day) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

-- -----------------------------------------------------------------------------
-- Draining the queue. Same shape as helm.claim_notifications().
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.email_backlog(p_limit integer DEFAULT 25)
  RETURNS TABLE (tenant_id uuid, tenant_name text, worker_actor_id uuid, due bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT t.id, t.name,
         helm.worker_actor(t.id, 'system_alerts'),
         count(r.id)
  FROM tenant t
  JOIN smtp_setting s ON s.tenant_id = t.id AND s.enabled
  JOIN task_reminder r ON r.tenant_id = t.id
    AND r.status = 'pending' AND r.next_attempt_at <= now()
  WHERE t.status = 'active'
    AND helm.worker_actor(t.id, 'system_alerts') IS NOT NULL
  GROUP BY t.id, t.name
  ORDER BY t.name
  LIMIT greatest(p_limit, 1);
$$;

CREATE OR REPLACE FUNCTION helm.claim_task_reminders(p_limit integer DEFAULT 50)
  RETURNS TABLE (
    reminder_id uuid, kind task_reminder_kind, lead_day integer,
    recipient text, recipient_name text,
    -- The RUN's id, because the link in the message points at the run. Caught
    -- by reading the worker back: it was passing the reminder's own id, which
    -- would have produced a 404 in every reminder ever sent.
    run_id uuid,
    step_title text, step_position integer, run_title text,
    organization_name text, due_at timestamptz, attempts smallint
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT r.id, r.kind, r.lead_day,
         u.email::text, u.name,
         run.id,
         s.title, s.position, run.title,
         o.name, s.due_at, r.attempts
  FROM task_reminder r
  JOIN sop_run_step s ON s.id = r.step_id AND s.tenant_id = r.tenant_id
  JOIN sop_run run ON run.id = s.run_id AND run.tenant_id = r.tenant_id
  JOIN organization o ON o.id = run.organization_id AND o.tenant_id = r.tenant_id
  JOIN app_user u ON u.id = r.user_id
  WHERE r.tenant_id = helm.require_tenant_id()
    AND r.status = 'pending'
    AND r.next_attempt_at <= now()
    -- A step completed between raising and sending needs no reminder, and the
    -- sweep cannot know that in advance.
    AND s.status = 'pending'
  ORDER BY r.created_at
  LIMIT greatest(p_limit, 1);
$$;

CREATE OR REPLACE FUNCTION helm.record_task_reminder(
  p_id uuid, p_ok boolean, p_error text DEFAULT NULL
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_max constant smallint := 6;
BEGIN
  -- Backoff in the database, for 0420's reason: two workers, or one restarted
  -- mid-batch, cannot disagree about when a reminder is next due.
  UPDATE task_reminder SET
    attempts = attempts + 1,
    last_attempt_at = now(),
    error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
    sent_at = CASE WHEN p_ok THEN now() ELSE sent_at END,
    status = CASE
      WHEN p_ok THEN 'sent'
      -- 'dead' rather than 'failed' when the attempts run out: failed means it
      -- will try again, dead means a person has to look.
      WHEN attempts + 1 >= v_max THEN 'dead'
      ELSE 'pending'
    END,
    next_attempt_at = CASE
      WHEN p_ok THEN next_attempt_at
      ELSE now() + make_interval(mins => least(60, power(2, attempts)::integer))
    END
  WHERE id = p_id AND tenant_id = helm.require_tenant_id();
END;
$$;

-- A step that is done needs no reminder. Suppressing rather than deleting keeps
-- the unique constraint doing its job, so completing a step cannot cause the
-- next sweep to raise the same reminder again.
CREATE OR REPLACE FUNCTION helm.suppress_reminders_for_step(p_step_id uuid)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE task_reminder
  SET status = 'suppressed'
  WHERE step_id = p_step_id
    AND tenant_id = helm.require_tenant_id()
    AND status = 'pending';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

-- =============================================================================
-- Grants
--
-- THE ENVELOPE IS A COLUMN GRANT, NOT A POLICY. helm_app is granted every
-- column of smtp_setting EXCEPT the six that hold the sealed password, which is
-- 0420's construction for the webhook URL and is stronger than a policy for the
-- same reason: a policy can be widened by somebody who did not read this file,
-- and a missing column privilege produces an error at the point of the mistake.
-- =============================================================================
-- THE REVOKE COMES FIRST, AND IT IS THE WHOLE THING. 0220 sets ALTER DEFAULT
-- PRIVILEGES granting helm_app full DML on every table a later migration
-- creates, so this table arrived with SELECT on all columns and the
-- column-level GRANT below would have restricted nothing. Guard 2 caught
-- exactly that on this migration's first run — the second time in two groups,
-- after 0680's node_view_stat.
REVOKE ALL ON smtp_setting FROM helm_app;

GRANT SELECT (
  tenant_id, enabled, host, port, security, tls_verify, tls_pinned_certificate,
  plaintext_acknowledged_at, plaintext_acknowledged_by, username, password_set,
  from_address, from_name, allowed_recipient_domains,
  last_send_at, last_send_ok, last_send_error, consecutive_failures,
  updated_at, updated_by
) ON smtp_setting TO helm_app;

-- Writing goes through helm.set_smtp_setting(), which is SECURITY DEFINER and
-- checks tenant:write itself. The revoke above already removed INSERT, UPDATE
-- and DELETE; nothing grants them back, which is the point.

-- The worker reads the envelope, and only through helm.smtp_transport().
REVOKE ALL ON smtp_setting FROM helm_worker;
GRANT SELECT ON smtp_setting TO helm_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON user_notification_preference TO helm_app;
GRANT SELECT ON task_reminder TO helm_app;
GRANT SELECT, INSERT, UPDATE ON task_reminder TO helm_worker;

REVOKE ALL ON FUNCTION helm.smtp_transport(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.smtp_transport(uuid) TO helm_worker;
REVOKE ALL ON FUNCTION helm.record_smtp_result(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.record_smtp_result(uuid, boolean, text) TO helm_worker;
REVOKE ALL ON FUNCTION helm.email_backlog(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.email_backlog(integer) TO helm_worker;
REVOKE ALL ON FUNCTION helm.claim_task_reminders(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.claim_task_reminders(integer) TO helm_worker;
REVOKE ALL ON FUNCTION helm.record_task_reminder(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.record_task_reminder(uuid, boolean, text) TO helm_worker;
REVOKE ALL ON FUNCTION helm.raise_task_reminders(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.raise_task_reminders(integer) TO helm_worker;

REVOKE ALL ON FUNCTION helm.smtp_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.smtp_settings() TO helm_app;
REVOKE ALL ON FUNCTION helm.set_smtp_setting(
  boolean, text, integer, smtp_security, boolean, text, text, text, text,
  text[], text, text, bytea, bytea, bytea, bytea, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.set_smtp_setting(
  boolean, text, integer, smtp_security, boolean, text, text, text, text,
  text[], text, text, bytea, bytea, bytea, bytea, text, boolean) TO helm_app;
-- Raised by the application at the moment of assignment, so helm_app calls it.
REVOKE ALL ON FUNCTION helm.raise_assignment_reminder(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.raise_assignment_reminder(uuid) TO helm_app, helm_worker;
REVOKE ALL ON FUNCTION helm.suppress_reminders_for_step(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.suppress_reminders_for_step(uuid) TO helm_app, helm_worker;
GRANT EXECUTE ON FUNCTION helm.email_recipient_allowed(uuid, text) TO helm_app, helm_worker;
GRANT EXECUTE ON FUNCTION helm.notification_kinds_valid(jsonb) TO helm_app, helm_worker;

-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE smtp_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE smtp_setting FORCE ROW LEVEL SECURITY;
ALTER TABLE user_notification_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification_preference FORCE ROW LEVEL SECURITY;
ALTER TABLE task_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_reminder FORCE ROW LEVEL SECURITY;

-- The relay's non-secret columns are readable tenant-wide, because every role
-- benefits from knowing whether Helm can send mail at all — a notification
-- toggle with no relay behind it is a control that does nothing, and the
-- profile screen says so. Writing is gated inside set_smtp_setting(); these
-- policies exist for the definer function under FORCE.
CREATE POLICY smtp_setting_rls_select ON smtp_setting
  FOR SELECT USING (tenant_id = helm.current_tenant_id());
CREATE POLICY smtp_setting_rls_insert ON smtp_setting
  FOR INSERT WITH CHECK (tenant_id = helm.current_tenant_id());
CREATE POLICY smtp_setting_rls_update ON smtp_setting
  FOR UPDATE USING (tenant_id = helm.current_tenant_id())
  WITH CHECK (tenant_id = helm.current_tenant_id());
CREATE POLICY smtp_setting_rls_delete ON smtp_setting
  FOR DELETE USING (
    tenant_id = helm.current_tenant_id() AND helm.has_permission('tenant:write')
  );

-- A PREFERENCE IS PRIVATE. Same rule as user_sidebar and user_dashboard: what
-- somebody chooses to be told about is their business, and an administrator
-- reading the list learns who is paying attention to what.
CREATE POLICY user_notification_preference_rls_select ON user_notification_preference
  FOR SELECT USING (
    tenant_id = helm.current_tenant_id() AND user_id = helm.current_actor_id()
  );
CREATE POLICY user_notification_preference_rls_insert ON user_notification_preference
  FOR INSERT WITH CHECK (
    tenant_id = helm.current_tenant_id() AND user_id = helm.current_actor_id()
  );
CREATE POLICY user_notification_preference_rls_update ON user_notification_preference
  FOR UPDATE USING (
    tenant_id = helm.current_tenant_id() AND user_id = helm.current_actor_id()
  ) WITH CHECK (
    tenant_id = helm.current_tenant_id() AND user_id = helm.current_actor_id()
  );
CREATE POLICY user_notification_preference_rls_delete ON user_notification_preference
  FOR DELETE USING (
    tenant_id = helm.current_tenant_id() AND user_id = helm.current_actor_id()
  );

-- A REMINDER IS ALSO PRIVATE, for the same reason and one more: the row names a
-- step somebody has been asked to do, so a tenant-wide read would be a list of
-- who is behind on what.
CREATE POLICY task_reminder_rls_select ON task_reminder
  FOR SELECT USING (
    tenant_id = helm.current_tenant_id()
    AND (user_id = helm.current_actor_id() OR helm.has_permission('audit:read'))
  );
CREATE POLICY task_reminder_rls_insert ON task_reminder
  FOR INSERT WITH CHECK (tenant_id = helm.current_tenant_id());
CREATE POLICY task_reminder_rls_update ON task_reminder
  FOR UPDATE USING (tenant_id = helm.current_tenant_id())
  WITH CHECK (tenant_id = helm.current_tenant_id());
CREATE POLICY task_reminder_rls_delete ON task_reminder
  FOR DELETE USING (
    tenant_id = helm.current_tenant_id() AND helm.has_permission('asset:write')
  );

-- =============================================================================
-- Guards
-- =============================================================================
DO $email_guard$
BEGIN
  -- 1. OFF UNTIL SOMEBODY TURNS IT ON. An air-gapped install must send nothing
  --    with zero configuration, which means the default is false and a tenant
  --    with no row contributes nothing.
  IF (SELECT column_default FROM information_schema.columns
      WHERE table_name = 'smtp_setting' AND column_name = 'enabled') NOT LIKE '%false%' THEN
    RAISE EXCEPTION 'helm: outbound email must default to off';
  END IF;

  -- 2. helm_app CANNOT READ THE PASSWORD. The load-bearing grant of this
  --    migration, asserted per column exactly as 0420 asserts the webhook URL.
  IF has_column_privilege('helm_app', 'smtp_setting', 'secret_ciphertext', 'SELECT') THEN
    RAISE EXCEPTION 'helm: helm_app can read the SMTP password ciphertext';
  END IF;
  IF has_column_privilege('helm_app', 'smtp_setting', 'wrapped_dek', 'SELECT') THEN
    RAISE EXCEPTION 'helm: helm_app can read the SMTP wrapped DEK';
  END IF;
  IF has_column_privilege('helm_app', 'smtp_setting', 'secret_nonce', 'SELECT')
    OR has_column_privilege('helm_app', 'smtp_setting', 'secret_tag', 'SELECT')
    OR has_column_privilege('helm_app', 'smtp_setting', 'secret_aad', 'SELECT')
    OR has_column_privilege('helm_app', 'smtp_setting', 'kek_id', 'SELECT')
    OR has_column_privilege('helm_app', 'smtp_setting', 'wrap_provider', 'SELECT') THEN
    RAISE EXCEPTION 'helm: helm_app can read part of the SMTP envelope';
  END IF;
  -- ...and it can still read the things a settings page needs.
  IF NOT has_column_privilege('helm_app', 'smtp_setting', 'host', 'SELECT')
    OR NOT has_column_privilege('helm_app', 'smtp_setting', 'password_set', 'SELECT') THEN
    RAISE EXCEPTION 'helm: helm_app cannot read the relay configuration it has to render';
  END IF;

  -- 3. AND IT CANNOT WRITE THE TABLE AT ALL. Writing goes through
  --    set_smtp_setting(), which checks tenant:write; a direct UPDATE would
  --    bypass that check entirely.
  IF has_table_privilege('helm_app', 'smtp_setting', 'UPDATE')
    OR has_table_privilege('helm_app', 'smtp_setting', 'INSERT') THEN
    RAISE EXCEPTION
      'helm: helm_app can write smtp_setting directly, bypassing the tenant:write check';
  END IF;

  -- 4. PLAINTEXT IS SIGNED FOR. The CHECK is what makes the acknowledgement
  --    more than a word in a comment.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'smtp_plaintext_acknowledged'
  ) THEN
    RAISE EXCEPTION 'helm: plaintext SMTP must require a recorded acknowledgement';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'smtp_unverified_needs_pin'
  ) THEN
    RAISE EXCEPTION 'helm: TLS verification cannot be disabled without a pin';
  END IF;

  -- 5. THE TWO TRANSPORTS CANNOT BE CONFUSED. A webhook row with no URL, or an
  --    email row with no address, is a destination that fails at delivery time
  --    rather than at configuration time.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_transport_shape'
  ) THEN
    RAISE EXCEPTION 'helm: the transport shape constraint is missing';
  END IF;

  -- 6. A REMINDER FIRES ONCE. 0100's lead-day key, which is the whole reason a
  --    nightly job does not become a nightly nuisance.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_reminder_uk'
  ) THEN
    RAISE EXCEPTION 'helm: task_reminder needs its (step, kind, lead_day) key';
  END IF;

  -- 7. A PREFERENCE IS PRIVATE, and asserted because the read policy is the
  --    only thing making it so: the table carries no secret material, so
  --    nothing else would notice if it became tenant-wide.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'user_notification_preference'
      AND p.polname = 'user_notification_preference_rls_select'
      AND pg_get_expr(p.polqual, p.polrelid) LIKE '%current_actor_id%'
  ) THEN
    RAISE EXCEPTION
      'helm: a notification preference must be readable only by its owner';
  END IF;

  -- 8. EVERY NEW TABLE IS BEHIND RLS, FORCED, WITH A POLICY PER COMMAND.
  IF (SELECT count(*) FROM pg_class
      WHERE relname IN ('smtp_setting', 'user_notification_preference', 'task_reminder')
        AND relrowsecurity AND relforcerowsecurity) <> 3 THEN
    RAISE EXCEPTION 'helm: 0690''s tables need RLS, forced';
  END IF;
  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relname IN ('smtp_setting', 'user_notification_preference', 'task_reminder'))
      <> 12 THEN
    RAISE EXCEPTION 'helm: 0690''s tables need a policy per command';
  END IF;

  -- 9. THE RECIPIENT GATE EXISTS. Notifications name clients and credential
  --    labels; without this an address in a form is a feed of that to anybody.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'email_recipient_allowed'
  ) THEN
    RAISE EXCEPTION 'helm: the recipient domain gate is missing';
  END IF;
END;
$email_guard$;
