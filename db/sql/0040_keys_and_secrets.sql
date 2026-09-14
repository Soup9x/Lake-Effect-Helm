-- =============================================================================
-- 0040_keys_and_secrets.sql — key hierarchy and AES-256-GCM secret envelopes
--
--   KEK (KMS / Vault, never leaves the HSM boundary)
--    └─ DEK, one per tenant per generation, stored only in wrapped form
--        └─ AES-256-GCM ciphertext, one row per secret version
--
-- Design commitments:
--
--  * Postgres never sees a plaintext secret and never sees an unwrapped DEK.
--    Encryption and decryption happen in the application process; the database
--    stores an opaque envelope. pgcrypto is deliberately NOT used for field
--    encryption — passing a key as a SQL literal puts it in pg_stat_activity,
--    in the statement log and in any query sampler that happens to be running.
--
--  * Nonces are unique per key, enforced by a UNIQUE index rather than by
--    trusting the application's RNG. Nonce reuse under GCM is not a degraded
--    mode, it is a total break: two messages under the same (key, nonce) leak
--    their XOR and forge the authenticator. A duplicate key violation is a much
--    better outcome than a silent break.
--
--  * The AAD binds each ciphertext to tenant, secret, field and version, so a
--    ciphertext lifted from one row cannot be replayed into another. Swapping
--    the blob fails authentication instead of revealing a different client's
--    password under the attacker's chosen record.
--
--  * secret_version is append-only. Rotation writes a new version; it never
--    updates a ciphertext in place. Password history matters when you are
--    reconstructing what an offboarded technician had access to.
-- =============================================================================

SET search_path = public, extensions;

CREATE TYPE data_key_status AS ENUM ('pending', 'active', 'retiring', 'retired', 'destroyed');

CREATE TYPE secret_kind AS ENUM (
  'password', 'api_key', 'private_key', 'certificate', 'totp_seed',
  'connection_string', 'ssh_key', 'recovery_code', 'license_key', 'generic'
);

CREATE TYPE secret_sensitivity AS ENUM ('standard', 'elevated', 'critical');

-- -----------------------------------------------------------------------------
-- tenant_data_key — wrapped per-tenant DEKs.
--
-- Only helm_key_admin may write here. The application role may read the wrapped
-- blob for its own tenant (it needs it to ask KMS for an unwrap) and nothing
-- else. Compromise of the app database credentials yields wrapped keys that are
-- useless without a separate KMS authorisation.
-- -----------------------------------------------------------------------------
CREATE TABLE tenant_data_key (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  generation       integer NOT NULL,
  status           data_key_status NOT NULL DEFAULT 'pending',

  -- The DEK encrypted under the KEK. Format is provider-specific: for AWS KMS
  -- this is the CiphertextBlob from GenerateDataKey.
  wrapped_dek      bytea NOT NULL,
  wrap_provider    text NOT NULL,
  -- KEK identity *including its version*, so a KEK rotation is auditable and a
  -- stale KEK reference is detectable rather than a silent decryption failure.
  kek_id           text NOT NULL,
  -- Additional authenticated data the KMS unwrap must be given back verbatim.
  wrap_context     jsonb NOT NULL DEFAULT '{}'::jsonb,

  algorithm        text NOT NULL DEFAULT 'AES-256-GCM',

  activated_at     timestamptz,
  retiring_at      timestamptz,
  retired_at       timestamptz,
  destroyed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  rotation_reason  text,

  CONSTRAINT tenant_data_key_generation_uk UNIQUE (tenant_id, generation),
  CONSTRAINT tenant_data_key_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT tenant_data_key_generation_positive CHECK (generation > 0),
  CONSTRAINT tenant_data_key_algorithm_known CHECK (algorithm = 'AES-256-GCM'),
  CONSTRAINT tenant_data_key_provider_known CHECK (
    wrap_provider IN ('aws-kms', 'gcp-kms', 'azure-keyvault', 'vault-transit', 'local-dev')
  ),
  CONSTRAINT tenant_data_key_wrap_context_object CHECK (jsonb_typeof(wrap_context) = 'object'),
  -- A destroyed key must have been retired first: you cannot shred a key that
  -- live ciphertext still depends on.
  CONSTRAINT tenant_data_key_destroy_after_retire CHECK (
    destroyed_at IS NULL OR retired_at IS NOT NULL
  )
);

-- Exactly one key per tenant may accept new writes.
CREATE UNIQUE INDEX tenant_data_key_one_active
  ON tenant_data_key (tenant_id) WHERE status = 'active';
