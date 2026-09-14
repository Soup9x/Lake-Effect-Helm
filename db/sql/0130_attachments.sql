-- =============================================================================
-- 0130_attachments.sql — files, notes and the offboarding/compliance export log
-- =============================================================================

SET search_path = public, extensions;

CREATE TYPE attachment_scan_status AS ENUM ('pending', 'clean', 'infected', 'failed', 'skipped');

CREATE TYPE export_kind AS ENUM (
  'client_offboarding', 'compliance_audit', 'disaster_recovery', 'asset_inventory', 'ad_hoc'
);

CREATE TYPE export_status AS ENUM ('queued', 'running', 'completed', 'failed', 'expired', 'revoked');

-- -----------------------------------------------------------------------------
-- attachment — object-store metadata. Bytes live in S3-compatible storage, not
-- in Postgres: a documentation platform accumulates network diagrams and rack
-- photos, and bloating the table that holds every RLS policy with them makes
-- backup and restore of the security-critical data slower for no benefit.
-- -----------------------------------------------------------------------------
CREATE TABLE attachment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,
  node_id          uuid,

  filename         text NOT NULL,
  content_type     text NOT NULL,
  byte_size        bigint NOT NULL,
  storage_key      text NOT NULL,
  -- sha256 of the object. Deduplicates and detects silent corruption.
  content_sha256   bytea NOT NULL,
  -- Object-store objects are encrypted with the tenant DEK before upload, so a
  -- bucket misconfiguration does not expose network diagrams and password
  -- spreadsheets that clients inevitably attach.
  data_key_id      uuid,
  encryption_nonce bytea,

  scan_status      attachment_scan_status NOT NULL DEFAULT 'pending',
  scanned_at       timestamptz,
  is_internal_only boolean NOT NULL DEFAULT false,

  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  uploaded_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,
  deleted_at       timestamptz,

  CONSTRAINT attachment_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT attachment_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT attachment_node_fk FOREIGN KEY (node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT attachment_key_fk FOREIGN KEY (data_key_id, tenant_id)
    REFERENCES tenant_data_key (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT attachment_storage_key_uk UNIQUE (storage_key),
  CONSTRAINT attachment_sha_len CHECK (octet_length(content_sha256) = 32),
  CONSTRAINT attachment_size_positive CHECK (byte_size > 0),
  CONSTRAINT attachment_nonce_len CHECK (
    encryption_nonce IS NULL OR octet_length(encryption_nonce) = 12
  ),
  CONSTRAINT attachment_encryption_paired CHECK (
    (data_key_id IS NULL) = (encryption_nonce IS NULL)
  )
);
CREATE INDEX attachment_node_idx ON attachment (node_id) WHERE deleted_at IS NULL;
CREATE INDEX attachment_org_idx ON attachment (tenant_id, organization_id)
  WHERE deleted_at IS NULL;
CREATE INDEX attachment_scan_pending_idx ON attachment (uploaded_at)
  WHERE scan_status = 'pending';

-- -----------------------------------------------------------------------------
-- note — freeform annotations against any node.
-- -----------------------------------------------------------------------------
CREATE TABLE note (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,
  node_id          uuid,

  body             text NOT NULL,
  is_internal_only boolean NOT NULL DEFAULT true,
  is_pinned        boolean NOT NULL DEFAULT false,

  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,

  CONSTRAINT note_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT note_node_fk FOREIGN KEY (node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT note_body_nonempty CHECK (btrim(body) <> '')
);
CREATE INDEX note_node_idx ON note (node_id) WHERE deleted_at IS NULL;

CREATE TRIGGER note_touch BEFORE UPDATE ON note
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- -----------------------------------------------------------------------------
-- export_job — the compliance / offboarding export engine's ledger.
--
-- An export is the single highest-risk operation in the product: it turns
-- per-record access control into one file. It is therefore its own audited
-- object with an explicit secret-inclusion decision, a mandatory reason, an
-- expiry, and a download log.
-- -----------------------------------------------------------------------------
CREATE TABLE export_job (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,

  kind             export_kind NOT NULL,
  format           text NOT NULL,
  status           export_status NOT NULL DEFAULT 'queued',

  -- Whether secret material is included. Defaults to false; turning it on is a
  -- separate, separately-permissioned, separately-audited decision.
  include_secrets  boolean NOT NULL DEFAULT false,
  scope            jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason           text NOT NULL,
  requested_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  -- Exports carrying secrets need a second human. One compromised account must
  -- not be able to walk out with the whole vault.
  approved_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,
  approved_at      timestamptz,

  storage_key      text,
  byte_size        bigint,
  content_sha256   bytea,
  -- The export archive is encrypted to a passphrase or recipient key that is
  -- delivered out of band, never stored here.
  encryption_method text,

  record_count     integer,
  secret_count     integer,
  started_at       timestamptz,
  completed_at     timestamptz,
  error            text,

  -- Exports self-destruct. A handover archive that lingers in a bucket is a
  -- breach waiting for a misconfigured ACL.
  expires_at       timestamptz NOT NULL,
  downloaded_count integer NOT NULL DEFAULT 0,
  last_downloaded_at timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT export_job_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT export_job_format_known CHECK (format IN ('pdf', 'json', 'csv', 'zip')),
  CONSTRAINT export_job_scope_object CHECK (jsonb_typeof(scope) = 'object'),
  CONSTRAINT export_job_reason_present CHECK (length(btrim(reason)) >= 10),
  CONSTRAINT export_job_secrets_need_approval CHECK (
    NOT include_secrets OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT export_job_secrets_need_encryption CHECK (
    NOT include_secrets OR status <> 'completed' OR encryption_method IS NOT NULL
  ),
  -- Approver cannot be the requester.
  CONSTRAINT export_job_four_eyes CHECK (
    approved_by IS NULL OR requested_by IS NULL OR approved_by <> requested_by
  ),
  CONSTRAINT export_job_sha_len CHECK (
    content_sha256 IS NULL OR octet_length(content_sha256) = 32
  )
);
CREATE INDEX export_job_org_idx ON export_job (tenant_id, organization_id, created_at DESC);
CREATE INDEX export_job_expiring_idx ON export_job (expires_at)
  WHERE status = 'completed' AND revoked_at IS NULL;

COMMENT ON CONSTRAINT export_job_four_eyes ON export_job IS
  'Secret-bearing exports require a second person. The single most damaging '
  'action in the product is not a single-actor operation.';

-- Every download is a separate event, not a counter bump.
CREATE TABLE export_download (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  export_job_id  uuid NOT NULL REFERENCES export_job(id) ON DELETE CASCADE,
  downloaded_at  timestamptz NOT NULL DEFAULT now(),
  downloaded_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ip             inet,
  user_agent     text
);
CREATE INDEX export_download_job_idx ON export_download (export_job_id, downloaded_at DESC);
