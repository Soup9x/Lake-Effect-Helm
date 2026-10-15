-- =============================================================================
-- 0680 — Documentation health, and a logo somebody can actually upload
--
-- Two features, one migration, because both are about a client's documentation
-- as a thing you look at rather than a thing you read.
--
-- =============================================================================
-- PART 1: HEALTH, AND WHY IT IS COUNTS RATHER THAN A SCORE
-- =============================================================================
--
-- IT Glue shows a "Documentation Health" ring. The temptation is to copy the
-- number, and G's decision 20 already settled why not: Helm can see what has
-- been documented, not what EXISTS, and a blended percentage is an invented
-- weighting pretending to be a judgement. "68% healthy" starts an argument;
-- "11 of 34 records have not been revised since they were created" starts a
-- morning's work.
--
-- So this migration stores no score and computes no score. v_documentation_health
-- returns four counts over a client's own non-archived asset_node rows, three of
-- them a disjoint partition:
--
--   current        revised inside the window
--   stale          revised, but longer ago than the window
--   never_revised  created before the window and never revised since
--
-- and separately:
--
--   unviewed       nobody has opened it inside the window
--
-- The denominator is `asset_node` and nothing else, deliberately: it is the
-- same denominator G's coverage grid uses, so the two pages cannot come to
-- disagree about what a client "has". Documents, contacts and sites are real
-- documentation and are counted by neither; that is noted in both places
-- rather than left as a silent omission.
--
-- `never_revised` IS `updated_at = created_at`, which is exact except in one
-- case: now() is transaction-scoped, so a record created and then edited inside
-- a single transaction carries identical timestamps and reads as never revised.
-- No write path in Helm does that today (C2's edit is a separate request, so a
-- separate transaction) and the consequence of being wrong is one row in the
-- wrong segment of a ring, which is the right direction for a proxy to fail in.
--
-- =============================================================================
-- PART 2: "NOT VIEWED RECENTLY" HAD NO DATA SOURCE, AND THIS IS THE CARVE-OUT
-- =============================================================================
--
-- Decision 3 specified this signal as "tenant-wide, from audit_log". That is
-- not implementable and the reason is worth writing down, because it was only
-- found by going looking:
--
--   audit_log HAS NO VIEW EVENTS. It records security-relevant events — a
--   reveal, a rotation, an export, a refusal — and src/lib/clients/activity.ts
--   argues at length that it must not record ordinary field edits. A fortiori
--   it must not record every page view: it is append-only, hash-chained and
--   anchored hourly, so a read-traffic log would make the chain grow with
--   browsing and would record WHO READ WHAT, which is the disclosure decisions
--   5 and 7 exist to prevent.
--
--   user_recent_view IS A RECENTS LIST, NOT A HISTORY. helm.record_view()
--   trims it to each user's 50 most recent rows, so a node drops off after 50
--   newer views whatever its age. Aggregating it would report "never viewed"
--   for anything a busy technician looked at 51 pages ago.
--
-- So the fact is stored, by the function that already runs on every node page
-- view. It records WHEN anyone last opened the row and never WHO — there is
-- nowhere to put a person, so it cannot disclose one person's reading habits.
--
-- IT IS ITS OWN TABLE, AND THE FIRST ATTEMPT PROVED WHY. The obvious design is
-- a `last_viewed_at` column on asset_node. That was written, applied, and
-- measured — and it silently destroyed the feature it was for:
--
--     asset_node_touch BEFORE UPDATE ON asset_node EXECUTE helm.touch_updated_at()
--
-- fires on ANY update of the row and sets `updated_at := now()`. So opening a
-- node marked it as freshly REVISED. A record measured at 400 days old read as
-- 0 days old immediately after being viewed, which means `stale_count` would
-- have counted only the records nobody had looked at — the other measure
-- entirely. The ring would have been wrong in the most expensive way available:
-- plausible, and improving as people browsed.
--
-- Guarding the trigger was the alternative and is worse. Narrowing it to
-- `UPDATE OF <column list>` means a column added later silently stops bumping
-- `updated_at`, which is a quieter failure than the one being fixed; teaching
-- helm.touch_updated_at() to recognise a view-only update puts table-specific
-- knowledge in a function eleven tables share.
--
-- The real lesson is about meaning rather than triggers. `asset_node.updated_at`
-- means "when was this documentation last revised", and the Recently Updated
-- widget, src/lib/clients/activity.ts's documented split and now this ring all
-- depend on that. A read path writing ANYTHING to asset_node leaves that
-- meaning one trigger away from being false. node_view_stat keeps read traffic
-- off the documentation table completely, so the mistake is unavailable rather
-- than guarded.
--
-- THE CARVE-OUT, stated plainly because it is a permissions change. A client
-- read-only user must be able to cause this write and holds no asset:write, so
-- a single-statement SECURITY DEFINER function does it:
--
--   helm.touch_node_view(p_node_id)
--
-- It takes the tenant from the SESSION (helm.require_tenant_id()) and never
-- from its argument, so a caller handing over another tenant's node id writes
-- nothing. helm_app is granted SELECT on node_view_stat and no write privilege
-- at all, so the function is the only way in — the gate is the privilege, not a
-- policy somebody could widen.
--
-- helm.record_view() itself stays SECURITY INVOKER. Making IT definer would
-- have put its user_recent_view writes outside RLS too, for no gain.
--
-- =============================================================================
-- PART 3: THE LOGO, AND WHY IT IS NOT AN ATTACHMENT
-- =============================================================================
--
-- organization.logo_url has existed since 0010 and nothing could ever fill it
-- except by somebody pasting a URL. The bytes now have somewhere to live.
--
-- NOT AN `attachment` ROW, which was the obvious reuse and is wrong. A logo is
-- chrome, not documentation: as an attachment it would appear in the client's
-- document tree, be deletable by anyone holding asset:write, and be rendered
-- into an export bundle as a file the client did not attach. Worse, every query
-- that lists documents would have to remember to exclude it — a filter somebody
-- will forget, which is the exact class of defect this project keeps finding
-- (an unanchored .gitignore in G, a missing deleted_at in two places).
--
-- THE STORAGE LAYER IS REUSED, which is what the plan asked for: the same
-- filesystem store documents use, the same tenant DEK, the same nonce pairing.
-- One place writes bytes to disk and one place encrypts them.
--
-- SVG IS REFUSED. An SVG served from Helm's own origin is a script execution
-- vector — <svg><script> runs with the session's cookies — and "it is only a
-- logo" is how that gets waved through. PNG, JPEG, WebP and GIF are raster
-- formats a browser cannot be talked into executing. A tenant that wants a
-- vector logo converts it, which is a worse experience than an XSS is a
-- disaster.
--
-- ONE LOGO PER CLIENT, enforced by making organization_id the primary key
-- rather than by a route that deletes the old row first and hopes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The window, and the one place its default lives.
--
-- A literal 180 in the column default AND again in the view's coalesce is two
-- copies that drift the first time somebody changes one. The function is the
-- single source, used by both, and src/lib/health/window.ts mirrors it with a
-- test asserting the two agree — the same construction D used for the sidebar
-- slug list.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.default_health_days()
  RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT 180 $$;

