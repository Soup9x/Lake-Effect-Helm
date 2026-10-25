-- =============================================================================
-- 1060 — more of a Microsoft 365 user on the contact: profile, aliases, groups
--
-- 0990 imports a person's name, title, primary address, desk phone and mobile.
-- This adds the rest of what a technician gets asked about:
--
--   PROFILE   department, office, company, postal address and every business
--             phone, kept on the link (m365_contact_link.profile) and shown on
--             the contact as Microsoft 365's, read-only. They are not contact
--             columns because a person cannot usefully edit them in Helm: the
--             next sync would either undo the edit or have to ignore Microsoft.
--
--   ALIASES   every other smtp: proxy address, added to the contact's email
--             addresses the way 0990 adds the primary one: added once, never
--             put back after somebody removes it, never deleted here because
--             it is gone there.
--
--   GROUPS    the groups the person is a direct member of, with what kind
--             each is. Reading them needs GroupMember.Read.All, which an app
--             consented before this may not have. The worker then sends a
--             profile without `groups`, and the groups recorded last time are
--             kept rather than wiped.
--
-- Called after helm.upsert_m365_user() for every user, every run: the profile
-- is compared rather than hashed, so an unchanged one costs a read.
-- =============================================================================

SET search_path = public, extensions;

ALTER TABLE m365_contact_link
  ADD COLUMN profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT m365_contact_link_profile_object CHECK (jsonb_typeof(profile) = 'object');

COMMENT ON COLUMN m365_contact_link.profile IS
  'What Microsoft 365 says about the person beyond the contact''s own fields: department, '
  'office, company, address, phones, aliases, groups. Written by the sync only. See 1060.';

CREATE OR REPLACE FUNCTION helm.set_m365_contact_profile(
  p_connection_id uuid,
  p_graph_user_id text,
  p_profile       jsonb
) RETURNS text
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_link    m365_contact_link%ROWTYPE;
  v_profile jsonb := coalesce(p_profile, '{}'::jsonb);
  v_done    jsonb;
  v_alias   text;
  v_changed boolean := false;
BEGIN
  IF jsonb_typeof(v_profile) <> 'object' THEN
    RAISE EXCEPTION 'helm: a Microsoft 365 profile is an object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM helm.graph_connection_scope(p_connection_id);

  SELECT l.* INTO v_link FROM m365_contact_link l
  JOIN contact c ON c.id = l.contact_id AND c.deleted_at IS NULL
  WHERE l.connection_id = p_connection_id AND l.graph_user_id = p_graph_user_id;
  IF v_link.contact_id IS NULL THEN
    RETURN 'skipped';
  END IF;

  -- Groups that could not be read this time: keep what was recorded.
  IF NOT v_profile ? 'groups' AND v_link.profile ? 'groups' THEN
    v_profile := v_profile || jsonb_build_object('groups', v_link.profile -> 'groups');
  END IF;

  -- Aliases: each one added once. One this sync added before and that is now
  -- missing from the contact was removed by a person, and stays removed.
  v_done := coalesce(v_link.applied -> 'aliases', '[]'::jsonb);
  FOR v_alias IN SELECT lower(a) FROM jsonb_array_elements_text(coalesce(v_profile -> 'aliases', '[]'::jsonb)) a LOOP
    CONTINUE WHEN v_done ? v_alias;
    IF NOT EXISTS (SELECT 1 FROM contact_email e
                   WHERE e.contact_id = v_link.contact_id AND lower(e.address::text) = v_alias) THEN
      INSERT INTO contact_email (tenant_id, contact_id, address, label, is_primary, position)
      VALUES (v_tenant, v_link.contact_id, v_alias::citext, 'work',
              NOT EXISTS (SELECT 1 FROM contact_email e WHERE e.contact_id = v_link.contact_id AND e.is_primary),
              (SELECT coalesce(max(position) + 1, 0) FROM contact_email e WHERE e.contact_id = v_link.contact_id));
      v_changed := true;
    END IF;
    v_done := v_done || to_jsonb(v_alias);
  END LOOP;

  IF v_link.profile IS DISTINCT FROM v_profile
     OR (v_link.applied -> 'aliases') IS DISTINCT FROM v_done THEN
    UPDATE m365_contact_link SET
      profile = v_profile,
      applied = applied || jsonb_build_object('aliases', v_done)
    WHERE connection_id = p_connection_id AND graph_user_id = p_graph_user_id;
    v_changed := v_changed OR v_link.profile IS DISTINCT FROM v_profile;
  END IF;

  RETURN CASE WHEN v_changed THEN 'updated' ELSE 'unchanged' END;
END;
$$;

REVOKE ALL ON FUNCTION helm.set_m365_contact_profile(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.set_m365_contact_profile(uuid, text, jsonb) TO helm_app;
