-- =============================================================================
-- 0620 — a sidebar somebody can arrange
--
-- WHAT WAS MISSING. The organization drawer has sixteen categories split into a
-- primary list of eight and a "More" disclosure holding the rest, and that split
-- is a hardcoded `secondary` flag in src/lib/nav/org-categories.ts. It is a
-- reasonable guess at what a technician reaches often. It is still a guess, and
-- it is the same guess for an MSP whose work is networks as for one whose work
-- is licence renewals.
--
-- So the split becomes data: a per-user list of the categories they want in the
-- primary section, in the order they want them, with everything else falling
-- through to "More". The `secondary` flag keeps its job as the DEFAULT — what
-- somebody sees before they have touched anything is exactly what they see
-- today — and stops being the only possible answer.
--
-- TWO TABLES, ONE VALIDATOR:
--
--   user_sidebar             mine, and nobody else's
--   tenant_sidebar_default   what a new user starts with, set by an admin
--
-- COPIED FROM user_dashboard DELIBERATELY, down to the shape of the validator.
-- 0370 chose jsonb over a (category, position) table because a reorder would
-- otherwise be a delete-and-reinsert of a list the database never reasons
-- about, and 0530 is the migration that widens such a list when the interface
-- grows. Both apply here unchanged, and a reader who knows one now knows both.
--
-- NOT IN tenant.settings, and that is on purpose. The header of
-- src/app/api/tenant/route.ts says why `settings` is not settable through a
-- generic endpoint: it is a jsonb bag several features read, and a caller that
-- patches the whole object overwrites an invariant it never knew about. A
-- feature with a rule of its own gets a table with that rule on it.
-- =============================================================================
SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- helm.sidebar_layout_valid — an array of known category slugs, each once.
--
-- The slug list is duplicated in src/lib/nav/org-categories.ts, exactly as the
-- widget list is duplicated in src/lib/workspace/widgets.ts, and for the same
-- reason: the database refuses an unknown slug so a malformed layout is never
-- stored, and the interface needs the labels and icons anyway. The TS side is
-- ORG_CATEGORIES itself rather than a second hand-written list, so there are two
-- copies and not three, and tests/integration/sidebar.test.ts asserts they
-- agree — adding a category to the registry without a migration fails there
-- rather than as an unexplained 500 on somebody's save.
--
-- A CHECK cannot contain a subquery and walking a jsonb array needs one, so the
-- rule lives in an IMMUTABLE function the constraint calls.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.sidebar_layout_valid(p_categories jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  -- CASE rather than a chain of ANDs: jsonb_array_elements_text() raises on a
  -- non-array, and SQL does not promise to stop evaluating an AND once a
  -- conjunct is false.
  SELECT CASE
    WHEN jsonb_typeof(p_categories) <> 'array' THEN false
    -- Twenty, against sixteen categories: room for a few more without a
    -- migration whose only purpose is the ceiling, and still a bound.
    WHEN jsonb_array_length(p_categories) > 20 THEN false
    ELSE NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(p_categories) AS c(slug)
           WHERE c.slug NOT IN (
             -- The primary eight.
             'configurations', 'contacts', 'documents', 'domains',
             'locations', 'networks', 'passwords', 'ssl',
             -- And the eight behind "More", which a person may promote.
             'applications', 'directories', 'circuits', 'contracts',
             'licenses', 'vendors', 'sops', 'ip-addresses'
           )
         )
         -- A layout naming the same category twice would render it twice, which
         -- nobody means and the reorder control cannot express.
         AND (SELECT count(DISTINCT c.slug)
                FROM jsonb_array_elements_text(p_categories) AS c(slug))
             = jsonb_array_length(p_categories)
  END;
$$;

COMMENT ON FUNCTION helm.sidebar_layout_valid(jsonb) IS
  'Whether a sidebar layout is an array of known, non-repeated category slugs. '
  'Mirrors ORG_CATEGORIES in src/lib/nav/org-categories.ts; widening one '
  'without the other is caught by tests/integration/sidebar.test.ts.';

-- -----------------------------------------------------------------------------
-- user_sidebar — which categories I want in the primary list, in what order.
--
-- An EMPTY array is a legitimate choice: somebody who wants the drawer to be
-- nothing but "More". A MISSING ROW is somebody who has never touched it, and
-- only that case falls through to the tenant default. The two are different
-- answers and the reader of this table has to be able to tell them apart, which
-- is why there is no "empty means unset" shortcut anywhere in the stack.
-- -----------------------------------------------------------------------------
CREATE TABLE user_sidebar (
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  categories jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT user_sidebar_layout_valid CHECK (helm.sidebar_layout_valid(categories))
);

