-- =============================================================================
-- 0240_trigger_privileges.sql — trigger functions that must run as the definer
--
-- BUG THIS FIXES: a trigger function runs with the privileges of the user whose
-- statement fired it, not the privileges of whoever wrote the trigger. Three of
-- Helm's validation triggers read tables the application role deliberately
-- cannot see, so they failed with "permission denied" the moment a real
-- application user did the thing they validate.
--
-- The worst of the three, and the reason this was not caught in 0200's test
-- suite: secret_current_version_check is a DEFERRED CONSTRAINT TRIGGER. It does
-- not fire on the statement — it fires at COMMIT. Every assertion in
-- db/tests/security.sql runs inside a transaction that ends in ROLLBACK, so the
-- trigger never executed there. It only surfaced once an integration test
-- committed a secret write as helm_app.
--
-- Each function below is now SECURITY DEFINER with a pinned search_path. This
-- is safe because each one only READS a narrow, fixed set of rows to validate
-- the row being written, and returns no data to the caller — a validation
-- trigger cannot be used as a read primitive.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- secret.current_version must point at a version that exists.
--
-- Reads secret_version, which no role may SELECT (0200/0220). Without SECURITY
-- DEFINER, every committed secret write fails at COMMIT with "permission denied
-- for table secret_version" — after the application has already reported
-- success for the statement.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.check_secret_current_version() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.current_version = 0 THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM secret_version sv
    WHERE sv.secret_id = NEW.id AND sv.version = NEW.current_version
  ) THEN
    RAISE EXCEPTION 'helm: secret % has no version %', NEW.id, NEW.current_version
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Flexible asset records must not carry a schema-declared secret inline.
--
-- Reads flexible_asset_type_version, whose RLS policy is tenant-wide only. A
-- client-side actor writing a record of a type their MSP published would fail
-- the read and therefore fail the write — and, worse, the failure mode of a
-- validator that cannot see its rules is to pass vacuously if anyone ever
-- "fixes" it by swallowing the error.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.reject_inline_secret_fields() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_secret_fields text[];
  v_path          text;
  v_key           text;
BEGIN
  SELECT secret_fields INTO v_secret_fields
  FROM flexible_asset_type_version
  WHERE id = NEW.type_version_id;

  -- A schema version that cannot be found is a broken reference, not a licence
  -- to skip validation. The FK guarantees it exists; this is belt and braces.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm: flexible asset schema version % not found', NEW.type_version_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_secret_fields IS NULL OR cardinality(v_secret_fields) = 0 THEN
    RETURN NEW;
  END IF;

  FOREACH v_path IN ARRAY v_secret_fields LOOP
    v_key := substring(v_path from 2);
    IF NEW.data ? v_key AND jsonb_typeof(NEW.data -> v_key) <> 'null' THEN
      RAISE EXCEPTION 'helm: field % is declared secret and must not be stored inline', v_path
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'Write the value through the secret API and reference it from '
                     'flexible_asset_secret.';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Search projection for flexible records — same read, same problem.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.index_flexible_record() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_searchable text[];
  v_secret     text[];
  v_path       text;
  v_key        text;
  v_parts      text[] := '{}';
  v_val        text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT searchable_fields, secret_fields INTO v_searchable, v_secret
  FROM flexible_asset_type_version WHERE id = NEW.type_version_id;

  FOREACH v_path IN ARRAY coalesce(v_searchable, '{}') LOOP
    CONTINUE WHEN v_path = ANY (coalesce(v_secret, '{}'));
    v_key := substring(v_path from 2);
    v_val := NEW.data ->> v_key;
    IF v_val IS NOT NULL AND v_val <> '' THEN
      v_parts := v_parts || v_val;
    END IF;
  END LOOP;

  UPDATE search_document
  SET body = array_to_string(v_parts, E'\n'), updated_at = now()
  WHERE entity_type = 'asset_node' AND entity_id = NEW.id;

  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Guard: assert that every trigger function reading a table the application
-- role cannot SELECT is SECURITY DEFINER.
--
-- The class of bug is "validation trigger reads a restricted table", and the
-- symptom appears at COMMIT rather than at the statement, which makes it easy
-- to miss in any test that rolls back. Checking the catalog is cheaper than
-- remembering.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  v_bad text;
BEGIN
  -- MATERIALIZED is an optimisation fence, and it is required here: without it
  -- the planner is free to evaluate pg_get_functiondef() before the schema
  -- filter, and that function raises on aggregates ("array_agg is an aggregate
  -- function") long before it reaches anything in `helm`.
  WITH candidates AS MATERIALIZED (
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm'
      AND p.prokind = 'f'
      AND NOT p.prosecdef
      AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid AND NOT t.tgisinternal)
  )
  SELECT string_agg(c.proname, ', ' ORDER BY c.proname) INTO v_bad
  FROM candidates c
  -- Names the ciphertext table anywhere in its body.
  WHERE pg_get_functiondef(c.oid) ~ '\msecret_version\M';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'helm: trigger functions read secret_version without SECURITY DEFINER: % '
      '(they will fail at COMMIT for every non-superuser writer)', v_bad;
  END IF;
END
$guard$;
