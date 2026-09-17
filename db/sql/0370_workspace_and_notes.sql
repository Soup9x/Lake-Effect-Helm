-- =============================================================================
-- 0370_workspace_and_notes.sql — per-user workspace state, notes, client health
--
-- Four things that look unrelated and share one idea: everything here belongs
-- to ONE PERSON inside ONE TENANT, and is worthless — or worse, misleading —
-- if it leaks between either.
--
--   user_favorite       clients somebody pinned
--   user_recent_view    what they opened, most recent first
--   user_dashboard      which widgets they want, in what order
--   notes               informal context on a client and the things under it
--
-- The first three are scoped by a policy naming both the tenant AND the acting
-- user, rather than by tenant alone like almost every other table in this
-- schema. That is the point: a technician's recently-viewed list is a record of
-- which clients they have been looking at, and an MSP where everybody can read
-- everybody else's is one where "who has been in this account" is answerable by
-- anyone rather than by the audit log.
--
-- `notes` is deliberately a plain text column and not a table. It is informal
-- context — "uses a nonstandard VPN setup" — not documentation, not versioned
-- and not threaded. A notes TABLE is how it becomes a second, worse comment
-- system that nobody maintains; a column is what it actually is.
--
-- Client health is a VIEW, not a column. It is derived entirely from
-- expirations, which already compute severity in helm.expiration_severity(),
-- and a stored copy is a copy that goes stale the moment a certificate expires
-- with nobody logged in. Nothing here re-implements that function.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Notes.
--
-- credential.notes already exists from 0070; this brings the other three up to
-- it so the field means the same thing everywhere it appears.
-- -----------------------------------------------------------------------------
ALTER TABLE organization ADD COLUMN notes text;
ALTER TABLE site         ADD COLUMN notes text;
ALTER TABLE asset_node   ADD COLUMN notes text;

COMMENT ON COLUMN organization.notes IS
  'Informal context for whoever opens this next. Not documentation: a SOP, a '
  'flexible asset or an attachment is where something that must be findable '
  'and reviewable belongs.';
COMMENT ON COLUMN asset_node.notes IS
  'Informal context. Distinct from `description`, which is what this asset IS; '
  'notes are what somebody needs to know about it.';

-- Notes are free text a technician types, and they are shown back to other
-- people. Bounded so one paste cannot make a row unrenderable.
ALTER TABLE organization ADD CONSTRAINT organization_notes_length CHECK (length(notes) <= 4000);
ALTER TABLE site         ADD CONSTRAINT site_notes_length         CHECK (length(notes) <= 4000);
ALTER TABLE asset_node   ADD CONSTRAINT asset_node_notes_length   CHECK (length(notes) <= 4000);
ALTER TABLE credential   ADD CONSTRAINT credential_notes_length   CHECK (length(notes) <= 4000);

