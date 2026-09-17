-- =============================================================================
-- 0390_internal_only_rls.sql — make `is_internal_only` mean something
--
-- Helm's premise is that an MSP can document a co-managed client in the same
-- system the client logs into, and keep the things the client must never see —
-- escalation politics, margin analysis, "they are 60 days late paying" — behind
-- `is_internal_only`, on asset_node, attachment and note.
--
-- NO POLICY ANYWHERE CONSULTED IT.
--
-- Every table carrying the flag was protected by tenant and organisation
-- scoping alone, which is precisely the scoping a co-managed client PASSES: the
-- rows are in their tenant and in their organisation. So a client administrator
-- could read, through an ordinary SELECT:
--
--   asset_node        the name and description of internal-only assets
--   attachment        the filename of internal-only uploads
--   note              the full body of internal-only notes
--   search_document   the indexed title and body of all of the above
--   expiration        the asset's HOSTNAME, as the expiry's label
--   audit_log         the label and the change, quoted in metadata
--   secret            the credential's name, as the secret's label
--
-- and, because every view and the graph walk are security_invoker and read
-- those tables under the caller's RLS, the same content through
-- v_expiration_dashboard, v_asset_edge, v_asset_edge_labelled,
-- v_secret_metadata, v_client_health and helm.asset_graph_walk().
--
-- helm.search() was the one path already closed, patched in 0380 when the
-- rewrite made it materially easier to stumble into. That patch stays, and is
-- now belt and braces over this file rather than the only thing holding.
--
-- The fix is a predicate on the POLICY, not a filter in a query, because a
-- filter in a query is a rule that holds for the queries somebody remembered.
-- There were fifteen such queries and the flag held in one of them.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- The predicate.
--
-- `helm.is_tenant_wide()` is the existing test for "this actor works FOR the
-- MSP" as opposed to "this actor is the customer": it reads app_role's
-- is_tenant_wide, which 0350 already refuses to set on a client-side role. So
-- this adds no new concept — it applies an existing one to the columns that
-- were always supposed to depend on it.
--
-- Written as a function rather than inlined five times so there is one place
-- the rule lives, and so a reader of any one policy can find it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.internal_visible(p_is_internal boolean) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  -- NULL is treated as internal. The columns are NOT NULL today; if one is ever
  -- made nullable, the safe reading of "we do not know" is "do not show it".
  SELECT coalesce(NOT p_is_internal, false) OR helm.is_tenant_wide();
$$;

COMMENT ON FUNCTION helm.internal_visible(boolean) IS
  'True when the current actor may see a row carrying this internal-only flag. '
  'MSP-side actors see everything; a co-managed client sees only rows not '
  'marked internal.';