CREATE INDEX tenant_data_key_status_idx ON tenant_data_key (tenant_id, status);

COMMENT ON TABLE tenant_data_key IS
  'Wrapped per-tenant data encryption keys. Never contains key material in the '
  'clear; unwrapping requires a separate authorisation against KMS.';

-- -----------------------------------------------------------------------------
-- secret — the logical secret: identity, policy and pointer to current version.
-- Contains no ciphertext, so listing secrets is cheap and safe.
-- -----------------------------------------------------------------------------
CREATE TABLE secret (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  organization_id     uuid NOT NULL,

  kind                secret_kind NOT NULL,
  sensitivity         secret_sensitivity NOT NULL DEFAULT 'standard',
  label               text NOT NULL,

  current_version     integer NOT NULL DEFAULT 0,

  -- Access policy, evaluated inside helm.reveal_secret().
  requires_step_up    boolean NOT NULL DEFAULT false,
  min_role_rank       integer NOT NULL DEFAULT 40,
  -- When true the reveal API demands a non-empty justification and the audit
  -- row records it. Used for domain admin and break-glass credentials.
  requires_reason     boolean NOT NULL DEFAULT false,

  rotation_interval_days integer,
  last_rotated_at     timestamptz,
  last_accessed_at    timestamptz,
  access_count        bigint NOT NULL DEFAULT 0,

  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES app_user(id) ON DELETE SET NULL,
  deleted_at          timestamptz,

  CONSTRAINT secret_tenant_uk UNIQUE (id, tenant_id),
  -- Lets referencing tables pin the KIND of secret they accept via a
  -- composite FK, e.g. a TOTP slot that only a 'totp_seed' can fill.
  CONSTRAINT secret_kind_uk UNIQUE (id, kind),
  CONSTRAINT secret_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT secret_min_rank_range CHECK (min_role_rank BETWEEN 0 AND 100),
  CONSTRAINT secret_version_non_negative CHECK (current_version >= 0),
  CONSTRAINT secret_rotation_interval_sane CHECK (
    rotation_interval_days IS NULL OR rotation_interval_days BETWEEN 1 AND 3650
  ),
  -- Critical secrets always require step-up. Not a default — an invariant.
  CONSTRAINT secret_critical_requires_step_up CHECK (
    sensitivity <> 'critical' OR (requires_step_up AND requires_reason)
  )
);

CREATE INDEX secret_org_idx ON secret (tenant_id, organization_id)
  WHERE deleted_at IS NULL;
CREATE INDEX secret_rotation_due_idx ON secret (tenant_id, last_rotated_at)
  WHERE rotation_interval_days IS NOT NULL AND deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- secret_version — the ciphertext itself. Append-only.
