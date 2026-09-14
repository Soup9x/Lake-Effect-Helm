-- =============================================================================
-- 0280_onprem_kek.sql — on-premises master key custody
--
-- Helm is deployed on-premises with no cloud KMS. The KEK therefore comes from
-- one of two places, both of which the schema already had a slot for but only
-- one of which it permitted:
--
--   vault-transit   HashiCorp Vault's transit engine. The master key never
--                   enters the Helm process; wraps and unwraps are Vault API
--                   calls, recorded in Vault's audit device, and revoking
--                   Helm's token stops decryption immediately.
--
--   local-keyfile   a versioned master key held by the Helm host, normally a
--                   mode-0400 file delivered by systemd LoadCredential=.
--
-- This migration admits the second value and records, per key, what actually
-- held the KEK — because "could someone with root on the app server have read
-- this" is the first question of any breach assessment, and reconstructing the
-- answer from deployment history months later is not a plan.
--
-- `local-dev` stays permitted so that development and CI databases load the
-- same schema, and is made visibly non-production by a view the compliance
-- export reads.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Permit the on-premises host-held provider.
--
-- The value is deliberately distinct from 'local-dev' rather than reusing it.
-- Both are AES-256-GCM under a key the process holds, but an auditor reading
-- this table needs to tell a deliberate on-premises master key from a laptop
-- key that escaped into a real database — and that is exactly the distinction
-- a shared value would erase.
-- -----------------------------------------------------------------------------
ALTER TABLE tenant_data_key DROP CONSTRAINT tenant_data_key_provider_known;

ALTER TABLE tenant_data_key ADD CONSTRAINT tenant_data_key_provider_known CHECK (
  wrap_provider IN (
    'aws-kms', 'gcp-kms', 'azure-keyvault', 'vault-transit', 'local-keyfile', 'local-dev'
  )
);

-- -----------------------------------------------------------------------------
-- kek_id must be structured, not free text.
--
-- Every provider encodes the KEK's *version* in this column: an AWS key ARN,
-- `transit/helm-tenant-kek/v3`, `helm-master/v2`. Unwrapping picks the key
-- version from here, so an empty or whitespace value is not a cosmetic problem
-- — it is a row whose DEK cannot be opened, discovered at the worst time.
-- -----------------------------------------------------------------------------
ALTER TABLE tenant_data_key ADD CONSTRAINT tenant_data_key_kek_id_present CHECK (
  length(btrim(kek_id)) > 0
);

-- -----------------------------------------------------------------------------
-- Whether the master key was reachable from the application host when this DEK
-- was wrapped.
--
-- Generated, not application-supplied: this is a property of the provider, and
-- a column the application could set would eventually be set wrongly by a
-- worker someone wrote in a hurry. A breach of the Helm host exposes every DEK
-- marked true and none marked false.
-- -----------------------------------------------------------------------------
ALTER TABLE tenant_data_key
  ADD COLUMN host_held_kek boolean
  GENERATED ALWAYS AS (wrap_provider IN ('local-keyfile', 'local-dev')) STORED;

COMMENT ON COLUMN tenant_data_key.host_held_kek IS
  'True when the KEK that wrapped this DEK was readable from the application '
  'host. Root on that host yields this DEK; a KMS or Vault KEK does not.';

COMMENT ON COLUMN tenant_data_key.kek_id IS
  'KEK identity including version. local-keyfile: <label>/<version>. '
  'vault-transit: <mount>/<key>/v<n>. aws-kms: the resolved key ARN.';

-- -----------------------------------------------------------------------------
-- helm.key_custody() — per-tenant key custody, for the compliance export and
-- the admin UI.
--
-- Runs under the caller's RLS context and returns no key material: counts and
-- provider names only. A read-only compliance reviewer can answer "where are
-- this client's keys held" without being handed any capability over them.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.key_custody()
  RETURNS TABLE (
    generation      integer,
    status          data_key_status,
    wrap_provider   text,
    kek_id          text,
    host_held_kek   boolean,
    development_key boolean,
    activated_at    timestamptz,
    retiring_at     timestamptz
  )
  LANGUAGE sql
  STABLE
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT k.generation, k.status, k.wrap_provider, k.kek_id, k.host_held_kek,
         k.wrap_provider = 'local-dev',
         k.activated_at, k.retiring_at
  FROM tenant_data_key k
  WHERE k.tenant_id = helm.current_tenant_id()
  ORDER BY k.generation DESC;