-- -----------------------------------------------------------------------------
-- helm.apply_tenant_rls, extended.
--
-- The generic policy builder gains an optional internal-only column, so a
-- future table that carries one is protected by declaring it rather than by
-- remembering to write the predicate. Trailing parameters with defaults, so
-- every existing call site keeps working unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.apply_tenant_rls(
  p_table       text,
  p_org_scoped  boolean DEFAULT true,
  p_write_rank  integer DEFAULT 40,
  -- Column holding the flag, if the table has one.
  p_internal_column text DEFAULT NULL,
  -- true  => the column means "internal" and is used as-is (is_internal_only).
  -- false => the column means "visible" and is negated. No table uses this
  --          today; it exists so a future inverted flag does not need a second
  --          copy of the builder.
  p_internal_true_means_hidden boolean DEFAULT true
) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_read_predicate  text;
  v_write_predicate text;
  v_internal        text := '';
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);

  IF p_internal_column IS NOT NULL THEN
    v_internal := format(
      ' AND helm.internal_visible(%s)',
      CASE WHEN p_internal_true_means_hidden
           THEN quote_ident(p_internal_column)
           ELSE format('NOT %I', p_internal_column)
      END);
  END IF;

  IF p_org_scoped THEN
    v_read_predicate := 'tenant_id = helm.current_tenant_id() '
                     || 'AND helm.org_in_scope(organization_id)';
    v_write_predicate := 'tenant_id = helm.require_tenant_id() '
                      || 'AND helm.org_in_scope(organization_id) '
                      || format('AND helm.current_role_rank() >= %s', p_write_rank);
  ELSE
    -- Tenant-scoped but not organisation-scoped: settings, type definitions,
    -- integration connections. Only tenant-wide actors may see these at all.
    v_read_predicate := 'tenant_id = helm.current_tenant_id() '
                     || 'AND helm.is_tenant_wide()';
    v_write_predicate := 'tenant_id = helm.require_tenant_id() '
                      || 'AND helm.is_tenant_wide() '
                      || format('AND helm.current_role_rank() >= %s', p_write_rank);
  END IF;

  -- The flag constrains reads AND writes. Without it on the write side a client
  -- actor could not see an internal row but could still UPDATE one blind, or
  -- create a row marked internal that they then could not see themselves.
  v_read_predicate  := v_read_predicate  || v_internal;
  v_write_predicate := v_write_predicate || v_internal;

  EXECUTE format(
    'CREATE POLICY %I ON %I FOR SELECT USING (%s)',
    p_table || '_rls_select', p_table, v_read_predicate);

  EXECUTE format(
    'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)',
    p_table || '_rls_insert', p_table, v_write_predicate);

  -- UPDATE needs both: USING decides which rows you may target, WITH CHECK
  -- decides what they may become. Omitting WITH CHECK lets an UPDATE rewrite
  -- tenant_id and launder a row into another tenant.
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',
    p_table || '_rls_update', p_table, v_read_predicate, v_write_predicate);

  EXECUTE format(
    'CREATE POLICY %I ON %I FOR DELETE USING (%s)',
    p_table || '_rls_delete', p_table, v_write_predicate);
END;
$$;

-- -----------------------------------------------------------------------------
-- Rebuild the four generic tables with the flag applied.
--
-- Dropped and recreated rather than ALTER POLICY, so what each policy says is
-- visible in this file instead of being an expression appended to whatever was
-- there before.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_table text;
  v_cmd   text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['asset_node', 'attachment', 'note', 'search_document'] LOOP
    FOREACH v_cmd IN ARRAY ARRAY['select', 'insert', 'update', 'delete'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', v_table || '_rls_' || v_cmd, v_table);
    END LOOP;
  END LOOP;
END;
$$;

SELECT helm.apply_tenant_rls('asset_node',      true, 40, 'is_internal_only');
SELECT helm.apply_tenant_rls('attachment',      true, 40, 'is_internal_only');
SELECT helm.apply_tenant_rls('note',            true, 40, 'is_internal_only');
SELECT helm.apply_tenant_rls('search_document', true, 40, 'is_internal_only');

-- -----------------------------------------------------------------------------
-- credential, which is a different shape.
--
-- It is an asset_node subtype, so its policy reaches the node rather than
-- carrying an organization_id of its own. Once asset_node's policy hides
-- internal nodes the EXISTS below finds nothing for them, so a credential
-- disappears with the asset it documents.
--
-- That is implicit and is stated explicitly anyway, because a reader should not
-- have to know it to see why this is safe — and because the EXISTS is easy to
-- simplify away by somebody who has not realised it is load-bearing.
--
-- NOT gated on credential.client_visible. See helm.secret_node_visible() below
-- for why that column cannot carry this rule.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS credential_rls_select ON credential;
DROP POLICY IF EXISTS credential_rls_insert ON credential;
DROP POLICY IF EXISTS credential_rls_update ON credential;
DROP POLICY IF EXISTS credential_rls_delete ON credential;

CREATE POLICY credential_rls_select ON credential FOR SELECT
  USING (
    tenant_id = helm.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM asset_node n
      WHERE n.id = credential.id
        AND n.tenant_id = helm.current_tenant_id()
        AND helm.org_in_scope(n.organization_id)
        AND helm.internal_visible(n.is_internal_only)
    )
  );

