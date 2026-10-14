-- =============================================================================
-- 0670 — what the outside world says about a domain or a certificate
--
-- The parity item is a domain and SSL tracker that refreshes itself: RDAP for
-- registry expiry, a TLS handshake for certificate dates. This file is the
-- schema for that, and three decisions in it are worth reading before the
-- columns.
--
-- 1. OFF BY DEFAULT, PER TENANT, IN A TABLE OF ITS OWN.
--
-- Decision 4 of docs/itg-parity.md: "Opt-in, off by default, enabled in tenant
-- settings. With it off, or when egress fails, manual entry keeps working and
-- the UI shows 'last checked: never/failed' rather than erroring. An air-gapped
-- install must keep working with zero configuration."
--
-- So every column added below is nullable, every default is "never checked",
-- and an install that never turns this on is indistinguishable from today.
--
-- NOT IN tenant.settings, following 0620's rule verbatim — "a feature with a
-- rule of its own gets a table with that rule on it" — because `settings` is a
-- jsonb bag a generic PATCH would overwrite wholesale, and this feature has
-- rules: an interval with bounds, and a URL that must be https.
--
-- 2. THE PROBE NEVER OVERWRITES WHAT SOMEBODY TYPED. It writes beside it.
--
-- 0110 set the house rule for inbound data: `respect_manual_edits`, "sync must
-- never overwrite a field a technician edited by hand... inbound values only
-- fill fields that are still NULL". Applied literally here that rule defeats
-- the feature — a refresh job that only fills blanks refreshes nothing after
-- the first run, and a domain's expiry genuinely moves when it is renewed.
--
-- The way out is not to pick a winner. `domain.expires_at` stays exactly what
-- it is: the date a person recorded. The probe writes `registry_expires_at`
-- alongside it. Then
--
--   * nothing a human curated is ever destroyed, which is the rule's point;
--   * the probe still refreshes on every run, which is the feature's point;
--   * and a DISAGREEMENT becomes visible instead of silently resolved — which
--     is the most useful thing on the page. "You recorded March; the registry
--     says January" is exactly what somebody needs to know, and either
--     overwriting or blank-filling would have hidden it.
--
-- A certificate is the same shape: `not_after` is what was recorded,
-- `observed_not_after` is what the server actually served. The observed
-- fingerprint is stored too, because a fingerprint that changes between checks
-- means the certificate was replaced, which no expiry date reveals.
--
-- 3. THE CLAIM IS A ROW LOCK AND A WINDOW, NOT AN ADVISORY LOCK.
--
-- Two mechanisms, two levels, and they are easy to confuse. The worker runtime
-- gives each JOB an advisory lock key so two replicas do not run the same job
-- at once; src/workers/jobs.ts allocates them and this job takes 0b, the next
-- free value after unifi.sync's 0a. That is a different question from which
-- replica probes which domain, and 0430 settled that one:
--
--   "The guard is a row lock plus a claim window, not an advisory lock. An
--    advisory lock is held by a SESSION and vanishes if that worker dies, which
--    is the moment a half-finished poll most wants to stay claimed."
--
-- The same reasoning applies unchanged to an outbound probe that may hang for
-- its whole timeout, so `next_check_at` moves forward under FOR UPDATE SKIP
-- LOCKED and a worker that dies leaves its claim standing until it lapses.
-- =============================================================================
SET search_path = public, extensions;

-- 'unsupported' is its own answer and not a failure: a TLD with no RDAP service
-- is a permanent fact about that domain, not an error to retry hourly or to
-- show somebody in red.
DO $status_enum$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'external_check_status') THEN
    CREATE TYPE external_check_status AS ENUM ('ok', 'failed', 'unsupported');
  END IF;
END;
$status_enum$;