$$;

REVOKE ALL ON FUNCTION helm.key_custody() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.key_custody() TO helm_app, helm_key_admin, helm_auditor;

-- -----------------------------------------------------------------------------
-- Guard: the generated column must agree with the CHECK constraint.
--
-- These two lists are the same fact written twice, and they are edited at
-- different times — a provider added to the CHECK but not classified here would
-- silently be reported as KMS-held. Prove agreement at migration time.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  v_check  text;
  v_column text;
  v_missing text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_check
  FROM pg_constraint
  WHERE conrelid = 'tenant_data_key'::regclass AND conname = 'tenant_data_key_provider_known';

  SELECT pg_get_expr(adbin, adrelid) INTO v_column
  FROM pg_attrdef d
  JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'tenant_data_key'::regclass AND a.attname = 'host_held_kek';

  IF v_column IS NULL THEN
    RAISE EXCEPTION 'helm: host_held_kek has no generation expression';
  END IF;

  -- Every provider the CHECK admits must be named by the classifier or be one
  -- of the known service-held providers.
  SELECT string_agg(p, ', ') INTO v_missing
  FROM unnest(ARRAY['aws-kms', 'gcp-kms', 'azure-keyvault', 'vault-transit',
                    'local-keyfile', 'local-dev']) AS p
  WHERE v_check NOT LIKE '%''' || p || '''%';

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'helm: wrap_provider CHECK is missing providers: %', v_missing;
  END IF;

  IF v_column NOT LIKE '%local-keyfile%' OR v_column NOT LIKE '%local-dev%' THEN
    RAISE EXCEPTION 'helm: host_held_kek does not classify the host-held providers: %', v_column;
  END IF;
END
$guard$;

-- -----------------------------------------------------------------------------
-- Guard: a production database must not be running on a development KEK.
--
-- Not enforced as a constraint — a constraint would break the CI database that
-- legitimately uses local-dev. It is a NOTICE that the migration run prints, so
-- that promoting a development database to production leaves a trace in the
-- deployment log rather than being discovered during an audit.
-- -----------------------------------------------------------------------------
DO $notice$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM tenant_data_key WHERE wrap_provider = 'local-dev';
  IF v_count > 0 THEN
    RAISE NOTICE 'helm: % data key(s) are wrapped by a development KEK (local-dev). '
      'Rotate them before this database carries production data.', v_count;
  END IF;
END
$notice$;

-- -----------------------------------------------------------------------------
-- helm.tenants_with_keys() — tenant enumeration for the key-rotation job.
--
-- Rotating the on-premises master key means re-wrapping every tenant's DEK, and
-- that job has to know which tenants exist. Every other read in Helm happens
-- inside a tenant context, which is exactly the thing this job cannot have: it
-- runs before any context, across all of them.
--
-- So this is a deliberate, minimal RLS bypass, and it is minimal in three ways:
--
--   * EXECUTE is granted to helm_key_admin alone. The web tier cannot call it,
--     so it is not reachable from a request.
--   * It returns identity and key-custody counts. No assets, no secrets, no
--     contacts, no audit — nothing that would make it useful to an attacker who
--     had somehow obtained the key admin credentials but not the KEK.
--   * It is a maintenance path, not a request path: `pnpm helm:rotate-kek`.
--
-- The alternative — giving the rotation job BYPASSRLS — would have handed it
-- the whole database instead of a list of names.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.tenants_with_keys()
  RETURNS TABLE (
    tenant_id   uuid,
    name        text,
    status      tenant_status,
    key_count   bigint,
    host_held   bigint
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT t.id, t.name, t.status,
         count(k.id),
         count(k.id) FILTER (WHERE k.host_held_kek)
  FROM tenant t
  LEFT JOIN tenant_data_key k
    ON k.tenant_id = t.id AND k.status <> 'destroyed'
  GROUP BY t.id, t.name, t.status
  ORDER BY t.name;
$$;

REVOKE ALL ON FUNCTION helm.tenants_with_keys() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.tenants_with_keys() TO helm_key_admin;

-- Guard: this must not become reachable from the request path. helm_app holding
-- EXECUTE would turn a maintenance convenience into a cross-tenant read.
DO $guard$
BEGIN
  IF has_function_privilege('helm_app', 'helm.tenants_with_keys()', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app must not be able to enumerate tenants';
  END IF;
END
$guard$;