CREATE POLICY credential_rls_insert ON credential FOR INSERT
  WITH CHECK (
    tenant_id = helm.require_tenant_id()
    AND helm.current_role_rank() >= 40
    AND EXISTS (
      SELECT 1 FROM asset_node n
      WHERE n.id = credential.id
        AND n.tenant_id = helm.require_tenant_id()
        AND helm.org_in_scope(n.organization_id)
        AND helm.internal_visible(n.is_internal_only)
    )
  );

CREATE POLICY credential_rls_update ON credential FOR UPDATE
  USING (
    tenant_id = helm.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM asset_node n
      WHERE n.id = credential.id
        AND n.tenant_id = helm.current_tenant_id()
        AND helm.org_in_scope(n.organization_id)
        AND helm.internal_visible(n.is_internal_only)
    )
  )
  WITH CHECK (
    tenant_id = helm.require_tenant_id()
    AND helm.current_role_rank() >= 40
  );

CREATE POLICY credential_rls_delete ON credential FOR DELETE
  USING (
    tenant_id = helm.current_tenant_id()
    AND helm.current_role_rank() >= 40
    AND EXISTS (
      SELECT 1 FROM asset_node n
      WHERE n.id = credential.id
        AND n.tenant_id = helm.current_tenant_id()
        AND helm.org_in_scope(n.organization_id)
    )
  );

-- =============================================================================
-- The two paths that bypass RLS entirely
--
-- A SECURITY DEFINER function runs as its owner, so the policies above do not
-- apply inside it. Two of them reach flagged content, and each needs the rule
-- restated in its own terms.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- helm.reveal_secret — the flag was never consulted.
--
-- Today a co-managed client administrator is refused a credential on an
-- internal-only asset, but for an unrelated reason: the shipped client roles
-- hold neither `secret:reveal` nor a rank reaching any secret's min_role_rank.
-- Visibility itself is not load-bearing, which was established by granting
-- secret:reveal to client_admin and watching the refusal come back as
-- `insufficient_role_rank` rather than as anything to do with the flag.
--
-- That is a protection made of two coincidences. An MSP that grants a
-- co-managed client `secret:reveal` over their own low-rank credentials — a
-- reasonable thing to want — would find the flag buying them nothing.
--
-- Added to the TOP of the ladder rather than the bottom: "you may not see this
-- at all" is a more specific fact than "your rank is too low", and the audit
-- row should say which one actually applied.
-- -----------------------------------------------------------------------------
/*
 * WHY THIS ASKS ABOUT THE NODE AND NOT ABOUT credential.client_visible.
 *
 * `client_visible` looks like the right column and is not. It defaults to
 * FALSE, and no write path in the product ever sets it — /api/secrets does not
 * accept it and nothing else writes a credential row. So every credential in
 * every deployment carries client_visible = false, meaning "not marked
 * visible" rather than "deliberately hidden".
 *
 * Enforcing it as a visibility gate would therefore hide EVERY credential from
 * EVERY co-managed client, which is a product decision about what co-management
 * means — not a fix to the gap being closed here. db/tests/security.sql §4 has
 * asserted the opposite since the schema was written: a client administrator
 * may see that their own credential exists.
 *
 * So the rule enforced here is asset_node.is_internal_only, which is the flag
 * that actually carries the "the client must never see this" intent, defaults
 * to false, and is settable through the API. A credential hanging off an
 * internal node is hidden with it; a credential on an ordinary node is not.
 *
 * `client_visible` is left alone and is reported separately as an unfinished
 * feature rather than quietly given teeth it was never wired for.
 *
 * SECURITY DEFINER, and that is load-bearing. This reads asset_node to find
 * out whether the node is internal — and under the CALLER's RLS an internal
 * node is invisible, so the join would drop the row and the default would
 * report "visible" for precisely the credential this is meant to hide.
 */