-- -----------------------------------------------------------------------------
-- The opt-in, one row per tenant.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS external_check_setting (
  tenant_id            uuid PRIMARY KEY REFERENCES tenant (id) ON DELETE CASCADE,

  domains_enabled      boolean NOT NULL DEFAULT false,
  certificates_enabled boolean NOT NULL DEFAULT false,

  -- How often a given domain or certificate is re-probed. Hours rather than
  -- minutes because a registry expiry moves once a year and a certificate once
  -- a quarter: a tighter interval is load on somebody else's registry for no
  -- new information.
  interval_hours       integer NOT NULL DEFAULT 24,

  -- WHERE DOMAIN NAMES GO, NEVER HIDDEN IN CODE. Enabling domain checking
  -- sends a client's domain names to whoever answers this URL, so the endpoint
  -- is a visible, editable setting with a default rather than a constant
  -- somebody has to read the source to discover. rdap.org is a community
  -- redirector that forwards to the authoritative registry for each TLD; a
  -- deployment that would rather not involve it points this at a registrar's
  -- own RDAP service or an internal mirror.
  --
  -- NOT NULL with a default, so "enabled" and "we know where to ask" cannot
  -- come apart: there is no state in which the job is on and the endpoint is
  -- unset.
  rdap_base_url        text NOT NULL DEFAULT 'https://rdap.org',

  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES app_user (id) ON DELETE SET NULL,

  CONSTRAINT external_check_interval_sane CHECK (interval_hours BETWEEN 1 AND 8760),
  -- https only, exactly as integration_connection.base_url requires. A probe
  -- that would downgrade to http is a probe whose answer can be rewritten in
  -- transit, and its answer is what a reader is being asked to trust.
  CONSTRAINT external_check_rdap_https CHECK (rdap_base_url ~ '^https://')
);

COMMENT ON TABLE external_check_setting IS
  'Per-tenant opt-in for outbound RDAP and TLS probes. Absent row means off, '
  'which is why every reader uses a LEFT JOIN and coalesce(false).';

-- -----------------------------------------------------------------------------
-- What a probe learned, beside what a person recorded.
-- -----------------------------------------------------------------------------
ALTER TABLE domain
  ADD COLUMN IF NOT EXISTS registry_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_checked_at     timestamptz,
  ADD COLUMN IF NOT EXISTS next_check_at       timestamptz,
  ADD COLUMN IF NOT EXISTS last_check_status   external_check_status,
  ADD COLUMN IF NOT EXISTS last_check_error    text;

ALTER TABLE ssl_certificate
  ADD COLUMN IF NOT EXISTS observed_not_after  timestamptz,
  -- A fingerprint that differs from the last check means the certificate was
  -- replaced, which no date comparison reveals and which is worth noticing: a
  -- renewal nobody recorded, or a server answering with something unexpected.
  ADD COLUMN IF NOT EXISTS observed_fingerprint_sha256 text,
  ADD COLUMN IF NOT EXISTS last_checked_at     timestamptz,
  ADD COLUMN IF NOT EXISTS next_check_at       timestamptz,
  ADD COLUMN IF NOT EXISTS last_check_status   external_check_status,
  ADD COLUMN IF NOT EXISTS last_check_error    text;

-- Due work, per table.
--
-- NOT PARTIAL, because NULL is a meaningful value here: `next_check_at IS NULL`
-- means never checked, which means due now. That is what makes decision 4's
-- "zero configuration" true — turning the setting on makes every existing
-- domain due on the next tick, with no backfill step to forget and no migration
-- that has to guess a first check time. A partial index excluding NULLs would
-- have hidden exactly the rows the job most needs to find.
--
-- Both indexes lead with tenant_id, so a tenant that never enables this is
-- simply never joined to: the backlog query filters on the setting first.
CREATE INDEX IF NOT EXISTS domain_check_due_idx
  ON domain (tenant_id, next_check_at);
CREATE INDEX IF NOT EXISTS ssl_certificate_check_due_idx
  ON ssl_certificate (tenant_id, next_check_at);