-- -----------------------------------------------------------------------------
CREATE TABLE secret_version (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- tenant_id is denormalised so RLS never needs a join to decide visibility.
  -- A policy that has to join is a policy that can be defeated by a planner
  -- decision you did not anticipate.
  tenant_id          uuid NOT NULL,
  secret_id          uuid NOT NULL,
  version            integer NOT NULL,

  data_key_id        uuid NOT NULL,
  algorithm          text NOT NULL DEFAULT 'AES-256-GCM',

  ciphertext         bytea NOT NULL,
  nonce              bytea NOT NULL,
  auth_tag           bytea NOT NULL,
  -- Exact AAD string fed to the cipher. Stored so a reader can reconstruct and
  -- verify the binding without guessing the format.
  aad                text NOT NULL,

  -- HMAC of the plaintext under a per-deployment blind-index key that is NOT
  -- derived from the KEK. Enables "this password is reused across four clients"
  -- detection without storing anything that helps crack it.
  --
  -- Tradeoff, stated plainly: an attacker holding both this column and the
  -- blind-index key gains an offline verification oracle for guessed
  -- plaintexts. It is nullable; deployments that do not want the oracle simply
  -- leave HELM_BLIND_INDEX_KEY_B64 unset and get no reuse detection.
  reuse_hmac         bytea,
  -- zxcvbn score computed at write time. Metadata only, never the plaintext.
  strength_score     smallint,
  plaintext_length   smallint,

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_by_type    actor_type NOT NULL DEFAULT 'user',
  rotation_reason    text,

  CONSTRAINT secret_version_uk UNIQUE (secret_id, version),
  CONSTRAINT secret_version_secret_fk FOREIGN KEY (secret_id, tenant_id)
    REFERENCES secret (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT secret_version_key_fk FOREIGN KEY (data_key_id, tenant_id)
    REFERENCES tenant_data_key (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT secret_version_positive CHECK (version > 0),
  CONSTRAINT secret_version_algorithm_known CHECK (algorithm = 'AES-256-GCM'),
  -- 96-bit nonce and 128-bit tag: the only GCM parameters with a clean security
  -- proof and the only ones WebCrypto and Node's crypto agree on.
  CONSTRAINT secret_version_nonce_len CHECK (octet_length(nonce) = 12),
  CONSTRAINT secret_version_tag_len CHECK (octet_length(auth_tag) = 16),
  CONSTRAINT secret_version_ciphertext_nonempty CHECK (octet_length(ciphertext) > 0),
  -- 64 KiB is far more than any credential and well under the point where GCM's
  -- birthday bound matters.
  CONSTRAINT secret_version_ciphertext_bounded CHECK (octet_length(ciphertext) <= 65536),
  CONSTRAINT secret_version_reuse_hmac_len CHECK (
    reuse_hmac IS NULL OR octet_length(reuse_hmac) = 32
  ),
  CONSTRAINT secret_version_strength_range CHECK (
    strength_score IS NULL OR strength_score BETWEEN 0 AND 4
  )
);

-- The structural guarantee against GCM nonce reuse.
CREATE UNIQUE INDEX secret_version_nonce_unique_per_key
  ON secret_version (data_key_id, nonce);
COMMENT ON INDEX secret_version_nonce_unique_per_key IS
  'Makes (key, nonce) reuse a constraint violation instead of a silent '
  'catastrophic break of AES-GCM.';

CREATE INDEX secret_version_secret_idx ON secret_version (secret_id, version DESC);
CREATE INDEX secret_version_reuse_idx ON secret_version (tenant_id, reuse_hmac)
  WHERE reuse_hmac IS NOT NULL;

-- secret.current_version must point at a real version of the same secret.
-- A composite FK cannot express this, because current_version starts at the
-- sentinel 0 ("no versions written yet") which by design matches no row. A
-- deferred constraint trigger gets both properties: the sentinel is legal, and
-- a non-zero pointer is checked at COMMIT so the natural
-- insert-version-then-bump-pointer ordering works inside one transaction.
CREATE OR REPLACE FUNCTION helm.check_secret_current_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.current_version = 0 THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM secret_version sv
    WHERE sv.secret_id = NEW.id AND sv.version = NEW.current_version
  ) THEN
    RAISE EXCEPTION 'helm: secret % has no version %', NEW.id, NEW.current_version
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER secret_current_version_check
  AFTER INSERT OR UPDATE OF current_version ON secret
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION helm.check_secret_current_version();

-- -----------------------------------------------------------------------------
-- Append-only enforcement.
--
-- Revoking UPDATE/DELETE from helm_app (0220) stops the ordinary path; this
-- trigger stops every path, including a future migration run as the owner that
-- "just fixes one row".
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.deny_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'helm: % on % is not permitted; this table is append-only',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Write a new row instead. Correcting history is not a supported operation.';
END;
$$;

CREATE TRIGGER secret_version_append_only
  BEFORE UPDATE OR DELETE ON secret_version
  FOR EACH ROW EXECUTE FUNCTION helm.deny_mutation();

CREATE TRIGGER secret_touch BEFORE UPDATE ON secret
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Safe projection: everything about a secret except the material itself.
-- security_invoker so the caller's RLS applies rather than the view owner's.
-- -----------------------------------------------------------------------------
CREATE VIEW v_secret_metadata WITH (security_invoker = true, security_barrier = true) AS
SELECT
  s.id,
  s.tenant_id,
  s.organization_id,
  s.kind,
  s.sensitivity,
  s.label,
  s.current_version,
  s.requires_step_up,
  s.requires_reason,
  s.min_role_rank,
  s.rotation_interval_days,
  s.last_rotated_at,
  s.last_accessed_at,
  s.access_count,
  s.created_at,
  s.created_by,
  s.updated_at,
  CASE
    WHEN s.rotation_interval_days IS NULL THEN NULL
    ELSE coalesce(s.last_rotated_at, s.created_at)
         + (s.rotation_interval_days || ' days')::interval
  END AS rotation_due_at,
  sv.strength_score,
  sv.plaintext_length,
  sv.created_at AS current_version_created_at
FROM secret s
LEFT JOIN secret_version sv
  ON sv.secret_id = s.id AND sv.version = s.current_version
WHERE s.deleted_at IS NULL;

COMMENT ON VIEW v_secret_metadata IS
  'Listable secret surface. Contains no ciphertext, so ordinary browsing of the '
  'vault index generates no reveal audit events and leaks nothing if cached.';