CREATE OR REPLACE FUNCTION helm.secret_node_visible(p_secret_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  -- No credential row points at this secret: it is material without a
  -- documented account, was never part of the credential model, and stays
  -- governed by the controls that always governed it — organisation scope,
  -- secret:reveal, min_role_rank and step-up.
  SELECT coalesce(bool_or(NOT n.is_internal_only), true)
  FROM credential c
  JOIN asset_node n ON n.id = c.id
  WHERE c.secret_id = p_secret_id OR c.totp_secret_id = p_secret_id;
$$;

REVOKE ALL ON FUNCTION helm.secret_node_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.secret_node_visible(uuid) TO helm_app, helm_worker;

-- Copied from the LIVE definition, not from 0210. reveal_secret is redefined in
-- 0290_worker_identities.sql to pin a machine identity to the purposes its job
-- actually has, and the first attempt at this migration took 0210's body —
-- silently reverting that, which four worker tests caught. A function that has
-- been redefined once will be redefined again; the current definition is the
-- only safe source.
CREATE OR REPLACE FUNCTION helm.reveal_secret(p_secret_id uuid, p_reason text DEFAULT NULL::text, p_purpose text DEFAULT 'view'::text, p_version integer DEFAULT NULL::integer)
 RETURNS TABLE(granted boolean, denial_reason text, audit_event_uid uuid, secret_id uuid, version integer, kind secret_kind, algorithm text, ciphertext bytea, nonce bytea, auth_tag bytea, aad text, data_key_id uuid, wrapped_dek bytea, kek_id text, wrap_provider text, wrap_context jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'helm', 'extensions', 'pg_catalog', 'pg_temp'
AS $function$
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
  -- Visibility leads the ladder. Until 0390 this rung did not exist, and a
  -- credential on an internal-only asset was withheld from a co-managed client
  -- only because the shipped client roles happen to hold neither secret:reveal
  -- nor a rank reaching any secret — two coincidences, not a rule.
  --
  -- First rather than last because the audit row records the reason, and "your
  -- rank is too low" is a different fact from "you may not see this at all".
  -- The second is the one an MSP needs when the client asks why.
  IF NOT helm.is_tenant_wide() AND NOT helm.secret_node_visible(v_secret.id) THEN
    v_deny := 'internal_only';
  ELSIF NOT helm.has_permission('secret:reveal') THEN
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
$function$;


-- -----------------------------------------------------------------------------
-- The export bundle: the reader was never the audience.
--
-- This is the path the policies above CANNOT close, and the most serious one.
--
-- A co-managed client administrator holds `export:create`, so they may request
-- an export of their own organisation. The render worker then collects the
-- bundle as its own service account — `system_export`, which is tenant-wide —
-- and hands the resulting file to the person who asked. Every internal-only
-- asset, attachment and note in that organisation went into the bundle,
-- because the principal doing the reading was the MSP's worker and not the
-- client.
--
-- Adding the predicate to asset_node's policy does nothing here: the worker
-- passes it. The fix is to make the reader BE the audience — collect the bundle
-- under the REQUESTER's session context, so RLS answers the question it is
-- already good at. An MSP-requested export is unchanged (a tenant-wide actor
-- still sees everything); a client-requested one now contains exactly what the
-- client could have read a page at a time.
--
-- So the backlog carries the requester's id alongside their name. The worker
-- already receives the names this way, for the same reason: what it needs
-- travels with the job it was authorised to render, rather than being bought
-- with a broad grant.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS helm.export_backlog(integer);

CREATE OR REPLACE FUNCTION helm.export_backlog(p_limit integer DEFAULT 10)
  RETURNS TABLE (
    tenant_id          uuid,
    worker_actor_id    uuid,
    export_job_id      uuid,
    organization_id    uuid,
    kind               export_kind,
    format             text,
    include_secrets    boolean,
    scope              jsonb,
    reason             text,
    requested_by       uuid,
    requested_by_name  text,
    approved_by_name   text,
    requested_at       timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT j.tenant_id, helm.worker_actor(j.tenant_id, 'system_export'),
         j.id, j.organization_id, j.kind, j.format, j.include_secrets, j.scope,
         j.reason,
         j.requested_by,
         coalesce(req.name, req.email::text),
         coalesce(app.name, app.email::text),
         j.created_at
  FROM export_job j
  JOIN tenant t ON t.id = j.tenant_id AND t.status = 'active'
  LEFT JOIN app_user req ON req.id = j.requested_by
  LEFT JOIN app_user app ON app.id = j.approved_by
  WHERE j.status = 'queued'
    AND j.revoked_at IS NULL
    AND j.expires_at > now()
    AND (NOT j.include_secrets OR (
          j.approved_by IS NOT NULL
      AND j.approved_at IS NOT NULL
      AND j.approved_scope_sha256 = digest(
            j.kind::text || '|' || j.format || '|' ||
            j.include_secrets::text || '|' || j.scope::text, 'sha256')))
    AND helm.worker_actor(j.tenant_id, 'system_export') IS NOT NULL
  ORDER BY j.created_at
  LIMIT greatest(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION helm.export_backlog(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.export_backlog(integer) TO helm_worker;

-- =============================================================================
-- Guards
-- =============================================================================
DO $$
DECLARE
  v_table  text;
  v_policy text;
BEGIN
  -- 1. Every table carrying the flag has it named in EVERY policy on it. This
  --    is the assertion that would have caught the original gap: the columns
  --    existed, the flag was set, and not one policy mentioned it.
  FOREACH v_table IN ARRAY ARRAY['asset_node', 'attachment', 'note', 'search_document'] LOOP
    FOR v_policy IN
      SELECT policyname FROM pg_policies WHERE tablename = v_table
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = v_table AND policyname = v_policy
          AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%internal_visible%'
      ) THEN
        RAISE EXCEPTION 'helm: policy % on % does not enforce is_internal_only', v_policy, v_table;
      END IF;
    END LOOP;
  END LOOP;

  -- 2. A credential is hidden with its node. Its SELECT and UPDATE policies
  --    reach asset_node, whose own policy now carries the flag, so there is
  --    nothing to restate — but the reach itself must not be removed.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'credential' AND cmd IN ('SELECT', 'UPDATE')
      AND coalesce(qual, '') NOT LIKE '%internal_visible%'
  ) THEN
    RAISE EXCEPTION 'helm: a credential policy no longer checks its node visibility';
  END IF;

  -- 3. The reveal ladder consults visibility. A SECURITY DEFINER function is
  --    outside the policies entirely, so this is the only thing standing
  --    between a client role granted secret:reveal and a credential the MSP
  --    marked as its own.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'reveal_secret'
      AND pg_get_functiondef(p.oid) LIKE '%secret_node_visible%'
  ) THEN
    RAISE EXCEPTION 'helm: reveal_secret no longer checks node visibility';
  END IF;

  -- 4. The render worker can learn who asked for a job, which is what lets it
  --    collect the bundle as them rather than as itself.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'export_backlog'
      AND pg_get_function_result(p.oid) LIKE '%requested_by uuid%'
  ) THEN
    RAISE EXCEPTION 'helm: export_backlog does not carry the requester';
  END IF;

  -- 5. Still worker-only. Carrying the requester's id is only safe because
  --    nothing else can call this.
  IF has_function_privilege('helm_app', 'helm.export_backlog(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: export_backlog must not be reachable from the request path';
  END IF;
END;
$$;

-- =============================================================================
-- Rows that are ABOUT an internal node without carrying the flag themselves
--
-- The flag lives on asset_node. Three things reference a node and were not
-- covered by putting the predicate on asset_node, because they are separate
-- rows in separate tables with their own policies — and each one names the
-- node it refers to.
--
-- Found by enumerating every table with a node_id column and checking which
-- policies mentioned the flag, rather than by thinking hard about which ones
-- might matter. Two of the three would not have occurred to me.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The predicate, once.
--
-- STABLE and reading asset_node, whose own policy now applies inside it — so
-- "can I see the node" is asked of the same policy that answers it everywhere
-- else, rather than being a second copy of the rule that can drift.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.node_visible(p_node_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  -- No node: nothing to hide. A tenant-level audit event or an expiration on a
  -- contract rather than an asset is unaffected.
  SELECT p_node_id IS NULL
      OR helm.is_tenant_wide()
      OR EXISTS (
           SELECT 1 FROM asset_node n
           WHERE n.id = p_node_id AND NOT n.is_internal_only
         );
$$;

COMMENT ON FUNCTION helm.node_visible(uuid) IS
  'True when the current actor may see the node this row refers to. For rows '
  'that name a node without carrying is_internal_only themselves.';

-- -----------------------------------------------------------------------------
-- expiration — it carries the asset's NAME.
--
-- `expiration.label` for a device warranty is the hostname. So a co-managed
-- client reading their own expiry list saw "acme-fw-01" and its warranty date
-- for a firewall the MSP had marked internal — the name, which is most of what
-- the flag was hiding.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS expiration_rls_select ON expiration;
DROP POLICY IF EXISTS expiration_rls_insert ON expiration;
DROP POLICY IF EXISTS expiration_rls_update ON expiration;
DROP POLICY IF EXISTS expiration_rls_delete ON expiration;

CREATE POLICY expiration_rls_select ON expiration FOR SELECT
  USING (tenant_id = helm.current_tenant_id()
         AND helm.org_in_scope(organization_id)
         AND helm.node_visible(node_id));
CREATE POLICY expiration_rls_insert ON expiration FOR INSERT
  WITH CHECK (tenant_id = helm.require_tenant_id()
              AND helm.org_in_scope(organization_id)
              AND helm.current_role_rank() >= 40
              AND helm.node_visible(node_id));
CREATE POLICY expiration_rls_update ON expiration FOR UPDATE
  USING (tenant_id = helm.current_tenant_id()
         AND helm.org_in_scope(organization_id)
         AND helm.node_visible(node_id))
  WITH CHECK (tenant_id = helm.require_tenant_id()
              AND helm.org_in_scope(organization_id)
              AND helm.current_role_rank() >= 40
              AND helm.node_visible(node_id));
CREATE POLICY expiration_rls_delete ON expiration FOR DELETE
  USING (tenant_id = helm.current_tenant_id()
         AND helm.org_in_scope(organization_id)
         AND helm.current_role_rank() >= 40
         AND helm.node_visible(node_id));

-- -----------------------------------------------------------------------------
-- audit_log — the metadata quotes the thing that changed.
--
-- client_admin holds `audit:read`, deliberately: a co-managed customer being
-- able to see who touched their documentation is a feature. But an audit row
-- carries `metadata`, and metadata for an action on an asset carries its label
-- and often the change itself — so the client could read
-- `{"label": "acme-fw-01", "note": "INTERNAL escalation path changed"}` for a
-- node they could not open.
--
-- The row is NOT removed and the chain is untouched: this narrows one reader's
-- view, exactly as the organisation scoping beside it already does. The MSP and
-- the auditor role still see everything, which is what makes the log evidence.
--
-- The node test sits inside the client-side branch of the existing predicate,
-- so a tenant-wide reader short-circuits before the lookup and scanning the
-- log costs what it always did.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.apply_audit_partition_rls() RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  r record;
  v_predicate constant text :=
    'tenant_id = helm.current_tenant_id() '
    'AND helm.has_permission(''audit:read'') '
    'AND (helm.is_tenant_wide() OR ('
    '  organization_id IS NOT NULL '
    '  AND helm.org_in_scope(organization_id) '
    '  AND helm.node_visible(node_id)))';
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'audit_log'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.relname || '_rls_select', r.relname);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)',
                   r.relname || '_rls_select', r.relname, v_predicate);
  END LOOP;

  -- The parent too, so a query that does not prune to a partition is scoped.
  EXECUTE 'DROP POLICY IF EXISTS audit_log_rls_select ON audit_log';
  EXECUTE format('CREATE POLICY audit_log_rls_select ON audit_log FOR SELECT USING (%s)',
                 v_predicate);