-- -----------------------------------------------------------------------------
-- Claiming one row to probe.
--
-- Two functions rather than one polymorphic one: the table name would have to
-- arrive as text and be interpolated, and a SECURITY DEFINER function that
-- builds SQL from an argument is the shape this schema avoids everywhere else.
--
-- SECURITY DEFINER because the worker claims across every tenant and the claim
-- must not depend on a session's org scope; the functions are granted to
-- helm_worker alone, and each takes an id the caller already found.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.claim_domain_check(
  p_domain_id uuid,
  p_claim_seconds integer DEFAULT 300
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_claimed integer;
BEGIN
  WITH candidate AS (
    SELECT d.id FROM domain d
    WHERE d.id = p_domain_id
      -- NULL is never-checked, which is due. The backlog function uses the
      -- same condition, and the two must agree or the job would hand itself
      -- rows it cannot then claim.
      AND (d.next_check_at IS NULL OR d.next_check_at <= now())
    FOR UPDATE SKIP LOCKED
  )
  UPDATE domain d
  SET next_check_at = now() + make_interval(secs => greatest(p_claim_seconds, 60))
  FROM candidate c
  WHERE d.id = c.id;

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  -- False rather than an exception: losing the race to a peer is ordinary, and
  -- raising would put every ordinary loss in the error log. 0430's reasoning.
  RETURN v_claimed = 1;
END;
$$;

CREATE OR REPLACE FUNCTION helm.claim_certificate_check(
  p_certificate_id uuid,
  p_claim_seconds integer DEFAULT 300
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_claimed integer;
BEGIN
  WITH candidate AS (
    SELECT s.id FROM ssl_certificate s
    WHERE s.id = p_certificate_id
      AND (s.next_check_at IS NULL OR s.next_check_at <= now())
    FOR UPDATE SKIP LOCKED
  )
  UPDATE ssl_certificate s
  SET next_check_at = now() + make_interval(secs => greatest(p_claim_seconds, 60))
  FROM candidate c
  WHERE s.id = c.id;

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed = 1;
END;
$$;

-- -----------------------------------------------------------------------------
-- What is due, across every tenant that asked for it.
--
-- SECURITY DEFINER and granted to the worker alone, exactly like
-- helm.unifi_poll_backlog: the worker has no tenant context and must see every
-- tenant's due rows in one pass, which is the one thing RLS is designed to
-- prevent. So the function is the boundary, it takes no tenant argument, and it
-- returns only what a probe needs — an id, a name to look up, and where to ask.
--
-- THE SETTING IS THE FILTER. A tenant with no row, or with the relevant flag
-- off, contributes nothing: an air-gapped install returns an empty backlog
-- forever and the job reports idle.
--
-- AND IT RETURNS THE TENANT'S WORKER IDENTITY, which is not a convenience.
-- helm_worker is subject to RLS like any other role, so the job cannot write to
-- `domain` with no tenant context — an UPDATE would match zero rows and report
-- success, which is exactly what the first version of this did. Every
-- enumerator in 0300 returns worker_actor_id for this reason, and the job wraps
-- its writes in withTenant() with it. 'system_sync' is the role the integration
-- sync already writes asset facts as; a tenant whose service account is missing
-- or disabled is skipped rather than silently failing.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.external_check_backlog(p_limit integer DEFAULT 25)
  RETURNS TABLE (
    kind            text,
    row_id          uuid,
    tenant_id       uuid,
    worker_actor_id uuid,
    target          text,
    rdap_base_url   text,
    interval_hours  integer
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT * FROM (
    SELECT 'domain'::text AS kind, d.id AS row_id, d.tenant_id,
           helm.worker_actor(d.tenant_id, 'system_sync') AS worker_actor_id,
           d.domain_name AS target, s.rdap_base_url, s.interval_hours
    FROM domain d
    JOIN external_check_setting s ON s.tenant_id = d.tenant_id
    WHERE s.domains_enabled
      AND (d.next_check_at IS NULL OR d.next_check_at <= now())
      AND helm.worker_actor(d.tenant_id, 'system_sync') IS NOT NULL
    UNION ALL
    SELECT 'certificate'::text, c.id, c.tenant_id,
           helm.worker_actor(c.tenant_id, 'system_sync'),
           -- The name to connect to. common_name is what a certificate is FOR,
           -- which is the only host this can honestly probe: Helm does not
           -- record where a certificate is installed as a reachable address.
           c.common_name, s.rdap_base_url, s.interval_hours
    FROM ssl_certificate c
    JOIN external_check_setting s ON s.tenant_id = c.tenant_id
    WHERE s.certificates_enabled
      AND (c.next_check_at IS NULL OR c.next_check_at <= now())
      AND helm.worker_actor(c.tenant_id, 'system_sync') IS NOT NULL
  ) due
  -- Oldest claim first is not available (NULL sorts with no date), so ordering
  -- is by id: stable, arbitrary, and fair enough for work that repeats daily.
  ORDER BY due.row_id
  LIMIT greatest(p_limit, 1);
$$;

-- =============================================================================
-- Grants and RLS
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON external_check_setting TO helm_app;
GRANT SELECT ON external_check_setting TO helm_worker;

REVOKE ALL ON FUNCTION helm.claim_domain_check(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.claim_certificate_check(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.claim_domain_check(uuid, integer) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.claim_certificate_check(uuid, integer) TO helm_worker;
REVOKE ALL ON FUNCTION helm.external_check_backlog(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.external_check_backlog(integer) TO helm_worker;

ALTER TABLE external_check_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_check_setting FORCE ROW LEVEL SECURITY;

-- Read-open within the tenant, write gated on tenant:write — the same split
-- 0620 chose for tenant_sidebar_default, and for the same reason: everybody
-- benefits from seeing whether checking is on, and turning it on is an
-- administrator's decision because it starts outbound traffic.
CREATE POLICY external_check_setting_rls_select ON external_check_setting
  FOR SELECT USING (tenant_id = helm.current_tenant_id());

CREATE POLICY external_check_setting_rls_insert ON external_check_setting
  FOR INSERT WITH CHECK (
    tenant_id = helm.require_tenant_id() AND helm.has_permission('tenant:write')
  );

CREATE POLICY external_check_setting_rls_update ON external_check_setting
  FOR UPDATE USING (tenant_id = helm.current_tenant_id())
  WITH CHECK (
    tenant_id = helm.require_tenant_id() AND helm.has_permission('tenant:write')
  );

CREATE POLICY external_check_setting_rls_delete ON external_check_setting
  FOR DELETE USING (
    tenant_id = helm.current_tenant_id() AND helm.has_permission('tenant:write')
  );

-- =============================================================================
-- Guards
-- =============================================================================
DO $external_check_guard$
DECLARE
  v_col record;
BEGIN
  -- 1. EVERY ADDED COLUMN IS NULLABLE. Decision 4's promise is that an
  --    air-gapped install keeps working with zero configuration, and a NOT NULL
  --    column with no default would break every existing row on migration — or,
  --    worse, be given a default that reads as "checked" when nothing was.
  FOR v_col IN
    SELECT c.table_name, c.column_name, c.is_nullable
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND ((c.table_name = 'domain' AND c.column_name IN
             ('registry_expires_at', 'last_checked_at', 'next_check_at',
              'last_check_status', 'last_check_error'))
        OR (c.table_name = 'ssl_certificate' AND c.column_name IN
             ('observed_not_after', 'observed_fingerprint_sha256', 'last_checked_at',
              'next_check_at', 'last_check_status', 'last_check_error')))
  LOOP
    IF v_col.is_nullable <> 'YES' THEN
      RAISE EXCEPTION 'helm: %.% must stay nullable; never-checked is the default state',
        v_col.table_name, v_col.column_name;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'domain'
        AND column_name IN ('registry_expires_at', 'last_checked_at', 'next_check_at',
                            'last_check_status', 'last_check_error')) <> 5 THEN
    RAISE EXCEPTION 'helm: domain is missing an external-check column';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ssl_certificate'
        AND column_name IN ('observed_not_after', 'observed_fingerprint_sha256',
                            'last_checked_at', 'next_check_at', 'last_check_status',
                            'last_check_error')) <> 6 THEN
    RAISE EXCEPTION 'helm: ssl_certificate is missing an external-check column';
  END IF;

  -- 2. THE RECORDED COLUMNS SURVIVE, BESIDE THE OBSERVED ONES. This is not a
  --    rename: domain.expires_at and ssl_certificate.not_after are what a
  --    person typed, and the whole design rests on both existing at once so a
  --    disagreement can be seen rather than resolved behind somebody's back.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'domain' AND column_name = 'expires_at'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ssl_certificate'
      AND column_name = 'not_after'
  ) THEN
    RAISE EXCEPTION 'helm: the hand-recorded expiry columns are gone; the probe writes BESIDE them';
  END IF;

  -- 3. AND THE EXPIRATION TRIGGERS STILL PROJECT THE RECORDED COLUMN. 0100
  --    projects domain.expires_at into `expiration`, which is what the
  --    dashboard and the alert jobs count. Pointing that at the observed value
  --    would silently change what every existing install's expiry alerts mean
  --    the moment somebody enabled checking, so it is deliberately untouched
  --    and asserted — see the decision in docs/itg-parity.md.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relname = 'domain' AND t.tgname = 'domain_expiration'
  ) THEN
    RAISE EXCEPTION 'helm: the domain expiration projection is missing';
  END IF;

  -- 4. OFF UNTIL SOMEBODY TURNS IT ON, and an absent row means off too.
  IF (SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'external_check_setting'
        AND column_name = 'domains_enabled') <> 'false' THEN
    RAISE EXCEPTION 'helm: outbound domain checking must default to off';
  END IF;
  IF (SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'external_check_setting'
        AND column_name = 'certificates_enabled') <> 'false' THEN
    RAISE EXCEPTION 'helm: outbound certificate checking must default to off';
  END IF;

  -- 4b. THE RDAP ENDPOINT IS A SETTING, NOT A CONSTANT, and it is https. A
  --     default in the schema is a default somebody can see and change in the
  --     interface; the same URL as a literal in the worker would send client
  --     domain names to a third party that nobody chose and no screen names.
  IF (SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'external_check_setting'
        AND column_name = 'rdap_base_url') IS NULL THEN
    RAISE EXCEPTION 'helm: the RDAP endpoint must have a visible default, not a constant in code';
  END IF;
  IF (SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'external_check_setting'
        AND column_name = 'rdap_base_url') <> 'NO' THEN
    RAISE EXCEPTION 'helm: domains_enabled and a known endpoint must not come apart';
  END IF;

  -- 5. THE CLAIM IS THE WORKER'S, NOT THE APPLICATION'S. helm_worker is a
  --    member of helm_app, so granting to the worker alone excludes the request
  --    role while still reaching the worker — and a claim the web tier could
  --    take is a claim a page load could steal from a running probe.
  IF has_function_privilege('helm_app', 'helm.claim_domain_check(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app can claim a domain check; only the worker should';
  END IF;
  IF NOT has_function_privilege('helm_worker', 'helm.claim_domain_check(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: the worker cannot claim a domain check';
  END IF;
  IF has_function_privilege('helm_app', 'helm.claim_certificate_check(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app can claim a certificate check; only the worker should';
  END IF;

  -- 5b. THE BACKLOG IS THE WORKER'S TOO, and it crosses tenants by design —
  --     which is precisely why helm_app must not be able to call it.
  IF has_function_privilege('helm_app', 'helm.external_check_backlog(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app can read every tenant"s due checks; only the worker should';
  END IF;
  IF NOT has_function_privilege('helm_worker', 'helm.external_check_backlog(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: the worker cannot read the external check backlog';
  END IF;

  -- 6. AND THE SETTING IS BEHIND RLS, FORCED. It names an outbound URL and
  --    decides whether traffic leaves the building; a missing policy would make
  --    it readable across tenants on a shared install.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'external_check_setting'
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'helm: external_check_setting needs RLS, forced';
  END IF;
  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relname = 'external_check_setting') <> 4 THEN
    RAISE EXCEPTION 'helm: external_check_setting needs a policy per command';
  END IF;
END;
$external_check_guard$;
