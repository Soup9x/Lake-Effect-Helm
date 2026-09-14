-- =============================================================================
-- 0070_credentials.sql — vault items and browser-extension domain matching
--
-- A credential is a graph node in its own right. That is deliberate: "which
-- firewall does this admin account unlock" and "what breaks if we rotate this
-- service account" are dependency questions, and they only have answers if
-- credentials live in the same graph as the assets.
--
-- No plaintext lives here. The credential row holds identity and policy; the
-- material lives in secret / secret_version behind the audited reveal API.
-- =============================================================================

SET search_path = public, extensions;

CREATE TYPE credential_type AS ENUM (
  'local_admin', 'domain_admin', 'service_account', 'standard_user',
  'api', 'database', 'wifi', 'vpn', 'root', 'recovery', 'shared_mailbox', 'other'
);

CREATE TYPE domain_match_type AS ENUM ('exact_host', 'registrable_domain', 'subdomain_of');

CREATE TABLE credential (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  node_type           node_type NOT NULL DEFAULT 'credential',

  credential_type     credential_type NOT NULL DEFAULT 'standard_user',
  username            text,
  -- Where this credential is used. Free text; the machine-readable matching
  -- rules live in credential_domain.
  url                 text,
  notes               text,

  secret_id           uuid,
  -- TOTP configuration. The seed itself is a secret of kind 'totp_seed'; these
  -- columns are the non-sensitive parameters needed to compute the code.
  totp_secret_id      uuid,
  totp_secret_kind    secret_kind GENERATED ALWAYS AS (
                        CASE WHEN totp_secret_id IS NULL THEN NULL
                             ELSE 'totp_seed'::secret_kind END
                      ) STORED,
  totp_algorithm      text NOT NULL DEFAULT 'SHA1',
  totp_digits         smallint NOT NULL DEFAULT 6,
  totp_period_seconds smallint NOT NULL DEFAULT 30,
  totp_issuer         text,
  totp_account        text,

  -- Emergency-use account: reveal requires a reason, pages the on-call channel,
  -- and is reported separately in compliance exports.
  is_break_glass      boolean NOT NULL DEFAULT false,
  -- Client may see this credential exists (and its username) but never reveal
  -- it. Used for MSP-managed admin accounts on co-managed tenants.
  client_visible      boolean NOT NULL DEFAULT false,

  last_verified_at    timestamptz,
  verified_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT credential_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT credential_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT credential_node_type_pin CHECK (node_type = 'credential'),
  CONSTRAINT credential_tenant_uk UNIQUE (id, tenant_id),

  CONSTRAINT credential_secret_fk FOREIGN KEY (secret_id, tenant_id)
    REFERENCES secret (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT credential_totp_secret_fk FOREIGN KEY (totp_secret_id, tenant_id)
    REFERENCES secret (id, tenant_id) ON DELETE SET NULL,
  -- Declaratively refuses to accept anything but a TOTP seed in the TOTP slot.
  -- No referential action is possible on an FK that contains a generated
  -- column, so this one is deferred to commit: when credential_totp_secret_fk
  -- nulls totp_secret_id, totp_secret_kind regenerates to NULL and this
  -- constraint is satisfied by the time it is checked.
  CONSTRAINT credential_totp_kind_fk FOREIGN KEY (totp_secret_id, totp_secret_kind)
    REFERENCES secret (id, kind) DEFERRABLE INITIALLY DEFERRED,

  CONSTRAINT credential_totp_algorithm_known CHECK (totp_algorithm IN ('SHA1', 'SHA256', 'SHA512')),
  CONSTRAINT credential_totp_digits_range CHECK (totp_digits IN (6, 7, 8)),
  CONSTRAINT credential_totp_period_range CHECK (totp_period_seconds BETWEEN 15 AND 120),
  -- Break-glass credentials must be protected secrets, not casual ones.
  CONSTRAINT credential_break_glass_not_client_visible CHECK (
    NOT is_break_glass OR NOT client_visible
  )
);

CREATE INDEX credential_type_idx ON credential (tenant_id, credential_type);
CREATE INDEX credential_secret_idx ON credential (secret_id) WHERE secret_id IS NOT NULL;
CREATE INDEX credential_break_glass_idx ON credential (tenant_id) WHERE is_break_glass;

COMMENT ON COLUMN credential.totp_secret_kind IS
  'Generated discriminator. Exists only to carry the composite FK that pins the '
  'TOTP slot to a secret of kind totp_seed.';

-- -----------------------------------------------------------------------------
-- credential_domain — the matching rules the browser extension is allowed to
-- use for autofill.
--
-- Matching is a security boundary, not a convenience feature: an extension that
-- fills a domain admin password into the wrong origin has handed the credential
-- to whoever controls that origin. Two rules follow from that, and they are
-- enforced in the resolver (Step 3), not left to the client:
--
--   1. Matching is exact-host or registrable-domain (eTLD+1) subtree ONLY.
--      There is deliberately no regex or wildcard match type: `*.example.com`
--      style patterns written by hand reliably end up matching
--      `example.com.evil.tld`.
--   2. The extension sends the *browser-reported origin*, never a page-supplied
--      string, and the server resolves candidates. The extension never holds a
--      searchable copy of the vault.
-- -----------------------------------------------------------------------------
CREATE TABLE credential_domain (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  credential_id  uuid NOT NULL,

  -- Normalised, lowercased, punycode (never unicode) hostname. Storing unicode
  -- here would let a homograph domain match a legitimate rule.
  host           citext NOT NULL,
  match_type     domain_match_type NOT NULL DEFAULT 'exact_host',
  -- Autofill is opt-in per rule. A rule may exist for search and linking while
  -- still refusing to auto-populate a login form.
  allow_autofill boolean NOT NULL DEFAULT false,
  -- Require the technician to click before filling, even when allow_autofill.
  require_confirmation boolean NOT NULL DEFAULT true,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT credential_domain_credential_fk FOREIGN KEY (credential_id, tenant_id)
    REFERENCES credential (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT credential_domain_uk UNIQUE (credential_id, host, match_type),
  -- Punycode/ASCII hostnames only, no scheme, no path, no port, no wildcard.
  CONSTRAINT credential_domain_host_shape CHECK (
    host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  ),
  -- A bare public suffix would match every site under it.
  CONSTRAINT credential_domain_host_has_label CHECK (host ~ '\.'),
  CONSTRAINT credential_domain_autofill_needs_confirmation CHECK (
    NOT allow_autofill OR require_confirmation OR match_type = 'exact_host'
  )
);

CREATE INDEX credential_domain_lookup_idx ON credential_domain (tenant_id, host)
  WHERE allow_autofill;
CREATE INDEX credential_domain_credential_idx ON credential_domain (credential_id);

COMMENT ON TABLE credential_domain IS
  'Server-side autofill matching rules. No regex or wildcard match type exists '
  'by design; hand-written wildcard patterns are a reliable source of '
  'credential disclosure to lookalike domains.';

-- Wire the deferred pointers from 0060 that needed `credential` to exist.
ALTER TABLE domain
  ADD CONSTRAINT domain_registrar_credential_fk
  FOREIGN KEY (registrar_credential_id, tenant_id)
  REFERENCES credential (id, tenant_id) ON DELETE SET NULL;
