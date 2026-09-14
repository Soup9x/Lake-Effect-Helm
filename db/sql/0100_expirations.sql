-- =============================================================================
-- 0100_expirations.sql — one pane of glass for everything that expires
--
-- The naive version of this feature is a UNION over eight tables, re-run on
-- every dashboard load, across every client. It is slow, and worse, it silently
-- misses anything added later that nobody remembered to add to the UNION.
--
-- Instead, expirations are PROJECTED into one narrow table by triggers on each
-- source. The dashboard becomes a single indexed range scan, and adding a new
-- expiring thing is one CREATE TRIGGER using the generic projector below.
--
-- The projection is derived data: the source column remains the truth, and
-- helm.rebuild_expirations() can reconstruct the table from scratch, so a
-- missed trigger is a recoverable bug rather than lost data.
-- =============================================================================

SET search_path = public, extensions;

CREATE TYPE expiration_kind AS ENUM (
  'ssl_certificate', 'domain_registration', 'device_warranty', 'device_eol',
  'license', 'contract', 'isp_contract', 'credential_rotation',
  'api_token', 'sop_review', 'data_key_rotation'
);

CREATE TYPE alert_severity AS ENUM ('info', 'notice', 'warning', 'critical', 'expired');

CREATE TABLE expiration (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,

  kind             expiration_kind NOT NULL,
  -- The graph node this expiry belongs to, when there is one. Some kinds
  -- (api_token, data_key_rotation) are tenant infrastructure with no node.
  node_id          uuid,
  source_table     text NOT NULL,
  source_id        uuid NOT NULL,

  label            text NOT NULL,
  expires_at       timestamptz NOT NULL,
  auto_renew       boolean NOT NULL DEFAULT false,
  criticality      smallint NOT NULL DEFAULT 3,

  acknowledged_at  timestamptz,
  acknowledged_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  acknowledged_until timestamptz,
  acknowledge_note text,

  refreshed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT expiration_source_uk UNIQUE (source_table, source_id, kind),
  CONSTRAINT expiration_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT expiration_node_fk FOREIGN KEY (node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT expiration_criticality_range CHECK (criticality BETWEEN 1 AND 5),
  CONSTRAINT expiration_ack_has_actor CHECK (
    (acknowledged_at IS NULL) = (acknowledged_by IS NULL)
  )
);

-- The single-pane query: everything expiring soon across every client.
CREATE INDEX expiration_due_idx ON expiration (tenant_id, expires_at)
  WHERE acknowledged_until IS NULL;
CREATE INDEX expiration_org_due_idx ON expiration (tenant_id, organization_id, expires_at);
CREATE INDEX expiration_kind_idx ON expiration (tenant_id, kind, expires_at);
CREATE INDEX expiration_node_idx ON expiration (node_id) WHERE node_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Severity is computed, never stored: a stored severity is wrong the moment the
-- clock moves past midnight and nobody has run a job.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.expiration_severity(
  p_expires_at timestamptz,
  p_criticality smallint DEFAULT 3
) RETURNS alert_severity
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_expires_at <= now() THEN 'expired'
    -- Business-critical things get a wider warning horizon: a 30-day notice on
    -- a domain that carries the client's email is not notice, it is a fire.
    WHEN p_expires_at <= now() + (CASE WHEN p_criticality >= 4 THEN '30 days' ELSE '14 days' END)::interval THEN 'critical'
    WHEN p_expires_at <= now() + (CASE WHEN p_criticality >= 4 THEN '60 days' ELSE '30 days' END)::interval THEN 'warning'
    WHEN p_expires_at <= now() + '90 days'::interval THEN 'notice'
    ELSE 'info'
  END::alert_severity;
$$;

CREATE VIEW v_expiration_dashboard
  WITH (security_invoker = true, security_barrier = true) AS
SELECT
  e.id,
  e.tenant_id,
  e.organization_id,
  o.name AS organization_name,
  e.kind,
  e.node_id,
  e.label,
  e.expires_at,
  e.auto_renew,
  e.criticality,
  e.acknowledged_until,
  helm.expiration_severity(e.expires_at, e.criticality) AS severity,
  (e.expires_at::date - current_date) AS days_remaining
FROM expiration e
JOIN organization o ON o.id = e.organization_id
WHERE e.acknowledged_until IS NULL OR e.acknowledged_until < now();

-- -----------------------------------------------------------------------------
-- Generic projector.
--
-- TG_ARGV[0] expiration kind
-- TG_ARGV[1] column on the source row holding the timestamp/date
-- TG_ARGV[2] column holding the display label, or '' to use asset_node.name
-- TG_ARGV[3] column holding auto-renew, or '' for false
--
-- Reading the row through to_jsonb() keeps one function serving every source
-- table instead of a near-identical trigger per table, each of which would be
-- an opportunity to get the tenant scoping subtly wrong.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.project_expiration() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_kind        expiration_kind := TG_ARGV[0]::expiration_kind;
  v_date_col    text := TG_ARGV[1];
  v_label_col   text := TG_ARGV[2];
  v_renew_col   text := TG_ARGV[3];
  v_row         jsonb;
  v_expires_txt text;
  v_expires     timestamptz;
  v_label       text;
  v_renew       boolean := false;
  v_node        asset_node%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM expiration
    WHERE source_table = TG_TABLE_NAME AND source_id = OLD.id AND kind = v_kind;
    RETURN OLD;
  END IF;

  v_row := to_jsonb(NEW);
  v_expires_txt := v_row ->> v_date_col;

  -- Cleared date means the expiry no longer exists.
  IF v_expires_txt IS NULL THEN
    DELETE FROM expiration
    WHERE source_table = TG_TABLE_NAME AND source_id = NEW.id AND kind = v_kind;
    RETURN NEW;
  END IF;

  v_expires := v_expires_txt::timestamptz;

  SELECT * INTO v_node FROM asset_node WHERE id = NEW.id;
  IF NOT FOUND THEN
    -- Source is not a graph node; such tables pass their own label column and
    -- carry organisation on the row itself.
    RAISE EXCEPTION 'helm: project_expiration on % requires a matching asset_node', TG_TABLE_NAME;
  END IF;

  v_label := CASE WHEN v_label_col = '' THEN v_node.name ELSE v_row ->> v_label_col END;
  IF v_renew_col <> '' THEN
    v_renew := coalesce((v_row ->> v_renew_col)::boolean, false);
  END IF;

  INSERT INTO expiration (
    tenant_id, organization_id, kind, node_id, source_table, source_id,
    label, expires_at, auto_renew, criticality, refreshed_at
  )
  VALUES (
    v_node.tenant_id, v_node.organization_id, v_kind, v_node.id, TG_TABLE_NAME, NEW.id,
    coalesce(v_label, v_node.name), v_expires, v_renew, v_node.criticality, now()
  )
  ON CONFLICT (source_table, source_id, kind) DO UPDATE
  SET label           = EXCLUDED.label,
      expires_at      = EXCLUDED.expires_at,
      auto_renew      = EXCLUDED.auto_renew,
      criticality     = EXCLUDED.criticality,
      organization_id = EXCLUDED.organization_id,
      refreshed_at    = now(),
      -- A moved expiry date clears a stale acknowledgement: acknowledging last
      -- year's renewal must not suppress this year's.
      acknowledged_at    = CASE WHEN expiration.expires_at <> EXCLUDED.expires_at
                                THEN NULL ELSE expiration.acknowledged_at END,
      acknowledged_by    = CASE WHEN expiration.expires_at <> EXCLUDED.expires_at
                                THEN NULL ELSE expiration.acknowledged_by END,
      acknowledged_until = CASE WHEN expiration.expires_at <> EXCLUDED.expires_at
                                THEN NULL ELSE expiration.acknowledged_until END;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ssl_certificate_expiration
  AFTER INSERT OR UPDATE OF not_after OR DELETE ON ssl_certificate
  FOR EACH ROW EXECUTE FUNCTION helm.project_expiration('ssl_certificate', 'not_after', 'common_name', 'auto_renew');

CREATE TRIGGER domain_expiration
  AFTER INSERT OR UPDATE OF expires_at OR DELETE ON domain
  FOR EACH ROW EXECUTE FUNCTION helm.project_expiration('domain_registration', 'expires_at', 'domain_name', 'auto_renew');

CREATE TRIGGER device_warranty_expiration
  AFTER INSERT OR UPDATE OF warranty_expires_at OR DELETE ON device
  FOR EACH ROW EXECUTE FUNCTION helm.project_expiration('device_warranty', 'warranty_expires_at', '', '');

CREATE TRIGGER device_eol_expiration
  AFTER INSERT OR UPDATE OF end_of_life_at OR DELETE ON device
  FOR EACH ROW EXECUTE FUNCTION helm.project_expiration('device_eol', 'end_of_life_at', '', '');

CREATE TRIGGER license_expiration
  AFTER INSERT OR UPDATE OF expires_at OR DELETE ON license
  FOR EACH ROW EXECUTE FUNCTION helm.project_expiration('license', 'expires_at', '', 'auto_renew');

CREATE TRIGGER contract_expiration
  AFTER INSERT OR UPDATE OF ends_at OR DELETE ON contract
  FOR EACH ROW EXECUTE FUNCTION helm.project_expiration('contract', 'ends_at', '', 'auto_renew');

CREATE TRIGGER isp_circuit_expiration
  AFTER INSERT OR UPDATE OF contract_ends_at OR DELETE ON isp_circuit
  FOR EACH ROW EXECUTE FUNCTION helm.project_expiration('isp_contract', 'contract_ends_at', '', '');

-- -----------------------------------------------------------------------------
-- alert_rule / alert_event — notification policy and its delivery log.
-- -----------------------------------------------------------------------------
CREATE TABLE alert_rule (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  -- NULL means the rule applies to every organisation in the tenant.
  organization_id  uuid,

  name             text NOT NULL,
  kinds            expiration_kind[] NOT NULL DEFAULT '{}',
  -- Days before expiry at which to fire, e.g. {90, 30, 14, 7, 1}.
  lead_days        integer[] NOT NULL DEFAULT '{90,30,14,7,1}',
  min_criticality  smallint NOT NULL DEFAULT 1,

  channel          text NOT NULL,          -- email | webhook | psa_ticket | slack | teams
  target           text NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,

  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT alert_rule_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT alert_rule_channel_known CHECK (
    channel IN ('email', 'webhook', 'psa_ticket', 'slack', 'teams')
  ),
  CONSTRAINT alert_rule_lead_days_sane CHECK (
    cardinality(lead_days) > 0 AND 0 <= ALL (lead_days) AND 3650 >= ALL (lead_days)
  ),
  CONSTRAINT alert_rule_criticality_range CHECK (min_criticality BETWEEN 1 AND 5)
);

CREATE TABLE alert_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  rule_id        uuid NOT NULL REFERENCES alert_rule(id) ON DELETE CASCADE,
  expiration_id  uuid NOT NULL REFERENCES expiration(id) ON DELETE CASCADE,

  lead_day       integer NOT NULL,
  severity       alert_severity NOT NULL,
  fired_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at   timestamptz,
  delivery_status text NOT NULL DEFAULT 'pending',
  delivery_error text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Idempotency: one notification per rule, per expiry, per lead threshold.
  -- Without this the nightly job re-alerts every run and the team stops reading
  -- the alerts, which is the real failure mode of expiry tracking.
  CONSTRAINT alert_event_uk UNIQUE (rule_id, expiration_id, lead_day),
  CONSTRAINT alert_event_status_known CHECK (
    delivery_status IN ('pending', 'sent', 'failed', 'suppressed')
  )
);
CREATE INDEX alert_event_pending_idx ON alert_event (tenant_id, fired_at)
  WHERE delivery_status = 'pending';

