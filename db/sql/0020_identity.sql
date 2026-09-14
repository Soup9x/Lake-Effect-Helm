-- =============================================================================
-- 0020_identity.sql — users, Auth.js tables, RBAC, service accounts, API tokens
--
-- Identity shape: a *user* is global to the deployment (one email, one login),
-- and a *membership* grants that user a role plus an organisation scope inside
-- one tenant. A Tier 2 tech at the MSP and a co-managed client administrator are
-- the same kind of row with different role and scope.
--
-- The auth_* tables are owned by the helm_auth role and are unreachable from
-- helm_app (see 0220). Session tokens and OAuth refresh tokens are the crown
-- jewels of an account-takeover attack; the application that renders client
-- documentation has no business being able to SELECT them.
-- =============================================================================

SET search_path = public, extensions;

CREATE TYPE actor_type AS ENUM ('user', 'service_account', 'system', 'integration');

CREATE TYPE membership_status AS ENUM ('invited', 'active', 'suspended', 'revoked');

CREATE TYPE api_token_type AS ENUM ('service_account', 'user_pat', 'browser_extension');

-- -----------------------------------------------------------------------------
-- RBAC vocabulary
--
-- `rank` exists so RLS policies can make cheap coarse checks
-- ("at least Tier 2"). Anything finer than that belongs in `permission` and is
-- checked with helm.has_permission(), because rank comparisons quietly grant
-- new capabilities to every senior role the moment you add one.
-- -----------------------------------------------------------------------------
CREATE TABLE app_role (
  key            text PRIMARY KEY,
  name           text NOT NULL,
  description    text NOT NULL,
  rank           integer NOT NULL,
  -- Tenant-wide roles are MSP staff; scoped roles are client-side users who
  -- must be pinned to specific organisations.
  is_tenant_wide boolean NOT NULL DEFAULT false,
  is_system      boolean NOT NULL DEFAULT true,

  CONSTRAINT app_role_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  CONSTRAINT app_role_rank_range CHECK (rank BETWEEN 0 AND 100)
);

