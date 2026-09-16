-- =============================================================================
-- 0300_worker_queues.sql — what the background workers are allowed to ask for
--
-- Every job runner faces the same problem: to do per-tenant work it must first
-- know which tenants have work, and that question cannot be asked from inside a
-- tenant context. The tempting answers are all bad — give the worker BYPASSRLS,
-- or let it connect as a superuser, or keep a second "platform" table outside
-- RLS that drifts from reality.
--
-- Instead each job gets one narrow SECURITY DEFINER enumerator, granted to
-- helm_worker alone. helm_app is not a member of helm_worker (the membership
-- runs the other way), so none of this is reachable from an HTTP request. Each
-- returns work to do — ids, counts and timestamps — and no tenant content.
--
-- The actual work then happens inside a normal tenant context, as the worker's
-- service account, under the same RLS policies and the same audit log as a
-- technician doing it by hand. The enumerators are a scheduler, not a bypass.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- The service account a given worker acts as, inside a given tenant.
--
-- Every enumerator below returns this alongside the work, so a runner never has
-- to make a second, context-less query to answer "who am I here?" — and so the
-- only place that knows how worker identities are named is 0290.
--
-- Plain SECURITY INVOKER: it is called from inside the SECURITY DEFINER
-- enumerators, where it already runs with their rights, and calling it directly
-- from a tenant context correctly returns only that tenant's row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.worker_actor(p_tenant_id uuid, p_role_key text)
  RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT sa.id
  FROM service_account sa
  WHERE sa.tenant_id = p_tenant_id
    AND sa.role_key = p_role_key
    AND sa.is_system
    AND sa.disabled_at IS NULL
  LIMIT 1;
$$;

-- -----------------------------------------------------------------------------
-- Expiry alerts
-- -----------------------------------------------------------------------------

/**
 * Tenants with alert rules worth evaluating.
 *
 * Returning a count rather than a bare list lets the runner log "4 tenants,
 * 17 rules" and lets an operator see at a glance that a tenant nobody has
 * configured rules for is being skipped for that reason rather than silently.
 */
