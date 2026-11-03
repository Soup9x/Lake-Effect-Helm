-- =============================================================================
-- 1220  A record of every version of Helm this server has run
-- =============================================================================
--
-- 1210 kept a row per update REQUESTED from the Updates page. That is not the
-- history of the server: an update run by hand (`git pull && sudo
-- ./deploy/setup.sh`) never touched it, and a request is not a version. This
-- is one row per version deployed, written by deploy/setup.sh itself once the
-- stack is up — so it covers both ways in, because both end in setup.sh.
--
-- WHO. For an update from the page, the person who asked for it, through the
-- request this run belongs to (setup.sh links the request that is 'running'
-- when it records). For a run by hand there is no Helm user at all — whoever
-- typed sudo on the host is all there is to say, and that is what host_user
-- holds ($SUDO_USER). The page says which of the two it was.
--
-- WHAT. The commit, the one before it, and the pull requests in between as
-- the host's own git history describes them — read at deploy time, so the
-- history page needs neither GitHub nor the checkout to say what changed.
--
-- INSTANCE-WIDE and closed, exactly as 0820 and 1210: no tenant_id, no grants,
-- read only through a SECURITY DEFINER function requiring tenant:write. The
-- writer is setup.sh as the superuser.
-- =============================================================================

CREATE TABLE helm_deploy (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployed_at      timestamptz NOT NULL DEFAULT now(),
  commit           text NOT NULL CHECK (commit ~ '^[0-9a-f]{40}$'),
  previous_commit  text CHECK (previous_commit IS NULL OR previous_commit ~ '^[0-9a-f]{40}$'),
  -- The newest change's title: the pull request's, for a merge.
  title            text CHECK (title IS NULL OR length(title) <= 400),
  -- [{ "pr": 112 | null, "title": "..." }], newest first.
  changes          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(changes) = 'array'),
  source           text NOT NULL CHECK (source IN ('page', 'setup')),
  update_id        uuid REFERENCES helm_update(id) ON DELETE SET NULL,
  -- For a run by hand: the account that ran sudo on the host.
  host_user        text CHECK (host_user IS NULL OR length(host_user) <= 100),
  host             text CHECK (host IS NULL OR length(host) <= 255)
);
CREATE INDEX helm_deploy_recent_idx ON helm_deploy (deployed_at DESC);

COMMENT ON TABLE helm_deploy IS 'One row per version of Helm deployed on this server (1220), written by deploy/setup.sh — from the Updates page or by hand. Read through helm.helm_deploys().';

REVOKE ALL ON helm_deploy FROM PUBLIC, helm_app, helm_auth, helm_worker, helm_key_admin, helm_auditor;

-- Updates from the page that finished before this table existed.
INSERT INTO helm_deploy (deployed_at, commit, previous_commit, source, update_id)
SELECT finished_at, to_commit, from_commit, 'page', id
FROM helm_update
WHERE status = 'succeeded' AND to_commit IS NOT NULL AND finished_at IS NOT NULL;

-- The history, newest first, with who asked for each one (a user id, for the
-- app to name under its own RLS) and the log of the run when it came from the
-- page. `iteration` counts deploys from the first one recorded, so the page can
-- say "update 12" without anybody keeping a version number by hand.
CREATE OR REPLACE FUNCTION helm.helm_deploys(p_limit integer DEFAULT 50)
  RETURNS TABLE (
    id uuid, iteration bigint, deployed_at timestamptz, commit text, previous_commit text,
    title text, changes jsonb, source text, host_user text, host text,
    update_id uuid, requested_by uuid, log text
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM helm.require_update_admin();
  RETURN QUERY
    SELECT d.id, row_number() OVER (ORDER BY d.deployed_at, d.id), d.deployed_at, d.commit, d.previous_commit,
           d.title, d.changes, d.source, d.host_user, d.host,
           d.update_id, u.requested_by, u.log
    FROM helm_deploy d
    LEFT JOIN helm_update u ON u.id = d.update_id
    ORDER BY d.deployed_at DESC, d.id DESC
    LIMIT greatest(1, least(p_limit, 500));
END;
$$;

REVOKE ALL ON FUNCTION helm.helm_deploys(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.helm_deploys(integer) TO helm_app;