CREATE TRIGGER user_sidebar_touch BEFORE UPDATE ON user_sidebar
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

COMMENT ON TABLE user_sidebar IS
  'One row per user: the organization drawer''s primary categories, in order. '
  'A missing row means "never customised" and falls through to '
  'tenant_sidebar_default; an empty array means "I want none of them".';

-- helm.apply_personal_rls (0370): mine, in this tenant, and nobody else's. A
-- tenant-wide read policy would make one technician's arrangement — which says
-- something about what they spend their day on — readable by every colleague.
SELECT helm.apply_personal_rls('user_sidebar');

-- -----------------------------------------------------------------------------
-- tenant_sidebar_default — what somebody sees before they have chosen.
--
-- One row per tenant, and the row is optional: with none, the default comes
-- from the code (the `secondary` flag in the registry), so a deployment that
-- never opens this screen behaves exactly as it does today.
--
-- READABLE BY EVERYONE IN THE TENANT, WRITABLE BY tenant:write. The asymmetry
-- is the point and it is why this table does not use helm.apply_tenant_rls()
-- with p_org_scoped => false: that predicate is `is_tenant_wide()`, which would
-- hide the row from the client-side roles whose drawer is supposed to render
-- from it. They would silently get the code default instead, and an
-- administrator would have set a default that quietly did not apply to half
-- their users.
--
-- Nothing here is sensitive to read: it is a list of category slugs that are
-- already in the shipped source. What needs a gate is WRITING a default for
-- everybody, and the gate is helm.has_permission('tenant:write') — the same
-- permission the route checks, named once here so the two cannot drift. Only
-- super_admin holds it; the seed excludes tier3 from it explicitly, alongside
-- organization:delete and key:rotate.
-- -----------------------------------------------------------------------------
CREATE TABLE tenant_sidebar_default (
  tenant_id  uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  categories jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT tenant_sidebar_default_layout_valid
    CHECK (helm.sidebar_layout_valid(categories))
);

CREATE TRIGGER tenant_sidebar_default_touch BEFORE UPDATE ON tenant_sidebar_default
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

COMMENT ON TABLE tenant_sidebar_default IS
  'Optional per-tenant default drawer layout for users who have not customised '
  'theirs. Readable by anyone in the tenant because the drawer renders from it; '
  'writable only with tenant:write.';

ALTER TABLE tenant_sidebar_default ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sidebar_default FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_sidebar_default_rls_select ON tenant_sidebar_default
  FOR SELECT USING (tenant_id = helm.current_tenant_id());

CREATE POLICY tenant_sidebar_default_rls_insert ON tenant_sidebar_default
  FOR INSERT WITH CHECK (
    tenant_id = helm.require_tenant_id() AND helm.has_permission('tenant:write'));

-- USING decides which rows may be targeted, WITH CHECK what they may become.
-- Omitting the second lets an UPDATE rewrite tenant_id and launder a row into
-- another tenant — 0200 makes the same point about the generic policy set.
CREATE POLICY tenant_sidebar_default_rls_update ON tenant_sidebar_default
  FOR UPDATE
  USING (tenant_id = helm.current_tenant_id() AND helm.has_permission('tenant:write'))
  WITH CHECK (
    tenant_id = helm.require_tenant_id() AND helm.has_permission('tenant:write'));

CREATE POLICY tenant_sidebar_default_rls_delete ON tenant_sidebar_default
  FOR DELETE
  USING (tenant_id = helm.current_tenant_id() AND helm.has_permission('tenant:write'));

GRANT SELECT, INSERT, UPDATE, DELETE ON user_sidebar TO helm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_sidebar_default TO helm_app;

-- =============================================================================
-- Guards
--
-- Modelled on 0530's, which is the migration that last widened a layout
-- validator. Each one is a rule somebody could remove without any test noticing
-- until a save failed in production.
-- =============================================================================
DO $sidebar_guard$
DECLARE
  v_slug text;
  v_all  text[] := ARRAY[
    'configurations', 'contacts', 'documents', 'domains',
    'locations', 'networks', 'passwords', 'ssl',
    'applications', 'directories', 'circuits', 'contracts',
    'licenses', 'vendors', 'sops', 'ip-addresses'
  ];
