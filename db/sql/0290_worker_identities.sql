-- =============================================================================
-- 0290_worker_identities.sql — who the background workers are
--
-- Helm's background jobs — expiry alerts, RMM/PSA sync, audit anchoring, export
-- rendering — need to act inside a tenant context, which means they need an
-- identity. Two decisions shape everything here.
--
-- FIRST: they are service accounts, not a back door. helm.set_session_context()
-- already refuses every actor type except 'user' and 'service_account', and
-- that is the right answer — a "system" actor that skipped membership
-- resolution would be a second, weaker authorisation path that eventually
-- diverges from the first. So each tenant gets one service account per worker,
-- provisioned by trigger, and the workers authenticate as normal machine
-- identities whose reveals audit like everybody else's.
--
-- SECOND: a service account is restricted to the reveal PURPOSES its job
-- actually has. Before this migration any account with secret:reveal could read
-- any secret in scope for any stated purpose, which meant the sync worker —
-- which needs rank 80 to write integration tables — could have read a client's
-- domain admin password by asking for purpose 'view'. Now the purpose is part
-- of the account's identity, and for the two purposes that have a natural
-- scope, the scope is checked against the database rather than asserted:
--
--   integration  the secret must be referenced by an integration_connection's
--                credential_secret_ids in this tenant
--   export       the secret must fall inside an approved, live export job
--
-- The result is that no background worker holds a general reveal capability.
-- A compromised sync worker gets the RMM API keys it was always going to need;
-- it does not get the vault.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- helm_worker — the database role the job runner connects as.
--
-- A member of helm_app, so it inherits exactly the request path's table
-- privileges and is subject to exactly the same RLS policies. What it adds is
-- EXECUTE on the backlog enumerators in 0300, which helm_app must NOT have:
-- those cross tenant boundaries, and anything helm_app can execute is reachable
-- from an HTTP request. Membership is one-way — helm_worker inherits helm_app,
-- never the reverse.
-- -----------------------------------------------------------------------------
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helm_worker') THEN
    CREATE ROLE helm_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$roles$;

DO $membership$
BEGIN
  -- Idempotent: re-running migrations against an existing cluster must not
  -- emit a NOTICE that looks like a warning in a deployment log.
  IF NOT pg_has_role('helm_worker', 'helm_app', 'MEMBER') THEN
    GRANT helm_app TO helm_worker;
  END IF;
END
$membership$;
GRANT USAGE ON SCHEMA helm, extensions TO helm_worker;
ALTER ROLE helm_worker SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Purpose restriction on machine identities.
--
-- NULL means unrestricted, which is what a human-configured service account
-- gets unless an administrator narrows it. The workers below are all narrowed,
-- and so is any browser-extension identity worth the name: an extension account
-- limited to {autofill} cannot be replayed into a bulk export.
-- -----------------------------------------------------------------------------
ALTER TABLE service_account
  ADD COLUMN allowed_reveal_purposes text[],
  -- Marks a Helm-managed worker identity. The UI shows these read-only and the
  -- trigger below refuses edits: an administrator who "tidied up" the sync
  -- account's role would break integration sync in a way that looks like a
  -- vendor outage.
  ADD COLUMN is_system boolean NOT NULL DEFAULT false;

ALTER TABLE service_account ADD CONSTRAINT service_account_purposes_known CHECK (
  allowed_reveal_purposes IS NULL
  OR (cardinality(allowed_reveal_purposes) > 0
      AND allowed_reveal_purposes <@ ARRAY['view', 'copy', 'autofill', 'export', 'integration', 'rotation'])
);

COMMENT ON COLUMN service_account.allowed_reveal_purposes IS
  'Reveal purposes this machine identity may use. NULL means unrestricted. '
  'Enforced inside helm.reveal_secret(), so narrowing it constrains every path '
  'to ciphertext rather than every caller that remembered to check.';

-- -----------------------------------------------------------------------------
-- Is this secret an integration credential of the current tenant?
--
-- credential_secret_ids is a map of role -> secret uuid, so the check is a
-- containment test over its values. Kept as a function because reveal_secret is
-- already long and because "what counts as an integration credential" is a fact
-- worth naming once.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.is_integration_credential(p_secret_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM integration_connection c
    CROSS JOIN LATERAL jsonb_each_text(c.credential_secret_ids) AS cred(role_key, secret_id)
    WHERE c.tenant_id = helm.current_tenant_id()
      AND c.disabled_at IS NULL
      AND cred.secret_id = p_secret_id::text
  );
$$;

-- -----------------------------------------------------------------------------
-- Is this secret inside a live, approved, secret-bearing export?
--
-- Deliberately re-derives the answer from export_job rather than trusting a
-- job id the caller passed: the point is that an export worker cannot reveal a
-- secret the four-eyes approval did not cover, including after the job expired
-- or was revoked mid-render.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.is_in_approved_export(p_secret_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM export_job j
    JOIN secret s ON s.tenant_id = j.tenant_id AND s.organization_id = j.organization_id
    WHERE j.tenant_id = helm.current_tenant_id()
      AND j.include_secrets
      AND j.approved_by IS NOT NULL
      AND j.approved_at IS NOT NULL
      AND j.revoked_at IS NULL
      AND j.expires_at > now()
      AND j.status IN ('queued', 'running')
      AND s.id = p_secret_id
      AND s.deleted_at IS NULL
  );