COMMENT ON FUNCTION helm.default_health_days() IS
  'Decision 3''s 180 days, in one place. The column default and '
  'v_documentation_health both call it so they cannot disagree.';

CREATE TABLE documentation_health_setting (
  tenant_id            uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,

  -- Two windows rather than one, because they measure different things: an MSP
  -- may well consider a year acceptable for a record to go unrevised while
  -- wanting to know about anything nobody has opened in a quarter. Same
  -- default, so a tenant that never touches this gets decision 3's number for
  -- both.
  stale_after_days     integer NOT NULL DEFAULT helm.default_health_days(),
  unviewed_after_days  integer NOT NULL DEFAULT helm.default_health_days(),

  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES app_user(id) ON DELETE SET NULL,

  -- A day is the smallest window that is not a stopwatch, and ten years is
  -- past the point where "stale" means anything. Bounds exist so the number
  -- cannot be set to something that makes the ring meaningless rather than
  -- wrong.
  CONSTRAINT documentation_health_stale_bounds
    CHECK (stale_after_days BETWEEN 1 AND 3650),
  CONSTRAINT documentation_health_unviewed_bounds
    CHECK (unviewed_after_days BETWEEN 1 AND 3650)
);

COMMENT ON TABLE documentation_health_setting IS
  'Per-tenant windows for the documentation health ring. Its own table rather '
  'than tenant.settings: 0620''s rule is that a feature with a rule of its own '
  'gets a table with that rule on it, so one feature''s invariant cannot be '
  'overwritten by a caller that never knew it existed.';