-- -----------------------------------------------------------------------------
-- user_favorite — clients somebody pinned.
-- -----------------------------------------------------------------------------
CREATE TABLE user_favorite (
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, user_id, organization_id),
  -- Composite, so a favourite cannot name an organisation in another tenant
  -- even if the row's own tenant_id says otherwise.
  CONSTRAINT user_favorite_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX user_favorite_user_idx ON user_favorite (tenant_id, user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- user_recent_view — what somebody opened, newest first.
--
-- Two nullable references and a CHECK rather than a polymorphic
-- (entity_type, entity_id) pair. Polymorphic columns cannot carry a foreign
-- key, so the list would slowly fill with rows pointing at deleted clients and
-- every reader would need a join that silently drops them. Here the database
-- removes the row when the thing it names goes away.
-- -----------------------------------------------------------------------------
CREATE TABLE user_recent_view (
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  organization_id uuid,
  node_id         uuid,
  viewed_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_recent_view_one_target CHECK (num_nonnulls(organization_id, node_id) = 1),
  CONSTRAINT user_recent_view_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT user_recent_view_node_fk FOREIGN KEY (node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE
);

-- One row per person per thing: opening a client twice moves it up the list
-- rather than appearing twice. Partial, because only one target is ever set.
CREATE UNIQUE INDEX user_recent_view_org_uk
  ON user_recent_view (tenant_id, user_id, organization_id) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX user_recent_view_node_uk
  ON user_recent_view (tenant_id, user_id, node_id) WHERE node_id IS NOT NULL;
CREATE INDEX user_recent_view_recent_idx ON user_recent_view (tenant_id, user_id, viewed_at DESC);

-- -----------------------------------------------------------------------------
-- user_dashboard — which widgets, in what order.
--
-- The layout is jsonb because it is a list of widget keys whose shape belongs
-- to the interface, not to the schema. A table of (widget, position) rows would
-- be a normalised model of something the database never reasons about, and
-- every reorder would be a delete-and-reinsert.
--
-- What the database DOES enforce is that it is an array of known keys, so a
-- malformed layout is refused at write time rather than rendering an empty
-- dashboard somebody has to debug from the browser.
-- -----------------------------------------------------------------------------
-- A CHECK cannot contain a subquery, and validating a jsonb array needs one to
-- walk the elements. So the rule lives in an IMMUTABLE function the constraint
-- calls — which keeps it declarative and keeps the knowledge of what a valid
-- layout is in the database rather than only in the route that writes it.
CREATE OR REPLACE FUNCTION helm.dashboard_layout_valid(p_widgets jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  -- CASE rather than a chain of ANDs: jsonb_array_elements_text() raises on a
  -- non-array, and SQL does not promise to stop evaluating an AND once a
  -- conjunct is false.
  SELECT CASE
    WHEN jsonb_typeof(p_widgets) <> 'array' THEN false
    WHEN jsonb_array_length(p_widgets) > 12 THEN false
    ELSE NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(p_widgets) AS w(key)
           WHERE w.key NOT IN (
             'favorites', 'recently_viewed', 'expirations', 'audit_activity', 'client_health'
           )
         )
         -- A layout listing the same widget twice renders it twice, which
         -- nobody means and the reorder control cannot express.
         AND (SELECT count(DISTINCT w.key) FROM jsonb_array_elements_text(p_widgets) AS w(key))
             = jsonb_array_length(p_widgets)
  END;
$$;

CREATE TABLE user_dashboard (
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  widgets    jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT user_dashboard_layout_valid CHECK (helm.dashboard_layout_valid(widgets))
);

CREATE TRIGGER user_dashboard_touch BEFORE UPDATE ON user_dashboard
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Row level security: yours, in this tenant, and nobody else's.
--
-- Deliberately NOT helm.apply_tenant_rls(), which scopes by tenant alone. These
-- three tables are personal, and a tenant-wide read policy would make one
-- technician's recently-viewed list — a record of which clients they have been
-- looking at — readable by every colleague.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.apply_personal_rls(p_table text) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_read  text := 'tenant_id = helm.current_tenant_id() '
               || 'AND user_id = helm.current_actor_id()';
  v_write text := 'tenant_id = helm.require_tenant_id() '
               || 'AND user_id = helm.current_actor_id()';
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);

  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)',
                 p_table || '_rls_select', p_table, v_read);
  -- WITH CHECK on the write paths names the actor too, so there is no UPDATE
  -- that moves a row onto somebody else's list.
  EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)',
                 p_table || '_rls_insert', p_table, v_write);
  EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',
                 p_table || '_rls_update', p_table, v_read, v_write);
  EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)',
                 p_table || '_rls_delete', p_table, v_read);
END;
$$;

SELECT helm.apply_personal_rls('user_favorite');
SELECT helm.apply_personal_rls('user_recent_view');
SELECT helm.apply_personal_rls('user_dashboard');