$$;

REVOKE ALL ON FUNCTION helm.is_integration_credential(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.is_in_approved_export(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.is_integration_credential(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.is_in_approved_export(uuid) TO helm_app;

-- -----------------------------------------------------------------------------
-- Re-declare helm.reveal_secret with the purpose checks folded into the
-- existing authorisation ladder.
--
-- The new rungs sit BELOW the permission and rank checks and ABOVE the version
-- lookup, so a purpose refusal reads as a policy denial rather than as a
-- missing secret, and — like every other denial here — it RETURNS rather than
-- raising, so the audit row recording the refusal survives the transaction.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.reveal_secret(
  p_secret_id uuid,
  p_reason    text  DEFAULT NULL,
  p_purpose   text  DEFAULT 'view',
  p_version   integer DEFAULT NULL
) RETURNS TABLE (
  granted        boolean,
  denial_reason  text,
  audit_event_uid uuid,
  secret_id      uuid,
  version        integer,
  kind           secret_kind,
  algorithm      text,
  ciphertext     bytea,
  nonce          bytea,
  auth_tag       bytea,
  aad            text,
  data_key_id    uuid,
  wrapped_dek    bytea,
  kek_id         text,
  wrap_provider  text,
  wrap_context   jsonb
)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant   uuid := helm.current_tenant_id();
  v_secret   secret%ROWTYPE;
  v_version  secret_version%ROWTYPE;
  v_key      tenant_data_key%ROWTYPE;
  v_deny     text := NULL;
  v_event    uuid;
  v_target   integer;
  v_purposes text[];
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'helm: no tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_purpose NOT IN ('view', 'copy', 'autofill', 'export', 'integration', 'rotation') THEN
    RAISE EXCEPTION 'helm: unknown reveal purpose %', p_purpose
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_secret FROM secret
  WHERE id = p_secret_id AND tenant_id = v_tenant AND deleted_at IS NULL;

  -- Unknown and out-of-scope are the same answer on purpose: probing for secret
  -- ids must not distinguish "no such secret" from "not yours".
  IF NOT FOUND OR NOT helm.org_in_scope(v_secret.organization_id) THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', p_secret_id, 'denied',
                          NULL, NULL, p_reason,
                          jsonb_build_object('purpose', p_purpose, 'cause', 'not_found_or_out_of_scope'));
    RETURN QUERY SELECT false, 'not_found', v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  -- A machine identity may be pinned to the purposes its job actually has.
  IF helm.current_actor_type() = 'service_account' THEN
    SELECT sa.allowed_reveal_purposes INTO v_purposes
    FROM service_account sa
    WHERE sa.id = helm.current_actor_id() AND sa.tenant_id = v_tenant;
  END IF;

  -- Authorisation ladder, most specific refusal first.
  IF NOT helm.has_permission('secret:reveal') THEN
    v_deny := 'missing_permission';
  ELSIF v_purposes IS NOT NULL AND NOT (p_purpose = ANY (v_purposes)) THEN
    v_deny := 'purpose_not_permitted_for_actor';
  ELSIF helm.current_role_rank() < v_secret.min_role_rank THEN
    v_deny := 'insufficient_role_rank';
  ELSIF v_secret.requires_step_up AND NOT helm.step_up_verified() THEN
    v_deny := 'step_up_required';
  ELSIF v_secret.requires_reason AND coalesce(length(btrim(p_reason)), 0) < 10 THEN
    v_deny := 'reason_required';
  ELSIF p_purpose = 'export' AND NOT helm.has_permission('secret:export') THEN
    v_deny := 'export_not_permitted';
  ELSIF p_purpose = 'export' AND NOT helm.is_in_approved_export(v_secret.id) THEN
    -- Reached by the export worker, whose whole capability is this purpose.
    -- Re-derived from export_job every time, so a job revoked mid-render stops
    -- yielding material immediately.
    v_deny := 'not_in_an_approved_export';
  ELSIF p_purpose = 'integration' AND NOT helm.is_integration_credential(v_secret.id) THEN
    v_deny := 'not_an_integration_credential';
  ELSIF p_purpose = 'autofill' AND v_secret.sensitivity <> 'standard' THEN
    -- Elevated and critical credentials are never auto-filled into a browser.
    -- A domain admin password belongs in a deliberate, observed copy action.
    v_deny := 'autofill_not_permitted_for_sensitivity';
  END IF;

  IF v_deny IS NOT NULL THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', v_secret.id, 'denied',
                          v_secret.organization_id, v_secret.id, p_reason,
                          jsonb_build_object(
                            'purpose', p_purpose,
                            'cause', v_deny,
                            'sensitivity', v_secret.sensitivity,
                            'required_rank', v_secret.min_role_rank,
                            'actor_rank', helm.current_role_rank()));
    RETURN QUERY SELECT false, v_deny, v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  v_target := coalesce(p_version, v_secret.current_version);

  SELECT * INTO v_version FROM secret_version sv
  WHERE sv.secret_id = v_secret.id AND sv.version = v_target;

  IF NOT FOUND THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', v_secret.id, 'error',
                          v_secret.organization_id, v_secret.id, p_reason,
                          jsonb_build_object('purpose', p_purpose, 'cause', 'no_such_version',
                                             'requested_version', v_target));
    RETURN QUERY SELECT false, 'no_such_version', v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_key FROM tenant_data_key WHERE id = v_version.data_key_id;

  IF v_key.status = 'destroyed' THEN
    v_event := helm.audit('secret.reveal_denied', 'secret', v_secret.id, 'error',
                          v_secret.organization_id, v_secret.id, p_reason,
                          jsonb_build_object('purpose', p_purpose, 'cause', 'key_destroyed',
                                             'data_key_id', v_key.id));
    RETURN QUERY SELECT false, 'key_destroyed', v_event,
      NULL::uuid, NULL::integer, NULL::secret_kind, NULL::text,
      NULL::bytea, NULL::bytea, NULL::bytea, NULL::text,
      NULL::uuid, NULL::bytea, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  -- Granted. The audit row and the material leave together.
  v_event := helm.audit(
    'secret.revealed', 'secret', v_secret.id, 'success',
    v_secret.organization_id, v_secret.id, p_reason,
    jsonb_build_object(
      'purpose',      p_purpose,
      'version',      v_version.version,
      'kind',         v_secret.kind,
      'sensitivity',  v_secret.sensitivity,
      'label',        v_secret.label,
      'data_key_id',  v_key.id,
      'step_up',      helm.step_up_verified()));

  UPDATE secret
  SET last_accessed_at = now(), access_count = access_count + 1
  WHERE id = v_secret.id;

  RETURN QUERY SELECT
    true, NULL::text, v_event,
    v_secret.id, v_version.version, v_secret.kind, v_version.algorithm,
    v_version.ciphertext, v_version.nonce, v_version.auth_tag, v_version.aad,
    v_key.id, v_key.wrapped_dek, v_key.kek_id, v_key.wrap_provider, v_key.wrap_context;