CREATE TRIGGER alert_rule_touch BEFORE UPDATE ON alert_rule
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Full rebuild of the projection. Run after a bulk import, or to prove the
-- triggers have not drifted from the sources.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.rebuild_expirations(p_tenant_id uuid DEFAULT NULL)
  RETURNS bigint
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_count bigint := 0;
BEGIN
  DELETE FROM expiration WHERE p_tenant_id IS NULL OR tenant_id = p_tenant_id;

  -- Re-firing the triggers via a no-op UPDATE keeps one definition of the
  -- projection logic rather than a second, subtly different, bulk version.
  UPDATE ssl_certificate SET not_after = not_after
    WHERE p_tenant_id IS NULL OR tenant_id = p_tenant_id;
  UPDATE domain SET expires_at = expires_at
    WHERE p_tenant_id IS NULL OR tenant_id = p_tenant_id;
  UPDATE device SET warranty_expires_at = warranty_expires_at, end_of_life_at = end_of_life_at
    WHERE p_tenant_id IS NULL OR tenant_id = p_tenant_id;
  UPDATE license SET expires_at = expires_at
    WHERE p_tenant_id IS NULL OR tenant_id = p_tenant_id;
  UPDATE contract SET ends_at = ends_at
    WHERE p_tenant_id IS NULL OR tenant_id = p_tenant_id;
  UPDATE isp_circuit SET contract_ends_at = contract_ends_at
    WHERE p_tenant_id IS NULL OR tenant_id = p_tenant_id;

  SELECT count(*) INTO v_count FROM expiration
  WHERE p_tenant_id IS NULL OR tenant_id = p_tenant_id;
  RETURN v_count;
END;
$$;
