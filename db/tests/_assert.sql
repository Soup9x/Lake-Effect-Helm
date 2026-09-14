-- Minimal assertion helper. Installed as a superuser; callable by any role.
CREATE SCHEMA IF NOT EXISTS helm_test;

CREATE OR REPLACE FUNCTION helm_test.check(p_description text, p_condition boolean)
  RETURNS void
  LANGUAGE plpgsql
AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION E'\n  FAIL: %', p_description USING ERRCODE = 'assert_failure';
  END IF;
  RAISE NOTICE '  ok  %', p_description;
END;
$$;

-- Asserts that a statement raises. Used for the "this must be impossible" tests.
CREATE OR REPLACE FUNCTION helm_test.check_raises(p_description text, p_sql text)
  RETURNS void
  LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  ok  % (rejected: %)', p_description, left(SQLERRM, 70);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  FAIL: % — statement was ACCEPTED but should have been rejected', p_description
    USING ERRCODE = 'assert_failure';
END;
$$;

-- Void-returning wrapper so the test scripts do not print the whole resolved
-- context jsonb on every BEGIN. psql does not interpolate :variables inside
-- dollar-quoted blocks, so a DO block is not an option here.
CREATE OR REPLACE FUNCTION helm_test.ctx(p_tenant uuid, p_actor uuid)
  RETURNS void
  LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM helm.set_session_context(p_tenant, p_actor);
END;
$$;

GRANT USAGE ON SCHEMA helm_test TO PUBLIC;
GRANT EXECUTE ON FUNCTION helm_test.check(text, boolean) TO PUBLIC;
GRANT EXECUTE ON FUNCTION helm_test.check_raises(text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION helm_test.ctx(uuid, uuid) TO PUBLIC;