END;
$$;

-- -----------------------------------------------------------------------------
-- Per-tenant worker identities.
--
-- Provisioned by trigger so a tenant created next year has working background
-- jobs without anybody remembering a checklist step. The purpose restriction is
-- set here and is the whole reason these are separate accounts.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.ensure_worker_identities(p_tenant_id uuid)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_created integer := 0;
  v_spec    record;
BEGIN
  FOR v_spec IN
    SELECT * FROM (VALUES
      ('Helm Expiry Alerts',    'system_alerts', NULL::text[]),
      ('Helm Integration Sync', 'system_sync',   ARRAY['integration']),
      ('Helm Audit Anchoring',  'system_audit',  NULL::text[]),
      ('Helm Export Rendering', 'system_export', ARRAY['export'])
    ) AS s(name, role_key, purposes)
  LOOP
    INSERT INTO service_account (
      tenant_id, name, description, role_key,
      org_scope_all, allowed_reveal_purposes, is_system
    )
    VALUES (
      p_tenant_id, v_spec.name,
      'Built-in background worker identity. Managed by Helm; do not edit.',
      v_spec.role_key, true, v_spec.purposes, true
    )
    ON CONFLICT ON CONSTRAINT service_account_name_uk DO NOTHING;

    IF FOUND THEN v_created := v_created + 1; END IF;
  END LOOP;

  RETURN v_created;
END;
$$;

CREATE OR REPLACE FUNCTION helm.provision_worker_identities() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM helm.ensure_worker_identities(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_worker_identities
  AFTER INSERT ON tenant
  FOR EACH ROW EXECUTE FUNCTION helm.provision_worker_identities();

REVOKE ALL ON FUNCTION helm.ensure_worker_identities(uuid) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- System identities are not editable from the application.
--
-- Their role and purpose restriction ARE the security boundary described at the
-- top of this file. A well-meaning administrator widening the sync account's
-- purposes would silently hand it the vault, so the database refuses rather
-- than relying on a UI that hides the fields.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.protect_system_service_accounts() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'helm: % is a built-in worker identity and cannot be deleted', OLD.name
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'Disable the worker instead, or disable the tenant.';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.is_system AND (
       NEW.role_key IS DISTINCT FROM OLD.role_key
    OR NEW.allowed_reveal_purposes IS DISTINCT FROM OLD.allowed_reveal_purposes
    OR NEW.org_scope_all IS DISTINCT FROM OLD.org_scope_all
    OR NEW.org_scope IS DISTINCT FROM OLD.org_scope
    OR NEW.is_system IS DISTINCT FROM OLD.is_system
  ) THEN
    RAISE EXCEPTION 'helm: the authorisation of built-in worker identity % is fixed', OLD.name
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'disabled_at is the supported way to stop a built-in worker.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER service_account_protect_system
  BEFORE UPDATE OR DELETE ON service_account
  FOR EACH ROW EXECUTE FUNCTION helm.protect_system_service_accounts();
