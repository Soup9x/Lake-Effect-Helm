-- =============================================================================
-- 1040 — profile pictures
--
-- A person's picture, shown beside their name: the account menu, the People
-- page, their own Profile page. Built on 0680's client logo, deliberately the
-- same in every way that matters:
--
--   RASTER ONLY. PNG, JPEG, WebP or GIF, sniffed from the bytes on upload and
--   checked again here. An SVG served from Helm's origin can run script with
--   the reader's session, and a profile picture is exactly the kind of thing
--   that "is only an image".
--
--   ENCRYPTED under the tenant's data key before it reaches the disk, bound to
--   the person by the AAD. A face is personal data, and an unencrypted file in
--   a backup is a photograph of a named member of staff.
--
-- PER MEMBERSHIP, NOT PER ACCOUNT. app_user spans tenants and each tenant has
-- its own data key, so the picture lives with the membership it is shown in
-- and goes when that membership does. On the common one-tenant install the
-- difference is invisible.
--
-- WHO MAY DO WHAT:
--   * everybody in the tenant may SEE it — the name beside it is already shown
--     to them, on every row somebody changed;
--   * only the person, signed in as themselves, may set, replace or remove it.
--     An administrator who needs one gone removes the membership or asks; an
--     API token or a service account matches nothing (actor_type is not 'user').
-- =============================================================================

SET search_path = public, extensions;

CREATE TABLE member_avatar (
  tenant_id        uuid NOT NULL,
  user_id          uuid NOT NULL,

  content_type     text   NOT NULL,
  byte_size        bigint NOT NULL,
  storage_key      text   NOT NULL,
  -- The ETag, and the cache-busting version in every URL that shows it.
  content_sha256   bytea  NOT NULL,

  data_key_id      uuid   NOT NULL,
  encryption_nonce bytea  NOT NULL,

  uploaded_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT member_avatar_pk PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT member_avatar_member_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES membership (tenant_id, user_id) ON DELETE CASCADE,
  CONSTRAINT member_avatar_key_fk FOREIGN KEY (data_key_id, tenant_id)
    REFERENCES tenant_data_key (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT member_avatar_storage_key_uk UNIQUE (storage_key),
  CONSTRAINT member_avatar_sha_len CHECK (octet_length(content_sha256) = 32),
  CONSTRAINT member_avatar_size CHECK (byte_size > 0 AND byte_size <= 524288),
  CONSTRAINT member_avatar_nonce_len CHECK (octet_length(encryption_nonce) = 12),
  CONSTRAINT member_avatar_raster_only CHECK (
    content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  )
);

COMMENT ON TABLE member_avatar IS
  'A member''s profile picture (1040). Seen by the tenant, set only by the member. Encrypted '
  'under the tenant data key; raster formats only.';

ALTER TABLE member_avatar ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_avatar FORCE ROW LEVEL SECURITY;

CREATE POLICY member_avatar_select ON member_avatar
  FOR SELECT TO helm_app
  USING (tenant_id = helm.current_tenant_id());

CREATE POLICY member_avatar_insert ON member_avatar
  FOR INSERT TO helm_app
  WITH CHECK (
    tenant_id = helm.current_tenant_id()
    AND helm.current_actor_type() = 'user'
    AND user_id = helm.current_actor_id()
  );

CREATE POLICY member_avatar_update ON member_avatar
  FOR UPDATE TO helm_app
  USING (
    tenant_id = helm.current_tenant_id()
    AND helm.current_actor_type() = 'user'
    AND user_id = helm.current_actor_id()
  )
  WITH CHECK (
    tenant_id = helm.current_tenant_id()
    AND helm.current_actor_type() = 'user'
    AND user_id = helm.current_actor_id()
  );

CREATE POLICY member_avatar_delete ON member_avatar
  FOR DELETE TO helm_app
  USING (
    tenant_id = helm.current_tenant_id()
    AND helm.current_actor_type() = 'user'
    AND user_id = helm.current_actor_id()
  );

-- Pictures are chrome: the auditor and the auth role have no business with
-- them. helm_worker inherits helm_app by membership, and only ever acts as a
-- service account, so the write policies above keep it out.
REVOKE ALL ON member_avatar FROM PUBLIC, helm_worker, helm_auditor, helm_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON member_avatar TO helm_app;

-- -----------------------------------------------------------------------------
-- Guards.
-- -----------------------------------------------------------------------------
DO $guard$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'member_avatar') <> 4 THEN
    RAISE EXCEPTION '1040: member_avatar needs exactly one policy per command';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'member_avatar' AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
      AND coalesce(with_check, qual) NOT LIKE '%current_actor_type()%''user''%'
  ) THEN
    RAISE EXCEPTION '1040: a write policy on member_avatar no longer requires the person themselves';
  END IF;
  IF has_table_privilege('helm_auditor', 'member_avatar', 'SELECT')
     OR has_table_privilege('helm_auth', 'member_avatar', 'SELECT') THEN
    RAISE EXCEPTION '1040: the auditor or the auth role can read profile pictures';
  END IF;
END
$guard$;
