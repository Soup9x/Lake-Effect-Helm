-- =============================================================================
-- 0140_audit.sql — tamper-evident, append-only audit log
--
-- "Immutable" is a strong word, and worth being precise about what is and is
-- not achieved here.
--
-- WHAT THIS GIVES YOU:
--   * No application role can UPDATE or DELETE an audit row. Enforced twice:
--     revoked privileges (0220) and a trigger that fires regardless of role.
--   * Rows are chained: each row's hash covers the previous row's hash, per
--     tenant. Altering or removing any historical row breaks every subsequent
--     link, and helm.verify_audit_chain() finds the exact break point.
--   * Monthly range partitions, so retention is a DETACH rather than a DELETE
--     of millions of rows (and a DELETE is what an attacker would need).
--
-- WHAT IT DOES NOT GIVE YOU:
--   * Protection from someone with superuser or filesystem access, who can
--     disable triggers and recompute the chain. Tamper *evidence* requires the
--     chain head to be witnessed somewhere Postgres cannot reach — periodically
--     anchor helm.audit_chain_head to WORM storage (HELM_AUDIT_MIRROR_BUCKET).
--     That is an operational control, and the schema is built to support it.
-- =============================================================================

SET search_path = public, extensions;

CREATE TYPE audit_outcome AS ENUM ('success', 'denied', 'error');

-- -----------------------------------------------------------------------------
-- audit_log — partitioned by month on occurred_at.
--
-- The partition key must be in the primary key, hence (id, occurred_at).
-- event_uid is the stable external identifier used by other tables.
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  event_uid       uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  tenant_id       uuid NOT NULL,

  -- Actor, denormalised. A deleted user must not erase the record of what they
  -- did, so we keep a label rather than relying on a join that can go NULL.
  actor_type      actor_type NOT NULL,
  actor_id        uuid,
  actor_label     text NOT NULL,
  actor_role_key  text,
  api_token_id    uuid,

  action          text NOT NULL,
  outcome         audit_outcome NOT NULL DEFAULT 'success',

  entity_type     text,
  entity_id       uuid,
  organization_id uuid,
  node_id         uuid,

  -- Justification, where the action demanded one (break-glass reveal, export).
  reason          text,
  -- Non-sensitive detail: which fields changed, how many records, the query
  -- shape. NEVER secret material — see the trigger below.
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

  request_id      text,
  session_id      text,
  ip              inet,
  user_agent      text,

  -- Hash chain, per tenant.
  chain_seq       bigint NOT NULL,
  prev_hash       bytea NOT NULL,
  row_hash        bytea NOT NULL,

  PRIMARY KEY (id, occurred_at),
  CONSTRAINT audit_log_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT audit_log_action_shape CHECK (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  CONSTRAINT audit_log_hash_len CHECK (
    octet_length(prev_hash) = 32 AND octet_length(row_hash) = 32
  ),
  CONSTRAINT audit_log_actor_identified CHECK (
    actor_type = 'system' OR actor_id IS NOT NULL
  )
) PARTITION BY RANGE (occurred_at);

CREATE INDEX audit_log_tenant_time_idx ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (tenant_id, actor_id, occurred_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (tenant_id, action, occurred_at DESC);
CREATE INDEX audit_log_org_idx ON audit_log (tenant_id, organization_id, occurred_at DESC)
  WHERE organization_id IS NOT NULL;
CREATE INDEX audit_log_event_uid_idx ON audit_log (event_uid);
CREATE UNIQUE INDEX audit_log_chain_idx ON audit_log (tenant_id, chain_seq, occurred_at);

COMMENT ON COLUMN audit_log.metadata IS
  'Non-sensitive detail only. A trigger rejects obvious secret-bearing keys, but '
  'the real guarantee is that the reveal API writes metadata itself and never '
  'passes plaintext through.';

-- -----------------------------------------------------------------------------
-- audit_chain_head — the tip of each tenant's chain.
--
-- Also the serialisation point: the insert trigger takes a row lock here, which
-- is what makes chain_seq gap-free and the chain well-ordered under concurrency.
-- The cost is that audit writes for one tenant serialise. At MSP volumes
-- (thousands of events a day, not millions a second) that is the right trade
-- for a chain that actually proves something.
--
-- This table is the thing to mirror to WORM storage: it is one small row per
-- tenant and it commits the entire history.
-- -----------------------------------------------------------------------------
CREATE TABLE audit_chain_head (
  tenant_id     uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE RESTRICT,
  chain_seq     bigint NOT NULL DEFAULT 0,
  head_hash     bytea NOT NULL DEFAULT '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Set by the anchoring job once the head has been witnessed externally.
  anchored_seq  bigint NOT NULL DEFAULT 0,
  anchored_at   timestamptz,
  anchor_ref    text,

  CONSTRAINT audit_chain_head_hash_len CHECK (octet_length(head_hash) = 32),
  CONSTRAINT audit_chain_head_anchor_not_ahead CHECK (anchored_seq <= chain_seq)
);

-- -----------------------------------------------------------------------------
-- Partition management.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.ensure_audit_partition(p_month date)
  RETURNS text
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('audit_log_%s', to_char(v_start, 'YYYY_MM'));
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = v_name AND n.nspname = 'public'
  ) THEN
    RETURN v_name;
  END IF;

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
    v_name, v_start, v_end
  );

  -- RLS policies are not inherited by partitions. Queries through the parent
  -- use the parent's policies, but a direct query against a partition uses the
  -- partition's own — so each one gets RLS enabled and the same policy applied
  -- (see helm.apply_audit_partition_rls, defined in 0200).
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', v_name);

  RETURN v_name;