CREATE TABLE permission (
  key          text PRIMARY KEY,
  category     text NOT NULL,
  description  text NOT NULL,
  -- Permissions that must never be granted to a client-side role, enforced by
  -- a trigger below rather than by convention.
  msp_only     boolean NOT NULL DEFAULT false,

  CONSTRAINT permission_key_shape CHECK (key ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$')
);

CREATE TABLE role_permission (
  role_key       text NOT NULL REFERENCES app_role(key) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permission(key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);

CREATE OR REPLACE FUNCTION helm.enforce_msp_only_permission() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_msp_only boolean;
  v_tenant_wide boolean;
BEGIN
  SELECT msp_only INTO v_msp_only FROM permission WHERE key = NEW.permission_key;
  SELECT is_tenant_wide INTO v_tenant_wide FROM app_role WHERE key = NEW.role_key;
  IF v_msp_only AND NOT v_tenant_wide THEN
    RAISE EXCEPTION 'helm: permission % is MSP-only and cannot be granted to client-side role %',
      NEW.permission_key, NEW.role_key
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER role_permission_msp_guard
  BEFORE INSERT OR UPDATE ON role_permission
  FOR EACH ROW EXECUTE FUNCTION helm.enforce_msp_only_permission();

-- -----------------------------------------------------------------------------
-- Auth.js v5 core tables
--
-- Column names match what @auth/drizzle-adapter expects; only the table names
-- are Helm-flavoured (the adapter takes explicit table references).
-- -----------------------------------------------------------------------------
CREATE TABLE app_user (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL UNIQUE,
  email_verified    timestamptz,
  name              text,
  image             text,

  -- Helm additions
  is_platform_admin boolean NOT NULL DEFAULT false,
  mfa_enrolled_at   timestamptz,
  last_login_at     timestamptz,
  disabled_at       timestamptz,
  disabled_reason   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT app_user_email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);
COMMENT ON COLUMN app_user.is_platform_admin IS
  'Deployment-level break-glass. Does NOT bypass RLS — the holder still needs a '
  'membership to read tenant data. It only gates deployment administration.';

CREATE TABLE auth_account (
  user_id             uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  type                text NOT NULL,
  provider            text NOT NULL,
  provider_account_id text NOT NULL,
  refresh_token       text,
  access_token        text,
  expires_at          bigint,
  token_type          text,
  scope               text,
  id_token            text,
  session_state       text,
  PRIMARY KEY (provider, provider_account_id)
);
CREATE INDEX auth_account_user_idx ON auth_account (user_id);

CREATE TABLE auth_session (
  session_token text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires       timestamptz NOT NULL
);
CREATE INDEX auth_session_user_idx ON auth_session (user_id);
CREATE INDEX auth_session_expires_idx ON auth_session (expires);

CREATE TABLE auth_verification_token (
  identifier text NOT NULL,
  token      text NOT NULL,
  expires    timestamptz NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- WebAuthn / passkeys. Strongly preferred over TOTP for MSP staff: a phishing
-- page cannot replay a passkey assertion, and these are the accounts that hold
-- every client's credentials.
CREATE TABLE auth_authenticator (
  credential_id          text NOT NULL UNIQUE,
  user_id                uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  provider_account_id    text NOT NULL,
  credential_public_key  text NOT NULL,
  counter                bigint NOT NULL,
  credential_device_type text NOT NULL,
  credential_backed_up   boolean NOT NULL,
  transports             text,
  friendly_name          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_used_at           timestamptz,
  PRIMARY KEY (user_id, credential_id)
);

-- -----------------------------------------------------------------------------
-- membership — the join that actually grants access to a tenant.
-- -----------------------------------------------------------------------------
CREATE TABLE membership (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_key         text NOT NULL REFERENCES app_role(key) ON DELETE RESTRICT,
  status           membership_status NOT NULL DEFAULT 'active',

  -- Organisation scope. Explicit boolean rather than "NULL means everything",
  -- because a NULL that means "all access" is one accidental outer join away
  -- from being a breach.
  org_scope_all    boolean NOT NULL DEFAULT false,
  org_scope        uuid[],

  require_step_up  boolean NOT NULL DEFAULT true,
  expires_at       timestamptz,
  invited_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revoked_reason   text,

  CONSTRAINT membership_user_tenant_uk UNIQUE (tenant_id, user_id),
  CONSTRAINT membership_scope_exclusive CHECK (
    (org_scope_all AND org_scope IS NULL)
    OR (NOT org_scope_all AND org_scope IS NOT NULL AND cardinality(org_scope) > 0)
  )
);
CREATE INDEX membership_user_idx ON membership (user_id) WHERE status = 'active';
CREATE INDEX membership_tenant_idx ON membership (tenant_id, status);

-- Per-user deviations from the role's baseline. `granted = false` is a DENY and
-- wins over the role grant, so revoking one dangerous capability from one person
-- does not require inventing a whole new role.
CREATE TABLE membership_permission (
  membership_id  uuid NOT NULL REFERENCES membership(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permission(key) ON DELETE CASCADE,
  granted        boolean NOT NULL,
  reason         text NOT NULL,
  granted_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  PRIMARY KEY (membership_id, permission_key)
);

-- -----------------------------------------------------------------------------
-- service_account — machine identity for RMM/PSA sync and the browser extension
-- backend. Distinct from app_user so that "who did this" is never ambiguous in
-- the audit log.
-- -----------------------------------------------------------------------------
CREATE TABLE service_account (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name           text NOT NULL,
  description    text,
  role_key       text NOT NULL REFERENCES app_role(key) ON DELETE RESTRICT,
  org_scope_all  boolean NOT NULL DEFAULT false,
  org_scope      uuid[],
  created_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz,

  CONSTRAINT service_account_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT service_account_name_uk UNIQUE (tenant_id, name),
  CONSTRAINT service_account_scope_exclusive CHECK (
    (org_scope_all AND org_scope IS NULL)
    OR (NOT org_scope_all AND org_scope IS NOT NULL AND cardinality(org_scope) > 0)
  )
);

-- -----------------------------------------------------------------------------
-- api_token — bearer credentials.
--
-- We store sha256(token) and an 8-character lookup prefix. The token itself is
-- returned exactly once, at creation, and is never recoverable. Verification is
-- prefix lookup followed by a constant-time digest comparison.
-- -----------------------------------------------------------------------------
CREATE TABLE api_token (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  token_type         api_token_type NOT NULL,

  service_account_id uuid REFERENCES service_account(id) ON DELETE CASCADE,
  user_id            uuid REFERENCES app_user(id) ON DELETE CASCADE,

  name               text NOT NULL,
  token_prefix       text NOT NULL,
  token_hash         bytea NOT NULL,
  -- Token-level narrowing. Effective permission = role ∩ scopes.
  scopes             text[] NOT NULL DEFAULT '{}',
  ip_allowlist       inet[],

  last_used_at       timestamptz,
  last_used_ip       inet,
  use_count          bigint NOT NULL DEFAULT 0,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,
  created_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT api_token_prefix_uk UNIQUE (token_prefix),
  CONSTRAINT api_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT api_token_prefix_shape CHECK (token_prefix ~ '^helm_[a-z]{2}_[A-Za-z0-9]{8}$'),
  -- Exactly one subject.
  CONSTRAINT api_token_one_subject CHECK (
    (service_account_id IS NOT NULL)::int + (user_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT api_token_subject_matches_type CHECK (
    (token_type = 'service_account' AND service_account_id IS NOT NULL)
    OR (token_type IN ('user_pat', 'browser_extension') AND user_id IS NOT NULL)
  )
);
CREATE INDEX api_token_lookup_idx ON api_token (token_prefix)
  WHERE revoked_at IS NULL;
CREATE INDEX api_token_subject_idx ON api_token (tenant_id, service_account_id, user_id);

-- -----------------------------------------------------------------------------
-- browser_extension_install — a registered Chrome/Edge extension instance.
--
-- The extension never receives a long-lived credential. It registers a device
-- public key; the autofill API issues short-lived reveal tokens bound to that
-- key, so a stolen extension storage blob is not a permanent vault key.
-- -----------------------------------------------------------------------------
CREATE TABLE browser_extension_install (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  api_token_id      uuid REFERENCES api_token(id) ON DELETE SET NULL,

  device_label      text NOT NULL,
  device_public_key bytea NOT NULL,
  browser           text,
  extension_version text,

  approved_at       timestamptz,
  approved_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  last_seen_at      timestamptz,
  last_seen_ip      inet,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT extension_device_key_uk UNIQUE (user_id, device_public_key)
);

-- -----------------------------------------------------------------------------
-- step_up_verification — proof of a recent strong re-authentication.
-- Consulted before revealing any secret flagged requires_step_up.
-- -----------------------------------------------------------------------------
CREATE TABLE step_up_verification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  method      text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  request_id  text,
  ip          inet,

  CONSTRAINT step_up_method_known CHECK (method IN ('webauthn', 'totp', 'password', 'sso_reauth')),
  CONSTRAINT step_up_window_valid CHECK (expires_at > verified_at)
);
CREATE INDEX step_up_active_idx ON step_up_verification (user_id, expires_at DESC);

CREATE TRIGGER app_user_touch        BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();
CREATE TRIGGER membership_touch      BEFORE UPDATE ON membership
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();
CREATE TRIGGER service_account_touch BEFORE UPDATE ON service_account
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- Wire the deferred organization FKs now that app_user exists.
ALTER TABLE organization
  ADD CONSTRAINT organization_account_manager_fk
  FOREIGN KEY (account_manager_id) REFERENCES app_user(id) ON DELETE SET NULL;

ALTER TABLE contact
  ADD CONSTRAINT contact_app_user_fk
  FOREIGN KEY (app_user_id) REFERENCES app_user(id) ON DELETE SET NULL;
