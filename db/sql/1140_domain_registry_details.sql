-- =============================================================================
-- 1140 — what the registry says about a domain beyond its expiry
--
-- 0670 read one fact out of an RDAP answer, the expiry, and threw the rest
-- away. The same answer names the registrar, the registration date, the
-- nameservers, whether a transfer lock is set and whether the delegation is
-- signed: every one a column on `domain` that somebody had to type in.
--
-- registry_details is that answer, kept whole as the probe last read it, keyed
-- by the column each value would go into. It is a SUGGESTION and never a
-- write: 0670's rule that inbound data does not overwrite what a person
-- recorded stands. The asset page lists each difference and a person either
-- applies it (an ordinary detail write, recorded in history as theirs) or
-- keeps what they had.
--
-- registry_dismissed is "keep mine": the registry's value at the moment
-- somebody looked at it and said no, per field. The suggestion stays hidden
-- while the registry keeps saying the same thing, and comes back the moment
-- the registry says something new — a dismissal is an answer to one value,
-- not a switch that silences the field forever.
--
-- NONE OF IT IS HISTORY. Both are what a probe observed or bookkeeping about
-- it, the same as last_checked_at, so row_changes() skips them; a daily check
-- must not write a history entry every time a registry reorders its
-- nameservers. registry_expires_at joins them: 0970 meant to leave out what a
-- probe observes and listed observed_* but missed it, so every renewal the
-- registry reported read as "an automatic sync changed Registry expires at".
-- Copies (1020) already leave every registry_* column behind.
-- =============================================================================

SET search_path = public, extensions;

ALTER TABLE domain
  ADD COLUMN IF NOT EXISTS registry_details   jsonb,
  ADD COLUMN IF NOT EXISTS registry_dismissed jsonb;

COMMENT ON COLUMN domain.registry_details IS
  'What the registry last said (RDAP), keyed by domain column. A suggestion: never applied without a person.';
COMMENT ON COLUMN domain.registry_dismissed IS
  'Per column, the registry value a person chose not to apply. Hidden until the registry says something else.';

CREATE OR REPLACE FUNCTION helm.row_changes(p_old jsonb, p_new jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_out  jsonb := '{}'::jsonb;
  v_key  text;
  v_sub  text;
  v_old  jsonb;
  v_new  jsonb;
BEGIN
  FOR v_key IN SELECT jsonb_object_keys(coalesce(p_new, '{}'::jsonb) || coalesce(p_old, '{}'::jsonb)) LOOP
    CONTINUE WHEN v_key IN (
      'id', 'tenant_id', 'node_type', 'created_at', 'created_by', 'updated_at', 'updated_by',
      'deleted_at', 'archived_at', 'last_checked_at', 'next_check_at', 'last_check_status',
      'last_check_error', 'observed_not_after', 'observed_fingerprint_sha256', 'last_seen_at',
      'validated_at', 'needs_migration', 'type_version_id', 'version', 'latitude', 'longitude',
      'registry_expires_at', 'registry_details', 'registry_dismissed')
      OR v_key LIKE '%secret_id'
      OR v_key LIKE '%tsv' OR v_key LIKE 'search_%';

    v_old := p_old -> v_key;
    v_new := p_new -> v_key;
    CONTINUE WHEN v_old IS NOT DISTINCT FROM v_new;

    IF jsonb_typeof(v_old) = 'object' OR jsonb_typeof(v_new) = 'object' THEN
      FOR v_sub IN SELECT jsonb_object_keys(coalesce(v_new, '{}'::jsonb) || coalesce(v_old, '{}'::jsonb)) LOOP
        CONTINUE WHEN (v_old -> v_sub) IS NOT DISTINCT FROM (v_new -> v_sub);
        v_out := v_out || jsonb_build_object(v_key || '.' || v_sub,
          jsonb_build_array(helm.change_value(v_old -> v_sub), helm.change_value(v_new -> v_sub)));
      END LOOP;
    ELSE
      v_out := v_out || jsonb_build_object(v_key,
        jsonb_build_array(helm.change_value(v_old), helm.change_value(v_new)));
    END IF;
  END LOOP;
  RETURN v_out;
END;
$$;