END;
$$;

SELECT helm.apply_audit_partition_rls();

-- -----------------------------------------------------------------------------
-- v_asset_edge_stored — an edge to a node you cannot see.
--
-- Most of this view is not asset_link rows at all: it PROJECTS edges from
-- foreign keys on the subtype tables, so `ssl_certificate.secures_node_id`
-- becomes an edge from a certificate the client can see to a firewall the MSP
-- marked internal. asset_link's own policy checks both endpoints; the projected
-- branches checked neither, because they never touched asset_node.
--
-- What leaked was not the name — v_asset_edge_labelled joins asset_node for
-- that and so came back empty — but the node's id, its existence, and its
-- topology. An enumeration of the MSP's internal assets by uuid, with their
-- relationships to visible ones.
--
-- Fixed by requiring BOTH ends to resolve to a visible asset_node. Under
-- security_invoker those joins run the caller's own policy, so no rule is
-- restated here: an edge is visible exactly when both of its endpoints are.
--
-- The fourteen branches below are 0075's, unchanged and copied mechanically
-- from the live definition rather than retyped. Retyping them by hand is how
-- the first attempt at this dropped six of them and invented a relation name
-- that does not exist.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_asset_edge_stored
  WITH (security_invoker = true, security_barrier = true) AS
SELECT e.link_id, e.tenant_id, e.source_node_id, e.target_node_id,
       e.relation, e.origin, e.confidence, e.note