CREATE OR REPLACE FUNCTION helm.alert_backlog()
  RETURNS TABLE (tenant_id uuid, tenant_name text, worker_actor_id uuid, active_rules bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT t.id, t.name, helm.worker_actor(t.id, 'system_alerts'), count(r.id)
  FROM tenant t
  JOIN alert_rule r ON r.tenant_id = t.id AND r.is_active
  WHERE t.status = 'active'
  GROUP BY t.id, t.name
  HAVING helm.worker_actor(t.id, 'system_alerts') IS NOT NULL
  ORDER BY t.name;
$$;

/**
 * Fire the alert events that are due, inside the current tenant context.
 *
 * Set-based rather than a loop: one statement per rule-set, so a tenant with
 * 40,000 expirations does not become 40,000 round trips.
 *
 * THE FIRING RULE. A rule lists lead days such as {90, 30, 14, 7, 1}. An
 * expiration has "crossed" a threshold when it is due within that many days.
 * The naive implementation fires every crossed threshold, which means adding a
 * certificate that already expires in five days immediately produces four
 * alerts — and a team that receives four alerts for one certificate stops
 * reading alerts, which is the actual failure mode of expiry tracking.
 *
 * So: of the thresholds crossed and not yet recorded, only the SMALLEST (most
 * urgent) is delivered. The larger ones are written as 'suppressed', which
 * keeps the idempotency record — the unique constraint on
 * (rule, expiration, lead_day) means they can never fire later — while making
 * it visible in the table that they were deliberately not sent rather than
 * lost. Steady state is unaffected: at 30 days the only newly-crossed
 * threshold is 30, and it is delivered.
 *
 * Acknowledged expirations are skipped, and helm.project_expiration() already
 * clears an acknowledgement when the date moves, so acknowledging last year's
 * renewal cannot suppress this year's.
 */
CREATE OR REPLACE FUNCTION helm.evaluate_alert_rules()
  RETURNS TABLE (fired bigint, suppressed bigint)
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_fired  bigint := 0;
  v_suppressed bigint := 0;
BEGIN
  IF NOT helm.has_permission('alert:manage') THEN
    RAISE EXCEPTION 'helm: alert evaluation requires alert:manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  WITH candidate AS (
    SELECT
      r.id   AS rule_id,
      e.id   AS expiration_id,
      e.organization_id,
      e.kind,
      e.label,
      e.node_id,
      e.expires_at,
      (e.expires_at::date - current_date) AS days_remaining,
      helm.expiration_severity(e.expires_at, e.criticality) AS severity,
      lead.day AS lead_day
    FROM alert_rule r
    JOIN expiration e
      ON e.tenant_id = r.tenant_id
     AND (r.organization_id IS NULL OR e.organization_id = r.organization_id)
     AND (cardinality(r.kinds) = 0 OR e.kind = ANY (r.kinds))
     AND e.criticality >= r.min_criticality
     AND (e.acknowledged_until IS NULL OR e.acknowledged_until < now())
    CROSS JOIN LATERAL unnest(r.lead_days) AS lead(day)
    WHERE r.tenant_id = v_tenant
      AND r.is_active
      -- Crossed: the expiry is now within this rule's lead window.
      AND (e.expires_at::date - current_date) <= lead.day
  ),
  -- Thresholds already recorded, fired or suppressed, are not candidates.
  fresh AS (
    SELECT c.*
    FROM candidate c
    WHERE NOT EXISTS (
      SELECT 1 FROM alert_event a
      WHERE a.rule_id = c.rule_id
        AND a.expiration_id = c.expiration_id
        AND a.lead_day = c.lead_day
    )
  ),
  ranked AS (
    SELECT f.*,
           min(f.lead_day) OVER (PARTITION BY f.rule_id, f.expiration_id) AS most_urgent
    FROM fresh f
  ),
  inserted AS (
    INSERT INTO alert_event (
      tenant_id, rule_id, expiration_id, lead_day, severity, delivery_status, payload
    )
    SELECT
      v_tenant, r.rule_id, r.expiration_id, r.lead_day, r.severity,
      CASE WHEN r.lead_day = r.most_urgent THEN 'pending' ELSE 'suppressed' END,
      jsonb_build_object(
        'kind',            r.kind,
        'label',           r.label,
        'organization_id', r.organization_id,
        'node_id',         r.node_id,
        'expires_at',      r.expires_at,
        'days_remaining',  r.days_remaining,
        'severity',        r.severity,
        'lead_day',        r.lead_day)
    FROM ranked r
    -- Belt and braces against a concurrent evaluation of the same tenant: the
    -- unique constraint is the real guarantee, not the NOT EXISTS above.
    ON CONFLICT ON CONSTRAINT alert_event_uk DO NOTHING
    RETURNING delivery_status
  )
  SELECT
    count(*) FILTER (WHERE delivery_status = 'pending'),
    count(*) FILTER (WHERE delivery_status = 'suppressed')
  INTO v_fired, v_suppressed
  FROM inserted;

  IF v_fired > 0 OR v_suppressed > 0 THEN
    PERFORM helm.audit(
      'alert.evaluated', 'tenant', v_tenant, 'success', NULL, NULL, NULL,
      jsonb_build_object('fired', v_fired, 'suppressed', v_suppressed));
  END IF;

  RETURN QUERY SELECT v_fired, v_suppressed;
END;
$$;

/**
 * Alerts waiting to be delivered, newest first, with everything the notifier
 * needs. Ordinary RLS applies — this runs inside the tenant context.
 */
CREATE OR REPLACE FUNCTION helm.pending_alerts(p_limit integer DEFAULT 200)
  RETURNS TABLE (
    alert_id       uuid,
    rule_id        uuid,
    rule_name      text,
    channel        text,
    target         text,
    severity       alert_severity,
    lead_day       integer,
    fired_at       timestamptz,
    payload        jsonb
  )
  LANGUAGE sql STABLE
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT a.id, r.id, r.name, r.channel, r.target, a.severity, a.lead_day, a.fired_at, a.payload
  FROM alert_event a
  JOIN alert_rule r ON r.id = a.rule_id
  WHERE a.tenant_id = helm.current_tenant_id()
    AND a.delivery_status = 'pending'
  ORDER BY a.severity DESC, a.fired_at
  LIMIT greatest(p_limit, 1);
$$;

/**
 * Record a delivery outcome.
 *
 * `delivered_at` is set only on success, so "sent" and "when" cannot disagree.
 * A failure keeps the row pending-free — it becomes 'failed' rather than
 * returning to the queue — because an alert channel that is down needs an
 * operator, not an infinite retry that eventually delivers a notice about a
 * certificate that expired last month.
 */
