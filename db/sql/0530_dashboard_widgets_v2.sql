-- =============================================================================
-- 0530 — three more widgets the database will accept
--
-- helm.dashboard_layout_valid() is the CHECK behind user_dashboard.widgets,
-- and it pins the set of legal widget keys. That list is deliberately duplicated
-- in src/lib/workspace/widgets.ts, and 0370 explains why: the database refuses
-- an unknown key so a malformed layout is never stored, and the interface needs
-- the titles anyway. tests/integration/workspace.test.ts asserts the two agree,
-- so adding a widget to the interface WITHOUT this migration fails there rather
-- than as an unexplained 500 on somebody's save.
--
-- This is that migration. Three keys join the five:
--
--   quick_actions   the create flows, from the dashboard instead of from a
--                   client page
--   usage_summary   totals across everything this actor can see
--   sync_status     per-mapping UniFi health, from helm.unifi_mappings()
--
-- Nothing else about the function changes: the array check, the twelve-item
-- ceiling and the no-duplicates rule are what they were.
-- =============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION helm.dashboard_layout_valid(p_widgets jsonb)
  RETURNS boolean
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
             'favorites', 'recently_viewed', 'expirations', 'audit_activity',
             'client_health', 'quick_actions', 'usage_summary', 'sync_status'
           )
         )
         -- A layout listing the same widget twice renders it twice, which
         -- nobody means and the reorder control cannot express.
         AND (SELECT count(DISTINCT w.key) FROM jsonb_array_elements_text(p_widgets) AS w(key))
             = jsonb_array_length(p_widgets)
  END;
$$;

-- =============================================================================
-- Guards
-- =============================================================================
DO $widget_guard$
DECLARE
  v_key text;
BEGIN
  -- 1. EVERY KEY THE INTERFACE KNOWS ABOUT IS ACCEPTED. Listed literally rather
  --    than read from the function's own text, so a key dropped from the IN
  --    clause fails here instead of silently becoming unstorable the next time
  --    somebody rearranges their dashboard.
  FOREACH v_key IN ARRAY ARRAY[
    'favorites', 'recently_viewed', 'expirations', 'audit_activity',
    'client_health', 'quick_actions', 'usage_summary', 'sync_status'
  ] LOOP
    IF NOT helm.dashboard_layout_valid(to_jsonb(ARRAY[v_key])) THEN
      RAISE EXCEPTION 'helm: dashboard_layout_valid() refuses the widget key %', v_key;
    END IF;
  END LOOP;

  -- 2. AND AN UNKNOWN ONE IS STILL REFUSED. A validator that accepts everything
  --    passes the loop above and stores anything.
  IF helm.dashboard_layout_valid('["not_a_widget"]'::jsonb) THEN
    RAISE EXCEPTION 'helm: dashboard_layout_valid() now accepts unknown keys';
  END IF;

  -- 3. THE OTHER THREE RULES SURVIVED THE REWRITE.
  IF helm.dashboard_layout_valid('"favorites"'::jsonb) THEN
    RAISE EXCEPTION 'helm: dashboard_layout_valid() no longer requires an array';
  END IF;
  IF helm.dashboard_layout_valid('["favorites", "favorites"]'::jsonb) THEN
    RAISE EXCEPTION 'helm: dashboard_layout_valid() no longer rejects duplicates';
  END IF;
  IF helm.dashboard_layout_valid(
       to_jsonb(ARRAY['favorites','recently_viewed','expirations','audit_activity',
                      'client_health','quick_actions','usage_summary','sync_status',
                      'favorites','recently_viewed','expirations','audit_activity',
                      'client_health'])) THEN
    RAISE EXCEPTION 'helm: dashboard_layout_valid() no longer caps the layout length';
  END IF;

  -- 4. THE CHECK CONSTRAINT STILL CALLS IT. A validator nothing invokes is a
  --    function, not a guarantee.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'user_dashboard'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%dashboard_layout_valid%'
  ) THEN
    RAISE EXCEPTION 'helm: user_dashboard no longer validates its dashboard layout';
  END IF;
END;
$widget_guard$;