FROM (
  SELECT l.id AS link_id,
      l.tenant_id,
      l.source_node_id,
      l.target_node_id,
      l.relation,
      l.origin,
      l.confidence,
      l.note
     FROM asset_link l
  UNION ALL
   SELECT NULL::uuid AS link_id,
      d.tenant_id,
      d.id AS source_node_id,
      d.primary_network_id AS target_node_id,
      'member_of'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100::smallint AS confidence,
      'primary interface'::text AS note
     FROM device d
    WHERE d.primary_network_id IS NOT NULL
  UNION ALL
   SELECT NULL::uuid AS link_id,
      d.tenant_id,
      d.id AS source_node_id,
      d.parent_device_id AS target_node_id,
      'hosted_on'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100 AS confidence,
      'virtualisation host'::text AS note
     FROM device d
    WHERE d.parent_device_id IS NOT NULL
  UNION ALL
   SELECT NULL::uuid AS link_id,
      i.tenant_id,
      i.id AS source_node_id,
      i.network_id AS target_node_id,
      'member_of'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100 AS confidence,
      NULL::text AS note
     FROM ip_address i
    WHERE i.network_id IS NOT NULL
  UNION ALL
   SELECT NULL::uuid AS link_id,
      i.tenant_id,
      i.id AS source_node_id,
      i.assigned_node_id AS target_node_id,
      'resolves_to'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100 AS confidence,
      'address assignment'::text AS note
     FROM ip_address i
    WHERE i.assigned_node_id IS NOT NULL
  UNION ALL
   SELECT NULL::uuid AS link_id,
      c.tenant_id,
      c.id AS source_node_id,
      c.domain_id AS target_node_id,
      'secures'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100 AS confidence,
      NULL::text AS note
     FROM ssl_certificate c
    WHERE c.domain_id IS NOT NULL
  UNION ALL
   SELECT NULL::uuid AS link_id,
      c.tenant_id,
      c.id AS source_node_id,
      c.installed_on_node_id AS target_node_id,
      'secures'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100 AS confidence,
      'certificate installation'::text AS note
     FROM ssl_certificate c
    WHERE c.installed_on_node_id IS NOT NULL
  UNION ALL
   SELECT NULL::uuid AS link_id,
      a.tenant_id,
      a.id AS source_node_id,
      a.hosted_on_node_id AS target_node_id,
      'hosted_on'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100 AS confidence,
      NULL::text AS note
     FROM application a
    WHERE a.hosted_on_node_id IS NOT NULL
  UNION ALL
   SELECT NULL::uuid AS link_id,
      a.tenant_id,
      a.id AS source_node_id,
      a.database_node_id AS target_node_id,
      'depends_on'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100 AS confidence,
      'application database'::text AS note
     FROM application a
    WHERE a.database_node_id IS NOT NULL
  UNION ALL
   SELECT NULL::uuid AS link_id,
      a.tenant_id,
      a.id AS source_node_id,
      a.sso_directory_id AS target_node_id,
      'authenticates_to'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100 AS confidence,
      NULL::text AS note
     FROM application a
    WHERE a.sso_directory_id IS NOT NULL
  UNION ALL
   SELECT NULL::uuid AS link_id,
      l.tenant_id,
      l.id AS source_node_id,
      l.application_id AS target_node_id,
      'licenses'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100 AS confidence,
      NULL::text AS note
     FROM license l
    WHERE l.application_id IS NOT NULL
  UNION ALL
   SELECT NULL::uuid AS link_id,
      n.tenant_id,
      n.id AS source_node_id,
      n.dhcp_server_node_id AS target_node_id,
      'depends_on'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100 AS confidence,
      'DHCP service'::text AS note
     FROM network n
    WHERE n.dhcp_server_node_id IS NOT NULL
  UNION ALL
   SELECT NULL::uuid AS link_id,
      ds.tenant_id,
      ds.id AS source_node_id,
      ds.sync_server_node_id AS target_node_id,
      'hosted_on'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100 AS confidence,
      'directory sync server'::text AS note
     FROM directory_service ds
    WHERE ds.sync_server_node_id IS NOT NULL
  UNION ALL
   SELECT NULL::uuid AS link_id,
      ic.tenant_id,
      ic.id AS source_node_id,
      ic.handoff_device_node_id AS target_node_id,
      'connects_to'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100 AS confidence,
      'circuit handoff'::text AS note
     FROM isp_circuit ic
    WHERE ic.handoff_device_node_id IS NOT NULL
  UNION ALL
   SELECT NULL::uuid AS link_id,
      dm.tenant_id,
      dm.id AS source_node_id,
      dm.registrar_credential_id AS target_node_id,
      'depends_on'::link_relation AS relation,
      'intrinsic'::link_origin AS origin,
      100 AS confidence,
      'registrar account'::text AS note
     FROM domain dm
    WHERE dm.registrar_credential_id IS NOT NULL
) e
-- Both endpoints, under the caller's own RLS. No rule is restated here: an
-- edge is visible exactly when both of the nodes it joins are.
JOIN asset_node src ON src.id = e.source_node_id
JOIN asset_node tgt ON tgt.id = e.target_node_id;

COMMENT ON VIEW v_asset_edge_stored IS
  'Directed edges exactly as authored: asset_link rows plus edges projected '
  'from foreign keys, restricted to edges whose BOTH endpoints the caller may '
  'see. Not for direct traversal — use v_asset_edge.';

-- -----------------------------------------------------------------------------
-- secret — the label is the credential's name.
--
-- `secret` carries its own organization_id and its own policy, and knows
-- nothing about the credential that points at it. So hiding the credential row
-- hid the account but not the material's metadata: v_secret_metadata reads
-- `secret` directly, and a co-managed client administrator could still list
-- "ACME Domain Admin" — the label, its kind, its sensitivity and its rotation
-- state — for a credential documenting an asset marked internal-only.
--
-- Short-circuited on is_tenant_wide() so an MSP-side actor never pays for the
-- lookup, which is every actor on the path where this table is read hardest.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS secret_rls_select ON secret;

CREATE POLICY secret_rls_select ON secret FOR SELECT
  USING (
    tenant_id = helm.current_tenant_id()
    AND helm.org_in_scope(organization_id)
    AND (helm.is_tenant_wide() OR helm.secret_node_visible(id))
  );