-- -----------------------------------------------------------------------------
-- helm.record_view — move something to the top of your recent list.
--
-- An upsert, so opening the same client twice does not fill the list with it.
-- Prunes on write: without that the table grows one row per person per thing
-- they ever opened, forever, to serve a list that shows ten.
--
-- Takes no user id. The actor comes from the session context, which is what
-- makes "record a view against somebody else" unexpressible rather than merely
-- unauthorised.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_view(
  p_organization_id uuid DEFAULT NULL,
  p_node_id         uuid DEFAULT NULL
) RETURNS void
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_actor  uuid := helm.current_actor_id();
  v_keep   constant integer := 50;
BEGIN
  IF v_actor IS NULL THEN RETURN; END IF;
  IF num_nonnulls(p_organization_id, p_node_id) <> 1 THEN
    RAISE EXCEPTION 'helm: record_view takes exactly one of organization_id, node_id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A service account has no recent list; it is not a person browsing.
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = v_actor) THEN RETURN; END IF;

  IF p_organization_id IS NOT NULL THEN
    INSERT INTO user_recent_view (tenant_id, user_id, organization_id, viewed_at)
    VALUES (v_tenant, v_actor, p_organization_id, now())
    ON CONFLICT (tenant_id, user_id, organization_id)
      WHERE organization_id IS NOT NULL
      DO UPDATE SET viewed_at = now();
  ELSE
    INSERT INTO user_recent_view (tenant_id, user_id, node_id, viewed_at)
    VALUES (v_tenant, v_actor, p_node_id, now())
    ON CONFLICT (tenant_id, user_id, node_id)
      WHERE node_id IS NOT NULL
      DO UPDATE SET viewed_at = now();
  END IF;

  DELETE FROM user_recent_view r
  WHERE r.tenant_id = v_tenant AND r.user_id = v_actor
    AND r.viewed_at < (
      SELECT min(keep.viewed_at) FROM (
        SELECT k.viewed_at FROM user_recent_view k
        WHERE k.tenant_id = v_tenant AND k.user_id = v_actor
        ORDER BY k.viewed_at DESC LIMIT v_keep
      ) keep
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- v_client_health — red, amber or green, and why.
--
-- Built ON TOP OF v_expiration_dashboard rather than beside it, so the
-- thresholds are helm.expiration_severity()'s and there is exactly one place
-- that decides what "critical" means. A second copy would drift, and the
-- version a client sees would stop matching the one the alert worker acts on.
--
-- LEFT JOIN: a client with nothing tracked is green, not absent. A health
-- column that silently omits the quiet clients is a dashboard that makes an
-- MSP look busier than it is.
--
-- security_invoker, and this is not boilerplate. Without it a view runs with
-- the OWNER's privileges, and the owner here is the migrating role — which
-- bypasses RLS. This view was written without it, and the result was that a
-- client administrator at one MSP's client could list the name and health of
-- every client in every tenant. §27 of db/tests/security.sql caught it; the
-- blanket assertion there that no public view omits this exists because of it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_client_health
  WITH (security_invoker = true, security_barrier = true) AS
SELECT
  o.id                AS organization_id,
  o.tenant_id,
  o.name              AS organization_name,
  CASE
    WHEN count(*) FILTER (WHERE e.severity IN ('expired', 'critical')) > 0 THEN 'red'
    WHEN count(*) FILTER (WHERE e.severity = 'warning') > 0               THEN 'amber'
    ELSE 'green'
  END                 AS health,
  count(*) FILTER (WHERE e.severity = 'expired')::int  AS expired_count,
  count(*) FILTER (WHERE e.severity = 'critical')::int AS critical_count,
  count(*) FILTER (WHERE e.severity = 'warning')::int  AS warning_count,
  min(e.expires_at) FILTER (
    WHERE e.severity IN ('expired', 'critical', 'warning')
  )                   AS soonest_at,
  -- What to say on hover, without a second round trip per row.
  (array_agg(e.label ORDER BY e.expires_at)
     FILTER (WHERE e.severity IN ('expired', 'critical', 'warning')))[1:3] AS reasons
FROM organization o
LEFT JOIN v_expiration_dashboard e ON e.organization_id = o.id
WHERE o.deleted_at IS NULL
GROUP BY o.id, o.tenant_id, o.name;

COMMENT ON VIEW v_client_health IS
  'Red/amber/green per client, derived from v_expiration_dashboard so the '
  'thresholds are helm.expiration_severity()''s and not a second copy.';

-- =============================================================================
-- Grants
--
-- 0220 sets ALTER DEFAULT PRIVILEGES granting helm_app full DML on tables
-- created by later migrations, which is correct for these three — they are
-- ordinary application data, and RLS is what keeps one person out of another
-- person's rows. Stated explicitly anyway, because "it arrived with the right
-- grants by default" is not something a reader should have to go and verify.
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON user_favorite, user_recent_view, user_dashboard TO helm_app;
GRANT SELECT ON v_client_health TO helm_app, helm_auditor;

REVOKE ALL ON FUNCTION helm.record_view(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.record_view(uuid, uuid) TO helm_app;

-- NOT revoked from helm_worker, and that is not an oversight. helm_worker is a
-- MEMBER of helm_app (0000), deliberately, so that a background job inherits
-- exactly the request path's table privileges and RLS policies — a REVOKE
-- naming helm_worker is a no-op against an inherited grant, and would read as
-- a protection that is not there.
--
-- What keeps the worker out is the policy, not the grant: it runs as a service
-- account, and `user_id = helm.current_actor_id()` matches no row belonging to
-- a person. §26 of db/tests/security.sql establishes that against a live
-- context rather than leaving it as an argument.

-- =============================================================================
-- Guards
-- =============================================================================
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['user_favorite', 'user_recent_view', 'user_dashboard'] LOOP
    -- 1. FORCE, not merely ENABLE. Without FORCE the table owner — which
    --    migrations and any SECURITY DEFINER function run as — reads every
    --    row, and these policies are the only thing separating colleagues.
    IF NOT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = v_table AND relrowsecurity AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'helm: % does not FORCE row level security', v_table;
    END IF;

    -- 2. Every policy on these tables must name the acting user. A policy
    --    scoped by tenant alone would publish one technician's browsing to the
    --    whole MSP, and it is one careless helm.apply_tenant_rls() call away.
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = v_table
        AND coalesce(qual, '') || coalesce(with_check, '') NOT LIKE '%current_actor_id%'
    ) THEN
      RAISE EXCEPTION 'helm: a policy on % is not scoped to the acting user', v_table;
    END IF;

    -- 3. And still scoped by tenant, so a membership in two MSPs keeps two
    --    separate lists.
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = v_table
        AND coalesce(qual, '') || coalesce(with_check, '') NOT LIKE '%tenant_id%'
    ) THEN
      RAISE EXCEPTION 'helm: a policy on % is not scoped to the tenant', v_table;
    END IF;

  END LOOP;

  -- 4. Client health must stay derived. A stored health column is a cache with
  --    no invalidation: a certificate expires at 3am and the badge stays green
  --    until somebody writes to the row.
  IF EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'organization' AND a.attname IN ('health', 'health_status')
      AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'helm: client health is a view over expirations, not a column';
  END IF;

  -- 5. And it must run as the caller. A view without security_invoker runs as
  --    its OWNER, which for everything in db/sql is the migrating role, which
  --    bypasses RLS — so the view would publish every tenant's clients to
  --    anybody granted SELECT on it. That is not hypothetical: this view
  --    shipped without it for exactly as long as it took the security suite
  --    to run.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'v_client_health' AND relkind = 'v'
      AND reloptions @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'helm: v_client_health is not security_invoker and would bypass RLS';
  END IF;

  -- 6. And it must be derived from the one function that defines severity.
  IF NOT EXISTS (
    SELECT 1 FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class c ON c.oid = r.ev_class
    WHERE c.relname = 'v_client_health' AND d.refobjid = 'v_expiration_dashboard'::regclass
  ) THEN
    RAISE EXCEPTION 'helm: v_client_health no longer reads v_expiration_dashboard';
  END IF;
END;
$$;