BEGIN
  -- 1. EVERY SLUG THE REGISTRY KNOWS IS ACCEPTED. Listed literally rather than
  --    read from the function's own text, so a slug dropped from the IN clause
  --    fails here instead of silently becoming unstorable the next time
  --    somebody rearranges their drawer.
  FOREACH v_slug IN ARRAY v_all LOOP
    IF NOT helm.sidebar_layout_valid(to_jsonb(ARRAY[v_slug])) THEN
      RAISE EXCEPTION 'helm: sidebar_layout_valid() refuses the category slug %', v_slug;
    END IF;
  END LOOP;

  -- 2. AND AN UNKNOWN ONE IS REFUSED. A validator that accepts everything
  --    passes the loop above and stores anything.
  IF helm.sidebar_layout_valid('["not_a_category"]'::jsonb) THEN
    RAISE EXCEPTION 'helm: sidebar_layout_valid() accepts unknown slugs';
  END IF;

  -- 3. THE WHOLE REGISTRY AT ONCE IS A LEGAL LAYOUT. Sixteen is under the
  --    ceiling, and somebody who wants every category in the primary list is
  --    expressing a preference, not an error.
  IF NOT helm.sidebar_layout_valid(to_jsonb(v_all)) THEN
    RAISE EXCEPTION 'helm: sidebar_layout_valid() refuses the full registry';
  END IF;

  -- 4. AN EMPTY LAYOUT IS LEGAL. It means "everything under More", which the
  --    control can express and the drawer can render.
  IF NOT helm.sidebar_layout_valid('[]'::jsonb) THEN
    RAISE EXCEPTION 'helm: sidebar_layout_valid() refuses an empty layout';
  END IF;

  -- 5. THE SHAPE RULES.
  IF helm.sidebar_layout_valid('"passwords"'::jsonb) THEN
    RAISE EXCEPTION 'helm: sidebar_layout_valid() no longer requires an array';
  END IF;
  IF helm.sidebar_layout_valid('["passwords", "passwords"]'::jsonb) THEN
    RAISE EXCEPTION 'helm: sidebar_layout_valid() no longer rejects duplicates';
  END IF;
  -- The length rule. Note what this does NOT prove: with sixteen distinct
  -- slugs and the duplicate rule above, no otherwise-valid array can reach a
  -- ceiling of twenty, and this one is over-long AND repeated — so it is
  -- refused whichever branch fires first. The ceiling is defence in depth
  -- against a registry that outgrows it, and what notices THAT is the unit
  -- assertion that the slug list fits under SIDEBAR_MAX.
  IF helm.sidebar_layout_valid(to_jsonb(v_all || v_all[1:5])) THEN
    RAISE EXCEPTION 'helm: sidebar_layout_valid() no longer caps the layout length';
  END IF;

  -- 6. BOTH TABLES ACTUALLY CALL IT. A validator nothing invokes is a function,
  --    not a guarantee.
  FOREACH v_slug IN ARRAY ARRAY['user_sidebar', 'tenant_sidebar_default'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = v_slug::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%sidebar_layout_valid%'
    ) THEN
      RAISE EXCEPTION 'helm: % does not validate its sidebar layout', v_slug;
    END IF;
  END LOOP;

  -- 7. user_sidebar IS PERSONAL. apply_personal_rls() names the actor in its
  --    read predicate; a policy that named only the tenant would publish one
  --    technician's arrangement to every colleague.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user_sidebar' AND policyname = 'user_sidebar_rls_select'
      AND qual LIKE '%current_actor_id%'
  ) THEN
    RAISE EXCEPTION 'helm: user_sidebar is not scoped to its own user';
  END IF;

  -- 8. AND THE TENANT DEFAULT IS READ-OPEN, WRITE-GATED. Both halves, because
  --    getting either backwards is a silent failure: a gated read means a
  --    client-side user never sees the default, and an ungated write means
  --    anybody sets everyone's drawer.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'tenant_sidebar_default'
      AND policyname = 'tenant_sidebar_default_rls_select'
      AND (qual LIKE '%is_tenant_wide%' OR qual LIKE '%has_permission%')
  ) THEN
    RAISE EXCEPTION 'helm: the tenant sidebar default is not readable tenant-wide';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'tenant_sidebar_default'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
      AND coalesce(qual, '') || coalesce(with_check, '') NOT LIKE '%tenant:write%'
  ) THEN
    RAISE EXCEPTION 'helm: a tenant_sidebar_default write policy is not gated on tenant:write';
  END IF;

  -- 9. FORCE ROW LEVEL SECURITY on both, so the owning role is not exempt.
  FOREACH v_slug IN ARRAY ARRAY['user_sidebar', 'tenant_sidebar_default'] LOOP
    IF NOT (SELECT relrowsecurity AND relforcerowsecurity
              FROM pg_class WHERE oid = v_slug::regclass) THEN
      RAISE EXCEPTION 'helm: % does not force row level security', v_slug;
    END IF;
  END LOOP;
END;
$sidebar_guard$;