CREATE OR REPLACE FUNCTION helm.record_alert_delivery(
  p_alert_id uuid,
  p_status   text,
  p_error    text DEFAULT NULL
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_status NOT IN ('sent', 'failed', 'suppressed') THEN
    RAISE EXCEPTION 'helm: unknown alert delivery status %', p_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE alert_event
  SET delivery_status = p_status,
      delivered_at    = CASE WHEN p_status = 'sent' THEN now() ELSE NULL END,
      delivery_error  = left(p_error, 2000)
  WHERE id = p_alert_id
    AND tenant_id = helm.require_tenant_id()
    AND delivery_status = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

-- -----------------------------------------------------------------------------
-- Integration sync
-- -----------------------------------------------------------------------------

/**
 * Connections due for a synchronisation run.
 *
 * Two things make this more than "last_sync_at < now() - interval":
 *
 *   * Exponential backoff on consecutive_failures. A connection whose vendor
 *     credentials were revoked would otherwise be retried every five minutes
 *     forever — thousands of failed authentications a day against the client's
 *     RMM, which is how an MSP's integration account gets locked out or
 *     rate-limited across every client at once. Backoff doubles up to 32x the
 *     configured interval.
 *
 *   * Connections with a run already queued or running are excluded, so a slow
 *     sync is never overlapped by the next tick. The partial unique index on
 *     integration_sync_run is the real guarantee; this keeps the runner from
 *     pointlessly trying.
 */
CREATE OR REPLACE FUNCTION helm.sync_due(p_limit integer DEFAULT 50)
  RETURNS TABLE (
    tenant_id       uuid,
    worker_actor_id uuid,
    connection_id   uuid,
    provider        integration_provider,
    display_name    text,
    organization_id uuid,
    direction       sync_direction,
    last_sync_at    timestamptz,
    consecutive_failures integer,
    due_since       timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT
    c.tenant_id, helm.worker_actor(c.tenant_id, 'system_sync'),
    c.id, c.provider, c.display_name, c.organization_id, c.direction,
    c.last_sync_at, c.consecutive_failures,
    -- A connection that has never run is due NOW, not one interval from when it
    -- was configured. Making an administrator wait an hour to find out whether
    -- the credentials they just entered work is how integrations get abandoned
    -- half-configured.
    coalesce(
      c.last_sync_at
        + make_interval(mins => c.sync_interval_minutes
                                * least(2 ^ least(c.consecutive_failures, 5), 32)::integer),
      c.created_at)
  FROM integration_connection c
  JOIN tenant t ON t.id = c.tenant_id AND t.status = 'active'
  WHERE c.sync_enabled
    AND c.disabled_at IS NULL
    AND c.status <> 'disabled'
    AND (c.last_sync_at IS NULL
         OR now() >= c.last_sync_at
                     + make_interval(mins => c.sync_interval_minutes
                                             * least(2 ^ least(c.consecutive_failures, 5), 32)::integer))
    AND NOT EXISTS (
      SELECT 1 FROM integration_sync_run r
      WHERE r.connection_id = c.id AND r.status IN ('queued', 'running')
    )
    AND helm.worker_actor(c.tenant_id, 'system_sync') IS NOT NULL
  ORDER BY c.consecutive_failures, coalesce(c.last_sync_at, c.created_at)
  LIMIT greatest(p_limit, 1);
$$;

/**
 * Claim a connection and open a run.
 *
 * Returns NULL rather than raising when another worker got there first: two
 * runners racing on the same tick is normal operation, not an error worth
 * waking anybody for. The partial unique index does the arbitration.
 */
CREATE OR REPLACE FUNCTION helm.begin_sync_run(
  p_connection_id  uuid,
  p_trigger_source text DEFAULT 'schedule'
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_cursor text;
  v_run    uuid;
BEGIN
  SELECT sync_cursor INTO v_cursor
  FROM integration_connection
  WHERE id = p_connection_id AND tenant_id = v_tenant;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: no such integration connection %', p_connection_id
      USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO integration_sync_run (tenant_id, connection_id, status, trigger_source,
                                    started_at, cursor_before)
  VALUES (v_tenant, p_connection_id, 'running', p_trigger_source, now(), v_cursor)
  ON CONFLICT (connection_id) WHERE status IN ('queued', 'running') DO NOTHING
  RETURNING id INTO v_run;

  IF v_run IS NOT NULL THEN
    PERFORM helm.audit('integration.sync_started', 'integration_connection', p_connection_id,
                       'success', NULL, NULL, NULL,
                       jsonb_build_object('run_id', v_run, 'trigger', p_trigger_source));
  END IF;

  RETURN v_run;
END;
$$;

/**
 * Close a run and update the connection's health in the same transaction.
 *
 * The connection bookkeeping lives here rather than in the worker because it is
 * the part a worker forgets: a run that fails and never increments
 * consecutive_failures produces a connection that retries at full rate forever
 * while reporting itself healthy.
 */
CREATE OR REPLACE FUNCTION helm.finish_sync_run(
  p_run_id          uuid,
  p_status          sync_run_status,
  p_records_seen    integer DEFAULT 0,
  p_records_created integer DEFAULT 0,
  p_records_updated integer DEFAULT 0,
  p_records_skipped integer DEFAULT 0,
  p_records_failed  integer DEFAULT 0,
  p_cursor_after    text DEFAULT NULL,
  p_error_summary   text DEFAULT NULL,
  p_details         jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant     uuid := helm.require_tenant_id();
  v_connection uuid;
  v_ok         boolean := p_status IN ('success', 'partial');
BEGIN
  IF p_status NOT IN ('success', 'partial', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'helm: % is not a terminal sync status', p_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE integration_sync_run
  SET status          = p_status,
      finished_at     = now(),
      records_seen    = p_records_seen,
      records_created = p_records_created,
      records_updated = p_records_updated,
      records_skipped = p_records_skipped,
      records_failed  = p_records_failed,
      cursor_after    = p_cursor_after,
      error_summary   = left(p_error_summary, 2000),
      details         = p_details
  WHERE id = p_run_id AND tenant_id = v_tenant AND status IN ('queued', 'running')
  RETURNING connection_id INTO v_connection;

  IF v_connection IS NULL THEN
    RETURN false;
  END IF;

  UPDATE integration_connection
  SET last_sync_at    = now(),
      last_success_at = CASE WHEN v_ok THEN now() ELSE last_success_at END,
      -- A cursor is only advanced on a clean run. Advancing it after a partial
      -- failure silently skips whatever was missed, and nobody finds out until
      -- a client asks why a server is not documented.
      sync_cursor     = CASE WHEN p_status = 'success' THEN coalesce(p_cursor_after, sync_cursor)
                             ELSE sync_cursor END,
      consecutive_failures = CASE WHEN v_ok THEN 0 ELSE consecutive_failures + 1 END,
      last_error      = CASE WHEN v_ok THEN NULL ELSE left(p_error_summary, 2000) END,
      status          = CASE
                          WHEN v_ok THEN 'active'::integration_status
                          WHEN consecutive_failures + 1 >= 5 THEN 'error'::integration_status
                          ELSE 'degraded'::integration_status
                        END
  WHERE id = v_connection AND tenant_id = v_tenant;

  PERFORM helm.audit('integration.sync_finished', 'integration_connection', v_connection,
                     (CASE WHEN v_ok THEN 'success' ELSE 'error' END)::audit_outcome,
                     NULL, NULL, NULL,
                     jsonb_build_object(
                       'run_id', p_run_id, 'status', p_status,
                       'seen', p_records_seen, 'created', p_records_created,
                       'updated', p_records_updated, 'skipped', p_records_skipped,
                       'failed', p_records_failed));
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- Audit chain anchoring
-- -----------------------------------------------------------------------------

/**
 * Tenants whose chain has advanced past its last external anchor.
 *
 * The hash chain proves nobody edited history without also rewriting every
 * later row. It does NOT prove that the whole chain was not rewritten by
 * someone with database ownership. Anchoring closes that: once the head hash at
 * sequence N has been witnessed somewhere Helm cannot reach — an object-lock
 * bucket, a signed log, a printout in a safe — history up to N is fixed.
 * Everything after the last anchor is still only as trustworthy as the
 * database.
 */
CREATE OR REPLACE FUNCTION helm.audit_anchor_backlog()
  RETURNS TABLE (
    tenant_id    uuid,
    tenant_name  text,
    worker_actor_id uuid,
    chain_seq    bigint,
    head_hash    bytea,
    anchored_seq bigint,
    anchored_at  timestamptz,
    unanchored   bigint
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT h.tenant_id, t.name, helm.worker_actor(h.tenant_id, 'system_audit'),
         h.chain_seq, h.head_hash, h.anchored_seq, h.anchored_at,
         h.chain_seq - h.anchored_seq
  FROM audit_chain_head h
  JOIN tenant t ON t.id = h.tenant_id
  WHERE h.chain_seq > h.anchored_seq
    AND t.status = 'active'
  ORDER BY h.chain_seq - h.anchored_seq DESC;
$$;

/**
 * Record that a chain head was witnessed externally.
 *
 * The only write to audit_chain_head outside the audit trigger, and it touches
 * the three anchor columns and nothing else — chain_seq and head_hash stay
 * under the trigger's exclusive control, so this cannot be used to rewrite the
 * chain's own idea of where it is.
 *
 * The seq/hash pair must correspond to a real row in this tenant's chain. A
 * worker that anchored an arbitrary hash would produce a receipt that proves
 * nothing, and the failure would be invisible until an auditor tried to use it.
 *
 * Monotonic: the anchor can only move forwards. Re-anchoring an older sequence
 * is refused rather than quietly ignored, because it usually means two workers
 * are running against the same tenant with different views of the chain.
 */
CREATE OR REPLACE FUNCTION helm.record_audit_anchor(
  p_tenant_id  uuid,
  p_chain_seq  bigint,
  p_head_hash  bytea,
  p_anchor_ref text
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_head audit_chain_head%ROWTYPE;
BEGIN
  IF p_anchor_ref IS NULL OR length(btrim(p_anchor_ref)) = 0 THEN
    RAISE EXCEPTION 'helm: an anchor must name where it was witnessed'
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'an object key, a transparency log index, a receipt id';
  END IF;

  SELECT * INTO v_head FROM audit_chain_head WHERE tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: tenant % has no audit chain', p_tenant_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF p_chain_seq > v_head.chain_seq THEN
    RAISE EXCEPTION 'helm: cannot anchor sequence % ahead of the chain head %',
      p_chain_seq, v_head.chain_seq
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_chain_seq <= v_head.anchored_seq THEN
    RAISE EXCEPTION 'helm: sequence % is already anchored (current anchor %)',
      p_chain_seq, v_head.anchored_seq
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'anchors move forwards only; two workers may be racing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM audit_log
    WHERE tenant_id = p_tenant_id AND chain_seq = p_chain_seq AND row_hash = p_head_hash
  ) THEN
    RAISE EXCEPTION 'helm: no audit row at sequence % has that hash', p_chain_seq
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'the chain moved, or the witnessed hash is not from this chain.';
  END IF;

  UPDATE audit_chain_head
  SET anchored_seq = p_chain_seq,
      anchored_at  = now(),
      anchor_ref   = p_anchor_ref
  WHERE tenant_id = p_tenant_id;

  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- Grants.
--
-- helm_worker only. helm_app is the role every HTTP request runs as, and it is
-- NOT a member of helm_worker — the membership goes the other way — so none of
-- these cross-tenant enumerators is reachable from a request.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION helm.worker_actor(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.worker_actor(uuid, text) TO helm_worker;

REVOKE ALL ON FUNCTION helm.alert_backlog() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.sync_due(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.audit_anchor_backlog() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_audit_anchor(uuid, bigint, bytea, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.alert_backlog() TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.sync_due(integer) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.audit_anchor_backlog() TO helm_worker, helm_auditor;
GRANT EXECUTE ON FUNCTION helm.record_audit_anchor(uuid, bigint, bytea, text) TO helm_worker;

-- These run inside a tenant context and are subject to RLS; the request path
-- may call them too, which is how a technician triggers a sync by hand.
REVOKE ALL ON FUNCTION helm.evaluate_alert_rules() FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.pending_alerts(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_alert_delivery(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.begin_sync_run(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.finish_sync_run(uuid, sync_run_status, integer, integer, integer, integer, integer, text, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.evaluate_alert_rules() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.pending_alerts(integer) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.record_alert_delivery(uuid, text, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.begin_sync_run(uuid, text) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.finish_sync_run(uuid, sync_run_status, integer, integer, integer, integer, integer, text, text, jsonb) TO helm_app;

-- -----------------------------------------------------------------------------
-- Guard: the cross-tenant enumerators must stay out of the request path.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  v_leak text;
BEGIN
  SELECT string_agg(f, ', ') INTO v_leak
  FROM unnest(ARRAY[
    'helm.alert_backlog()',
    'helm.sync_due(integer)',
    'helm.audit_anchor_backlog()',
    'helm.record_audit_anchor(uuid, bigint, bytea, text)'
  ]) AS f
  WHERE has_function_privilege('helm_app', f, 'EXECUTE');

  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'helm: helm_app can execute cross-tenant worker functions: %', v_leak;
  END IF;

  IF pg_has_role('helm_app', 'helm_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'helm: helm_app is a member of helm_worker, which defeats the separation';
  END IF;
END
$guard$;
