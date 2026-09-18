-- =============================================================================
-- 0930 — the export worker's description stops describing a gate that is gone
--
-- WHY THIS IS A SEPARATE FILE AND NOT AN EDIT TO 0910
--
-- Same reason as 0440 and 0920. The text below lives in an INSERT literal, so
-- editing 0910 in place changed nothing at all on a database that had already
-- been seeded — it only broke the checksum. The stale sentence stayed exactly
-- where it was.
--
-- That is the quiet half of this class of bug and worth naming: an edit to an
-- applied seed file is not merely blocked at deploy time, it would not have
-- worked even if it had been allowed through. Seeds are applied once. Changing
-- seeded data needs an UPDATE.
-- =============================================================================
SET search_path = public, extensions;

-- 0400 removed two-person approval from credential exports. This description
-- still promised it, which is the sort of thing somebody reads during an audit
-- and reasonably believes.
UPDATE app_role
   SET description = 'Renders compliance and offboarding exports. May reveal only secrets '
                     'inside a live export job that asked for them.'
 WHERE key = 'system_export';

DO $export_worker_guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app_role
    WHERE key = 'system_export' AND description LIKE '%four-eyes%'
  ) THEN
    RAISE EXCEPTION 'helm: the export worker still describes four-eyes approval, which 0400 removed';
  END IF;
END;
$export_worker_guard$;