-- -----------------------------------------------------------------------------
-- When anyone last opened a node, and how often.
--
-- A row exists only once something has been opened, so "no row" is "never
-- opened" — a real and common state rather than a missing value, and one that
-- needs no backfill. A default of now() on every existing node would have
-- reported the whole estate as freshly read on the morning of the upgrade.
--
-- NO ACTOR COLUMN, and that is the design rather than an omission. Decisions 5
-- and 7 keep read activity from being attributable; this table cannot attribute
-- anything because there is nowhere to write a name. `view_count` is the same
-- shape `secret.access_count` already has for reveals.
--
-- last_viewed_at IS NOT INDEXED. The health aggregate scans one client's nodes
-- and joins this on its primary key; an index on the timestamp would be
-- rewritten on every page view for a query that never seeks on it.
-- -----------------------------------------------------------------------------
CREATE TABLE node_view_stat (
  node_id        uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  last_viewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  view_count     bigint      NOT NULL DEFAULT 1,

  CONSTRAINT node_view_stat_node_fk FOREIGN KEY (node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT node_view_stat_count_positive CHECK (view_count > 0)
);

COMMENT ON TABLE node_view_stat IS
  'When anyone last opened a node. Separate from asset_node because that '
  'table''s updated_at means "last revised" and a BEFORE UPDATE trigger sets '
  'it on any write — so a view recorded there marked the record as revised. '
  'See 0680''s header.';

-- -----------------------------------------------------------------------------
-- The carve-out. One statement, one column, tenant from the session.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.touch_node_view(p_node_id uuid)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  -- The tenant comes from the session context and NOT from the argument, so a
  -- caller handing over another tenant's node id writes nothing: the composite
  -- foreign key to (asset_node.id, tenant_id) has no row to point at and the
  -- insert is refused. This is the whole reason the function can be SECURITY
  -- DEFINER safely.
  INSERT INTO node_view_stat (node_id, tenant_id, last_viewed_at, view_count)
  SELECT p_node_id, v_tenant, clock_timestamp(), 1
  WHERE EXISTS (
    SELECT 1 FROM asset_node WHERE id = p_node_id AND tenant_id = v_tenant
  )
  ON CONFLICT (node_id) DO UPDATE
    SET last_viewed_at = clock_timestamp(),
        view_count = node_view_stat.view_count + 1;
END;
$$;

COMMENT ON FUNCTION helm.touch_node_view(uuid) IS
  'Records that somebody opened a node. SECURITY DEFINER because a client '
  'read-only user holds no write privilege on node_view_stat; scoped to the '
  'session tenant so the definer rights cannot be aimed elsewhere.';

-- -----------------------------------------------------------------------------
-- record_view() now touches the node too.
--
-- Reissued whole rather than patched, because an applied migration is
-- immutable and this is the function 0370 defined. The only change is the
-- helm.touch_node_view() call in the node branch; everything else, including
-- the 50-row trim, is 0370's and is reproduced verbatim.
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
    VALUES (v_tenant, v_actor, p_organization_id, clock_timestamp())
    ON CONFLICT (tenant_id, user_id, organization_id)
      WHERE organization_id IS NOT NULL
      DO UPDATE SET viewed_at = clock_timestamp();
  ELSE
    INSERT INTO user_recent_view (tenant_id, user_id, node_id, viewed_at)
    VALUES (v_tenant, v_actor, p_node_id, clock_timestamp())
    ON CONFLICT (tenant_id, user_id, node_id)
      WHERE node_id IS NOT NULL
      DO UPDATE SET viewed_at = clock_timestamp();

    -- 0680. The per-user recents list above answers "what was I looking at";
    -- this answers "is anybody still reading this", which is a property of the
    -- document and survives the 50-row trim below.
    PERFORM helm.touch_node_view(p_node_id);
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
-- The ring, per client.
--
-- security_invoker, and that is not boilerplate: without it the view runs with
-- the OWNER's privileges, and the owner is the migrating role, which bypasses
-- RLS. v_client_health shipped without it once and a client administrator at
-- one MSP's client could list every client in every tenant. §27 of
-- db/tests/security.sql asserts no public view omits it, because of that.
--
-- LEFT JOIN on the setting so a tenant that has never configured this gets
-- decision 3's default from the one function that holds it.
--
-- A client with no documentation at all is PRESENT with four zeroes rather than
-- absent, same as v_client_health: a health column that silently omits the
-- quiet clients is a page that makes an MSP look busier than it is.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_documentation_health
  WITH (security_invoker = true, security_barrier = true) AS
SELECT
  o.id        AS organization_id,
  o.tenant_id,
  coalesce(s.stale_after_days, helm.default_health_days())    AS stale_after_days,
  coalesce(s.unviewed_after_days, helm.default_health_days()) AS unviewed_after_days,

  count(n.id)::int AS total_count,

  -- The three disjoint segments. Each FILTER is written so the three cannot
  -- overlap or leave a gap: current is the complement of the cutoff, and the
  -- other two partition what is left by whether anybody ever revised it.
  count(n.id) FILTER (
    WHERE n.updated_at >= now()
      - make_interval(days => coalesce(s.stale_after_days, helm.default_health_days()))
  )::int AS current_count,

  count(n.id) FILTER (
    WHERE n.updated_at < now()
        - make_interval(days => coalesce(s.stale_after_days, helm.default_health_days()))
      AND n.updated_at > n.created_at
  )::int AS stale_count,

  count(n.id) FILTER (
    WHERE n.updated_at < now()
        - make_interval(days => coalesce(s.stale_after_days, helm.default_health_days()))
      AND n.updated_at = n.created_at
  )::int AS never_revised_count,

  -- Beside the ring rather than in it. No row in node_view_stat is "never
  -- opened", which counts as unviewed: a record nobody has ever opened is the
  -- strongest case of the thing this number is for.
  count(n.id) FILTER (
    WHERE v.last_viewed_at IS NULL
       OR v.last_viewed_at < now()
        - make_interval(days => coalesce(s.unviewed_after_days, helm.default_health_days()))
  )::int AS unviewed_count,

  max(n.updated_at)       AS last_revised_at,
  max(v.last_viewed_at)   AS last_viewed_at
FROM organization o
LEFT JOIN documentation_health_setting s ON s.tenant_id = o.tenant_id
LEFT JOIN asset_node n
  ON n.organization_id = o.id
 AND n.archived_at IS NULL
-- On node_view_stat's primary key, so this costs an index lookup per node and
-- cannot fan out — one row per node by construction.
LEFT JOIN node_view_stat v ON v.node_id = n.id
WHERE o.deleted_at IS NULL
GROUP BY o.id, o.tenant_id, s.stale_after_days, s.unviewed_after_days;

COMMENT ON VIEW v_documentation_health IS
  'Counts, never a score — see 0680''s header and decision 20. Three disjoint '
  'segments over a client''s non-archived asset_node rows, plus how many '
  'nobody has opened lately.';

-- -----------------------------------------------------------------------------
-- The logo.
-- -----------------------------------------------------------------------------
CREATE TABLE organization_logo (
  -- One per client, by construction rather than by a route that remembers to
  -- delete the old one.
  organization_id  uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,

  content_type     text   NOT NULL,
  byte_size        bigint NOT NULL,
  storage_key      text   NOT NULL,
  -- Doubles as the ETag, so a browser re-fetches a logo exactly when the bytes
  -- changed and never otherwise.
  content_sha256   bytea  NOT NULL,

  -- Encrypted with the tenant DEK before it touches the disk, exactly as
  -- `attachment` is. The bytes are a client's branding and not very secret; the
  -- SET of clients an MSP has is, and a logo file named after one of them in a
  -- backup says it out loud.
  data_key_id      uuid,
  encryption_nonce bytea,

  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  uploaded_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT organization_logo_tenant_uk UNIQUE (organization_id, tenant_id),
  CONSTRAINT organization_logo_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT organization_logo_key_fk FOREIGN KEY (data_key_id, tenant_id)
    REFERENCES tenant_data_key (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT organization_logo_storage_key_uk UNIQUE (storage_key),
  CONSTRAINT organization_logo_sha_len CHECK (octet_length(content_sha256) = 32),
  CONSTRAINT organization_logo_size_positive CHECK (byte_size > 0),
  CONSTRAINT organization_logo_nonce_len CHECK (
    encryption_nonce IS NULL OR octet_length(encryption_nonce) = 12
  ),
  CONSTRAINT organization_logo_encryption_paired CHECK (
    (data_key_id IS NULL) = (encryption_nonce IS NULL)
  ),
  -- Raster only. An SVG served from this origin is a script execution vector,
  -- and the route refuses one too — this is the half that is true of the column
  -- whatever calls it.
  CONSTRAINT organization_logo_raster_only CHECK (
    content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  )
);

COMMENT ON TABLE organization_logo IS
  'A client''s uploaded logo. Not an attachment row: a logo is chrome rather '
  'than documentation, and as an attachment it would appear in the document '
  'tree and in export bundles. See 0680''s header.';

-- =============================================================================
-- Grants and RLS
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON documentation_health_setting TO helm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_logo TO helm_app;
GRANT SELECT ON v_documentation_health TO helm_app, helm_auditor;

-- SELECT ONLY, and that is the gate. helm.touch_node_view() is SECURITY
-- DEFINER and writes as the owner; the request role has no write privilege
-- here at all, so the function is the only path in. A policy could be widened
-- by somebody who did not read this file; a missing privilege cannot.
--
-- THE REVOKE IS NOT BELT AND BRACES, it is the whole thing. 0220 sets ALTER
-- DEFAULT PRIVILEGES granting helm_app full DML on every table a later
-- migration creates, so this table arrived with INSERT, UPDATE and DELETE
-- already on it and the GRANT below would have restricted nothing. Guard 2b
-- caught exactly that, on this migration's first run — which is the second
-- time in this file that writing the assertion found the bug.
REVOKE ALL ON node_view_stat FROM helm_app;
GRANT SELECT ON node_view_stat TO helm_app, helm_auditor;

REVOKE ALL ON FUNCTION helm.touch_node_view(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.touch_node_view(uuid) TO helm_app;

ALTER TABLE documentation_health_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE documentation_health_setting FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_logo ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_logo FORCE ROW LEVEL SECURITY;
ALTER TABLE node_view_stat ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_view_stat FORCE ROW LEVEL SECURITY;

-- Read-open within the tenant, write gated on tenant:write — the same split
-- 0620 and 0670 chose, for the same reason: every role benefits from knowing
-- what the window is, because the ring is meaningless without it, and changing
-- it changes what every client's health reads as.
CREATE POLICY documentation_health_setting_rls_select ON documentation_health_setting
  FOR SELECT USING (tenant_id = helm.current_tenant_id());

CREATE POLICY documentation_health_setting_rls_insert ON documentation_health_setting
  FOR INSERT WITH CHECK (
    tenant_id = helm.current_tenant_id() AND helm.has_permission('tenant:write')
  );

CREATE POLICY documentation_health_setting_rls_update ON documentation_health_setting
  FOR UPDATE USING (
    tenant_id = helm.current_tenant_id() AND helm.has_permission('tenant:write')
  ) WITH CHECK (
    tenant_id = helm.current_tenant_id() AND helm.has_permission('tenant:write')
  );

CREATE POLICY documentation_health_setting_rls_delete ON documentation_health_setting
  FOR DELETE USING (
    tenant_id = helm.current_tenant_id() AND helm.has_permission('tenant:write')
  );

-- A view record follows the node it belongs to. Readable by anybody who can
-- see the node, so the health ring works for a client user looking at their
-- own organisation; writable within the tenant, because the PRIVILEGE is what
-- keeps the request role out (see the grant above) and this policy exists for
-- the definer function, which runs as the owner under FORCE ROW LEVEL
-- SECURITY.
--
-- No permission predicate on the write deliberately: a client read-only user
-- opening their own documentation is exactly who has to be able to cause it,
-- and the worst a forged write could claim is that somebody read something.
-- There is no actor here to impersonate and nothing to escalate.
CREATE POLICY node_view_stat_rls_select ON node_view_stat
  FOR SELECT USING (
    tenant_id = helm.current_tenant_id() AND helm.node_visible(node_id)
  );

CREATE POLICY node_view_stat_rls_insert ON node_view_stat
  FOR INSERT WITH CHECK (tenant_id = helm.current_tenant_id());

CREATE POLICY node_view_stat_rls_update ON node_view_stat
  FOR UPDATE USING (tenant_id = helm.current_tenant_id())
  WITH CHECK (tenant_id = helm.current_tenant_id());

CREATE POLICY node_view_stat_rls_delete ON node_view_stat
  FOR DELETE USING (
    tenant_id = helm.current_tenant_id() AND helm.has_permission('asset:write')
  );

-- A logo follows the client it belongs to: visible to anybody who can see the
-- organisation, writable by whoever may edit it. organization:write is the
-- permission the PATCH route already names, so the route and the policy cannot
-- come to disagree about who may change how a client looks.
--
-- org_in_scope, so a client user sees their own logo and not another client's.
-- No internal_visible: a logo is not documentation and carries no
-- is_internal_only flag to respect.
CREATE POLICY organization_logo_rls_select ON organization_logo
  FOR SELECT USING (
    tenant_id = helm.current_tenant_id() AND helm.org_in_scope(organization_id)
  );

CREATE POLICY organization_logo_rls_insert ON organization_logo
  FOR INSERT WITH CHECK (
    tenant_id = helm.current_tenant_id()
    AND helm.org_in_scope(organization_id)
    AND helm.has_permission('organization:write')
  );

CREATE POLICY organization_logo_rls_update ON organization_logo
  FOR UPDATE USING (
    tenant_id = helm.current_tenant_id()
    AND helm.org_in_scope(organization_id)
    AND helm.has_permission('organization:write')
  ) WITH CHECK (
    tenant_id = helm.current_tenant_id()
    AND helm.org_in_scope(organization_id)
    AND helm.has_permission('organization:write')
  );

CREATE POLICY organization_logo_rls_delete ON organization_logo
  FOR DELETE USING (
    tenant_id = helm.current_tenant_id()
    AND helm.org_in_scope(organization_id)
    AND helm.has_permission('organization:write')
  );

-- =============================================================================
-- Guards
-- =============================================================================
DO $health_guard$
BEGIN
  -- 1. VIEW TRAFFIC DOES NOT TOUCH asset_node. THE GUARD THIS MIGRATION EXISTS
  --    FOR. The first version of this feature put last_viewed_at on asset_node,
  --    where asset_node_touch (BEFORE UPDATE, helm.touch_updated_at()) set
  --    updated_at := now() on every view — so opening a record marked it as
  --    freshly revised and a 400-day-old node measured as 0 days old. The ring
  --    would have counted only unread records as stale.
  --
  --    Asserted, not remembered: any such column reappearing on asset_node
  --    fails the migration, because the trigger that broke it is still there
  --    and still correct for the writes it is actually for.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'asset_node'
      AND column_name IN ('last_viewed_at', 'view_count', 'last_opened_at')
  ) THEN
    RAISE EXCEPTION
      'helm: a view-tracking column appeared on asset_node; asset_node_touch '
      'would set updated_at on every page view and "stale" would stop meaning '
      '"unrevised" — see 0680. It belongs on node_view_stat';
  END IF;

  -- 2. AND THE TRIGGER THAT MAKES THAT TRUE IS STILL THERE. If somebody drops
  --    asset_node_touch, `updated_at` stops being maintained and every record
  --    reads as current forever — the same measure broken from the other end.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.asset_node'::regclass
      AND tgname = 'asset_node_touch' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'helm: asset_node_touch is gone; updated_at would stop being maintained '
      'and the health ring would read every record as current';
  END IF;

  -- 2b. THE REQUEST ROLE CANNOT WRITE VIEW STATS DIRECTLY. The definer function
  --     is the only way in, and it is a missing privilege rather than a policy
  --     that enforces it.
  IF has_table_privilege('helm_app', 'node_view_stat', 'INSERT')
    OR has_table_privilege('helm_app', 'node_view_stat', 'UPDATE') THEN
    RAISE EXCEPTION
      'helm: helm_app can write node_view_stat directly; helm.touch_node_view() '
      'should be the only path — see 0680';
  END IF;

  -- 3. THE CARVE-OUT IS THE SMALL FUNCTION, NOT THE BIG ONE. If record_view()
  --    itself ever becomes SECURITY DEFINER, its user_recent_view writes leave
  --    RLS as well, which is a much larger blast radius for no gain.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'touch_node_view' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'helm: touch_node_view must be SECURITY DEFINER or a viewer cannot record a view';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'record_view' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION
      'helm: record_view became SECURITY DEFINER; only touch_node_view should be — see 0680';
  END IF;

  -- 4. AND IT IS NOT REACHABLE BY ANYBODY ELSE. A definer function granted to
  --    PUBLIC is a definer function the auth role can call.
  IF has_function_privilege('public', 'helm.touch_node_view(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: touch_node_view is executable by PUBLIC';
  END IF;
  IF NOT has_function_privilege('helm_app', 'helm.touch_node_view(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app cannot record a node view';
  END IF;

  -- 5. THE VIEW RUNS AS ITS CALLER. The one that did not cost this project a
  --    cross-tenant disclosure; see v_client_health in 0370.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relname = 'v_documentation_health'
      AND 'security_invoker=true' = ANY (c.reloptions)
  ) THEN
    RAISE EXCEPTION 'helm: v_documentation_health must set security_invoker';
  END IF;

  -- 6. THE SEGMENTS PARTITION THE TOTAL. Written as three FILTERs that must sum
  --    to the count, which is the kind of thing that is true when written and
  --    false after an edit. Checked against the live catalogue definition rather
  --    than trusted: if somebody adds a fourth segment or narrows `current`,
  --    this stops being an identity and the assertion in security.sql §49 fails
  --    on real rows. Here, just that all five columns exist.
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'v_documentation_health'
      AND column_name IN ('total_count', 'current_count', 'stale_count',
                          'never_revised_count', 'unviewed_count')
  ) <> 5 THEN
    RAISE EXCEPTION 'helm: v_documentation_health is missing one of its counts';
  END IF;

  -- 7. NO SCORE. Decision 20, enforced rather than remembered: the moment a
  --    `health_score` or `health_percent` column appears here, somebody has
  --    started shipping the number this design exists to avoid.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'v_documentation_health'
      AND (column_name LIKE '%score%' OR column_name LIKE '%percent%')
  ) THEN
    RAISE EXCEPTION
      'helm: v_documentation_health grew a score column; this view returns '
      'counts on purpose — see decision 20';
  END IF;

  -- 8. THE DEFAULT HAS ONE HOME. If the column default is ever written as a
  --    literal, it and the view can drift.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documentation_health_setting'
      AND column_name = 'stale_after_days'
      AND column_default LIKE '%default_health_days%'
  ) THEN
    RAISE EXCEPTION 'helm: the stale window default must come from helm.default_health_days()';
  END IF;

  -- 9. A LOGO IS NOT AN ATTACHMENT. Asserted because the reuse is tempting and
  --    the consequence — a logo in the document tree and in export bundles — is
  --    invisible until a client asks why their logo is in their documentation.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'attachment' AND column_name IN ('is_logo', 'logo', 'kind')
  ) THEN
    RAISE EXCEPTION 'helm: a logo marker appeared on attachment; logos have their own table — see 0680';
  END IF;

  -- 10. RASTER ONLY, as a constraint rather than a route check.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organization_logo_raster_only'
  ) THEN
    RAISE EXCEPTION 'helm: the logo content-type allowlist is gone; an SVG here is an XSS';
  END IF;

  -- 11. BOTH TABLES ARE BEHIND RLS, FORCED, WITH A POLICY PER COMMAND.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'documentation_health_setting'
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'helm: documentation_health_setting needs RLS, forced';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'organization_logo'
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'helm: organization_logo needs RLS, forced';
  END IF;
  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relname = 'documentation_health_setting') <> 4 THEN
    RAISE EXCEPTION 'helm: documentation_health_setting needs a policy per command';
  END IF;
  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relname = 'organization_logo') <> 4 THEN
    RAISE EXCEPTION 'helm: organization_logo needs a policy per command';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'node_view_stat'
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'helm: node_view_stat needs RLS, forced';
  END IF;
  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relname = 'node_view_stat') <> 4 THEN
    RAISE EXCEPTION 'helm: node_view_stat needs a policy per command';
  END IF;
END;
$health_guard$;