END;
$$;

-- Keep a rolling window of partitions so an insert never lands on a missing one.
CREATE OR REPLACE FUNCTION helm.maintain_audit_partitions(p_months_ahead integer DEFAULT 3)
  RETURNS SETOF text
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  i integer;
BEGIN
  FOR i IN -1 .. p_months_ahead LOOP
    RETURN NEXT helm.ensure_audit_partition((current_date + (i || ' months')::interval)::date);
  END LOOP;
END;
$$;

SELECT helm.maintain_audit_partitions(3);

-- -----------------------------------------------------------------------------
-- The chain.
--
-- row_hash = sha256(prev_hash || canonical(row))
--
-- The canonical serialisation is pinned field-by-field rather than derived from
-- to_jsonb(NEW): a future ALTER TABLE adding a column would silently change
-- every hash computed afterwards and make the chain unverifiable across the
-- schema change.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.audit_canonical_form(p_row audit_log)
  RETURNS bytea
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT convert_to(
    concat_ws(E'\x1f',
      p_row.event_uid::text,
      to_char(p_row.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
      p_row.tenant_id::text,
      p_row.actor_type::text,
      coalesce(p_row.actor_id::text, ''),
      p_row.actor_label,
      coalesce(p_row.actor_role_key, ''),
      coalesce(p_row.api_token_id::text, ''),
      p_row.action,
      p_row.outcome::text,
      coalesce(p_row.entity_type, ''),
      coalesce(p_row.entity_id::text, ''),
      coalesce(p_row.organization_id::text, ''),
      coalesce(p_row.node_id::text, ''),
      coalesce(p_row.reason, ''),
      -- Key-sorted canonical JSON; jsonb's own ordering is already canonical.
      p_row.metadata::text,
      coalesce(p_row.request_id, ''),
      coalesce(p_row.session_id, ''),
      coalesce(host(p_row.ip), ''),
      coalesce(p_row.user_agent, ''),
      p_row.chain_seq::text
    ), 'UTF8');
$$;

CREATE OR REPLACE FUNCTION helm.audit_chain_link() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_head audit_chain_head%ROWTYPE;
BEGIN
  -- Create the head row if this is the tenant's first event, then lock it. The
  -- lock is what serialises concurrent audit writes for this tenant and makes
  -- chain_seq contiguous.
  INSERT INTO audit_chain_head (tenant_id) VALUES (NEW.tenant_id)
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT * INTO v_head FROM audit_chain_head
  WHERE tenant_id = NEW.tenant_id FOR UPDATE;

  NEW.chain_seq := v_head.chain_seq + 1;
  NEW.prev_hash := v_head.head_hash;
  NEW.row_hash  := digest(v_head.head_hash || helm.audit_canonical_form(NEW), 'sha256');

  UPDATE audit_chain_head
  SET chain_seq = NEW.chain_seq,
      head_hash = NEW.row_hash,
      updated_at = now()
  WHERE tenant_id = NEW.tenant_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION helm.audit_chain_link();

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION helm.deny_mutation();

-- Secret material must never reach the audit log. The reveal API constructs
-- metadata itself, but the log is written from many call sites and this is the
-- one place a mistake becomes permanent and widely-read.
CREATE OR REPLACE FUNCTION helm.reject_secret_bearing_metadata() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_forbidden text[] := ARRAY[
    'password', 'plaintext', 'secret_value', 'ciphertext', 'private_key',
    'totp_seed', 'api_key', 'client_secret', 'refresh_token', 'dek', 'key_material'
  ];
  v_key text;
BEGIN
  FOREACH v_key IN ARRAY v_forbidden LOOP
    IF NEW.metadata ? v_key THEN
      RAISE EXCEPTION 'helm: audit metadata must not contain a % field', v_key
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_no_secrets
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION helm.reject_secret_bearing_metadata();

-- -----------------------------------------------------------------------------
-- helm.audit() — the single supported way to write an audit row.
--
-- SECURITY DEFINER so helm_app can append without holding INSERT on the table
-- directly; combined with the revoked UPDATE/DELETE this means the application
-- can add to history and do nothing else to it.
--
-- Actor and request metadata come from the session context, not from arguments,
-- so a caller cannot attribute their action to somebody else.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.audit(
  p_action          text,
  p_entity_type     text    DEFAULT NULL,
  p_entity_id       uuid    DEFAULT NULL,
  p_outcome         audit_outcome DEFAULT 'success',
  p_organization_id uuid    DEFAULT NULL,
  p_node_id         uuid    DEFAULT NULL,
  p_reason          text    DEFAULT NULL,
  p_metadata        jsonb   DEFAULT '{}'::jsonb
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_event_uid uuid;
  v_tenant    uuid := helm.current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'helm: cannot write an audit event without a tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO audit_log (
    tenant_id, actor_type, actor_id, actor_label, actor_role_key, api_token_id,
    action, outcome, entity_type, entity_id, organization_id, node_id,
    reason, metadata, request_id, ip, user_agent,
    chain_seq, prev_hash, row_hash
  )
  VALUES (
    v_tenant,
    helm.current_actor_type()::actor_type,
    helm.current_actor_id(),
    coalesce(nullif(current_setting('helm.actor_label', true), ''), 'unknown'),
    nullif(helm.current_role_key(), 'anonymous'),
    nullif(current_setting('helm.api_token_id', true), '')::uuid,
    p_action, p_outcome, p_entity_type, p_entity_id, p_organization_id, p_node_id,
    p_reason, coalesce(p_metadata, '{}'::jsonb),
    helm.current_request_id(), helm.current_ip(), helm.current_user_agent(),
    -- Overwritten by the chain trigger; NOT NULL demands a placeholder.
    0, '\x00'::bytea, '\x00'::bytea
  )
  RETURNING event_uid INTO v_event_uid;

  RETURN v_event_uid;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.verify_audit_chain() — walks a tenant's chain and reports the first
-- break. This is the function a compliance auditor actually runs.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.verify_audit_chain(
  p_tenant_id uuid,
  p_from      timestamptz DEFAULT NULL,
  p_to        timestamptz DEFAULT NULL
) RETURNS TABLE (
  verified_rows bigint,
  first_seq     bigint,
  last_seq      bigint,
  is_intact     boolean,
  broken_at_seq bigint,
  broken_event_uid uuid,
  detail        text
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  -- Must be %ROWTYPE, not `record`: helm.audit_canonical_form takes the table's
  -- composite type, and plpgsql cannot cast an anonymous record to it.
  r             audit_log%ROWTYPE;
  v_expected    bytea := NULL;
  v_count       bigint := 0;
  v_first       bigint := NULL;
  v_last        bigint := NULL;
  v_prev_seq    bigint := NULL;
BEGIN
  -- An auditor may only verify a tenant they are in.
  IF helm.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'helm: cannot verify the audit chain of another tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR r IN
    SELECT a.* FROM audit_log a
    WHERE a.tenant_id = p_tenant_id
      AND (p_from IS NULL OR a.occurred_at >= p_from)
      AND (p_to   IS NULL OR a.occurred_at <  p_to)
    ORDER BY a.chain_seq
  LOOP
    v_count := v_count + 1;
    IF v_first IS NULL THEN
      v_first := r.chain_seq;
      -- Starting mid-chain: adopt this row's prev_hash as the baseline rather
      -- than claiming a break that is really just a windowed query.
      v_expected := r.prev_hash;
    END IF;

    IF v_prev_seq IS NOT NULL AND r.chain_seq <> v_prev_seq + 1 THEN
      RETURN QUERY SELECT v_count, v_first, v_prev_seq, false, r.chain_seq, r.event_uid,
        format('sequence gap: %s followed by %s — row(s) removed', v_prev_seq, r.chain_seq);
      RETURN;
    END IF;

    IF r.prev_hash IS DISTINCT FROM v_expected THEN
      RETURN QUERY SELECT v_count, v_first, v_prev_seq, false, r.chain_seq, r.event_uid,
        'prev_hash does not match the preceding row_hash';
      RETURN;
    END IF;

    IF digest(r.prev_hash || helm.audit_canonical_form(r), 'sha256') IS DISTINCT FROM r.row_hash THEN
      RETURN QUERY SELECT v_count, v_first, v_prev_seq, false, r.chain_seq, r.event_uid,
        'row_hash does not match the row contents — this row was modified';
      RETURN;
    END IF;

    v_expected := r.row_hash;
    v_prev_seq := r.chain_seq;
    v_last := r.chain_seq;
  END LOOP;

  RETURN QUERY SELECT v_count, v_first, v_last, true, NULL::bigint, NULL::uuid,
    CASE WHEN v_count = 0 THEN 'no audit rows in range' ELSE 'chain intact' END;
END;
$$;

REVOKE ALL ON FUNCTION helm.audit(text, text, uuid, audit_outcome, uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.audit(text, text, uuid, audit_outcome, uuid, uuid, text, jsonb)
  TO helm_app, helm_key_admin;
REVOKE ALL ON FUNCTION helm.verify_audit_chain(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.verify_audit_chain(uuid, timestamptz, timestamptz)
  TO helm_app, helm_auditor;
GRANT EXECUTE ON FUNCTION helm.maintain_audit_partitions(integer) TO helm_key_admin;
