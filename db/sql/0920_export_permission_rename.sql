-- =============================================================================
-- 0920 — export:approve becomes export:revoke_any in the seeded catalogue
--
-- WHY THIS IS A SEPARATE FILE AND NOT AN EDIT TO 0900
--
-- Same reason as 0440. 0900 had already been applied; helm_migration hashes the
-- whole file, so editing the seed in place broke `pnpm db:migrate` on every
-- environment that had run it. 0900 is back to its applied bytes and its two
-- later intents live here.
--
-- WHY THE RENAME HAS TO HAPPEN TWICE
--
-- 0400 already renames export:approve, and correctly — but it runs BEFORE the
-- catalogue is seeded. On an upgrade that is the right place: the rows exist and
-- 0400 moves them. On a fresh build 0400 finds nothing, returns, and 0900 then
-- seeds whatever it seeds. With 0900 restored to its applied content that is
-- export:approve, so without this file a fresh install would finish with the old
-- key present, no export:revoke_any at all, and helm.revoke_export() gated on a
-- permission nobody holds.
--
-- So the rename runs again here, after the seed. On an upgraded database 0400
-- has already done it and this is a no-op; on a fresh build this is the one that
-- does the work. Both end in the same place, which is the property that matters.
--
-- The capability is RENAMED, not deleted, and the difference matters:
-- helm.revoke_export() gates on it — "only the requester or an approver may
-- revoke an export" — so dropping it would silently narrow revocation to the
-- requester alone. Revocation is a CONTAINMENT action. Removing two-person
-- approval was supposed to remove a gate, not remove the brakes.
-- =============================================================================
SET search_path = public, extensions;

-- Mechanically the same block as 0400's, which is deliberate: two code paths
-- that must agree about what a rename means are better off being one piece of
-- text copied than two pieces reasoned about separately.
DO $rename$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permission WHERE key = 'export:approve') THEN
    RETURN;
  END IF;

  INSERT INTO permission (key, category, description, msp_only)
  VALUES ('export:revoke_any', 'export', 'Revoke an export requested by someone else', true)
  ON CONFLICT (key) DO NOTHING;

  -- Move the grants before deleting the old key. The NOT EXISTS avoids a
  -- primary-key collision on a role that somehow holds both.
  UPDATE role_permission rp SET permission_key = 'export:revoke_any'
  WHERE rp.permission_key = 'export:approve'
    AND NOT EXISTS (
      SELECT 1 FROM role_permission existing
      WHERE existing.role_key = rp.role_key
        AND existing.permission_key = 'export:revoke_any'
    );

  DELETE FROM role_permission WHERE permission_key = 'export:approve';
  DELETE FROM permission WHERE key = 'export:approve';
END;
$rename$;

-- =============================================================================
-- Guards
-- =============================================================================
DO $export_permission_guard$
DECLARE
  v_holders bigint;
BEGIN
  -- 1. The old key is gone and the new one is here. Stated as two assertions
  --    rather than one, because "renamed" failing halfway — new key created,
  --    old one still present — is a different and worse outcome than either.
  IF EXISTS (SELECT 1 FROM permission WHERE key = 'export:approve') THEN
    RAISE EXCEPTION 'helm: export:approve survived the rename';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM permission WHERE key = 'export:revoke_any') THEN
    RAISE EXCEPTION 'helm: export:revoke_any does not exist, so nobody can revoke '
                    'somebody else''s export';
  END IF;

  -- 2. The grants came with it. A rename that dropped them would leave
  --    revocation working only for the requester, which is the failure this
  --    whole arrangement exists to avoid, and it would look like success.
  SELECT count(*) INTO v_holders
  FROM role_permission WHERE permission_key = 'export:revoke_any';
  IF v_holders < 2 THEN
    RAISE EXCEPTION 'helm: only % role(s) hold export:revoke_any; the grants did not '
                    'survive the rename', v_holders;
  END IF;

  -- 3. THE NETWORK PERMISSION IS ITS OWN SCOPE.
  --
  --    integration:network:manage is created by 0430, not seeded here — 0430
  --    runs first on a fresh build, and listing it in 0900 as well was a
  --    duplicate key that broke every rebuild. It reaches roles two different
  --    ways depending on the path: on a fresh build 0900's "super_admin takes
  --    every permission, tier3 takes everything bar three" picks it up without
  --    naming it; on an upgrade 0430's own grant block does, because the roles
  --    already exist.
  --
  --    Either way it must reach those two roles and no others. It is separate
  --    from integration:manage precisely so a technician who looks after a
  --    client's network can wire up their controller without also gaining the
  --    notification webhooks and the OIDC provider — and that separation is easy
  --    to erase later by granting both to the same roles for convenience.
  IF EXISTS (
    SELECT 1 FROM role_permission
    WHERE permission_key = 'integration:network:manage'
      AND role_key NOT IN ('super_admin', 'tier3')
  ) THEN
    RAISE EXCEPTION 'helm: integration:network:manage reached a role beyond super_admin and tier3';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM role_permission
    WHERE permission_key = 'integration:network:manage' AND role_key = 'tier3'
  ) THEN
    RAISE EXCEPTION 'helm: tier3 does not hold integration:network:manage, so the '
                    'permission cannot be delegated without tenant:write';
  END IF;
END;
$export_permission_guard$;
