-- =============================================================================
-- 1000 — local accounts an administrator creates, and the emails that go with
-- them
--
-- Until now "Invite somebody" added a membership and nothing else. Somebody
-- who signs in with Entra or another identity provider could then sign in;
-- somebody who could not had no way in at all, because no screen set a local
-- password and no email ever went out — the button said "Send invitation" and
-- sent nothing. This adds both:
--
--   AN ADMINISTRATOR SETS A PASSWORD, which the person must change at their
--   first sign-in (helm.admin_set_local_password), or
--
--   HELM EMAILS A LINK to choose one (account_email, kind password_setup), or
--   to reset one, or just to say they now have access (access_granted).
--
-- THE EMAIL GOES OUT THROUGH THE TENANT'S RELAY, from the worker, like every
-- other message Helm sends: the web process cannot open the relay password and
-- should not (0690). A row here says WHO is to get WHAT; it never holds the
-- link. The worker mints the token at the moment it sends, through
-- helm.issue_account_link(), so a database dump holds no working link — the
-- same rule password_reset has followed since 0340.
--
-- WHO MAY. Sending a password link, or setting a password, is authority over
-- somebody's account, so it follows helm.authorise_out_of_band_reset() (0710):
-- user:write, a member of this tenant, not outranking the caller, and not a
-- member of any other tenant, whose password this tenant does not own.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- set_local_password: the request role may set only its own.
--
-- 0340 granted it to helm_app with no check on whose password it sets, and it
-- is SECURITY DEFINER, so anything reaching the request pool could set anybody's
-- password. No route used that — password changes go through helm_auth — but a
-- hole nobody uses is still a hole. The body moves to _write_local_password,
-- granted to nobody; set_local_password keeps its signature and every
-- existing caller, and refuses a request-role caller setting somebody else's.
-- -----------------------------------------------------------------------------
ALTER FUNCTION helm.set_local_password(uuid, text, boolean, uuid, text)
  RENAME TO _write_local_password;
REVOKE ALL ON FUNCTION helm._write_local_password(uuid, text, boolean, uuid, text)
  FROM PUBLIC, helm_app, helm_auth;

CREATE FUNCTION helm.set_local_password(
  p_user_id      uuid,
  p_password_phc text,
  p_must_change  boolean DEFAULT false,
  p_set_by       uuid DEFAULT NULL,
  p_reason       text DEFAULT NULL
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  -- helm_auth is the pre-authentication path (reset redemption, a signed-in
  -- change re-verified against the current password, a hash upgrade) and has
  -- always been trusted with this. Anybody else may set their own only.
  IF NOT pg_has_role(session_user, 'helm_auth', 'MEMBER')
     AND p_user_id IS DISTINCT FROM helm.current_actor_id() THEN
    RAISE EXCEPTION 'helm: only your own password can be set this way'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'An administrator uses helm.admin_set_local_password().';
  END IF;
  RETURN helm._write_local_password(p_user_id, p_password_phc, p_must_change, p_set_by, p_reason);
END;
$$;
REVOKE ALL ON FUNCTION helm.set_local_password(uuid, text, boolean, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.set_local_password(uuid, text, boolean, uuid, text) TO helm_auth, helm_app;

-- -----------------------------------------------------------------------------
-- Whether the current actor may act on this person's password. One answer for
-- setting one and for emailing a link: 0710's rules, by id.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.authorise_password_authority(p_user_id uuid) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_email    citext;
  v_decision record;
BEGIN
  SELECT email INTO v_email FROM app_user WHERE id = p_user_id AND disabled_at IS NULL;
  IF v_email IS NULL THEN RETURN 'not_found'; END IF;
  SELECT * INTO v_decision FROM helm.authorise_out_of_band_reset(v_email);
  IF v_decision.refusal IS NOT NULL THEN RETURN v_decision.refusal; END IF;
  IF v_decision.user_id IS DISTINCT FROM p_user_id THEN RETURN 'not_found'; END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION helm.authorise_password_authority(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION helm.raise_password_refusal(p_refusal text) RETURNS void
  LANGUAGE plpgsql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  CASE p_refusal
    WHEN 'forbidden' THEN
      RAISE EXCEPTION 'helm: managing somebody''s password requires user:write'
        USING ERRCODE = 'insufficient_privilege';
    WHEN 'outranks_caller' THEN
      RAISE EXCEPTION 'helm: that person''s role outranks yours'
        USING ERRCODE = 'insufficient_privilege';
    WHEN 'member_elsewhere' THEN
      RAISE EXCEPTION 'helm: that account also belongs to another MSP, so its password is not this one''s to set'
        USING ERRCODE = 'insufficient_privilege';
    ELSE
      RAISE EXCEPTION 'helm: no active member of this tenant with that account'
        USING ERRCODE = 'no_data_found';
  END CASE;
END;
$$;
REVOKE ALL ON FUNCTION helm.raise_password_refusal(text) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- helm.admin_set_local_password — an administrator sets somebody's password.
-- The hash is made in the application; the database never sees the password.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.admin_set_local_password(
  p_user_id      uuid,
  p_password_phc text,
  p_must_change  boolean DEFAULT true
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_refusal text := helm.authorise_password_authority(p_user_id);
BEGIN
  IF v_refusal IS NOT NULL THEN
    PERFORM helm.raise_password_refusal(v_refusal);
  END IF;
  IF p_user_id = helm.current_actor_id() THEN
    RAISE EXCEPTION 'helm: change your own password from your profile'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN helm._write_local_password(p_user_id, p_password_phc, p_must_change,
                                    helm.current_actor_id(), 'set by an administrator');
END;
$$;
REVOKE ALL ON FUNCTION helm.admin_set_local_password(uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.admin_set_local_password(uuid, text, boolean) TO helm_app;

-- -----------------------------------------------------------------------------
-- account_email — a message about somebody's account, waiting for the worker.
-- -----------------------------------------------------------------------------
CREATE TABLE account_email (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- access_granted   "you can now sign in to <MSP> in Helm"
  -- password_setup   a link to choose a first password
  -- password_reset   a link to choose a new one
  kind          text NOT NULL,
  requested_by  uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending',
  attempts      smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,

  CONSTRAINT account_email_kind_ck CHECK (kind IN ('access_granted', 'password_setup', 'password_reset')),
  CONSTRAINT account_email_status_ck CHECK (status IN ('pending', 'sent', 'failed', 'superseded')),
  CONSTRAINT account_email_attempts_ck CHECK (attempts >= 0)
);
CREATE INDEX account_email_due_idx ON account_email (next_attempt_at) WHERE status = 'pending';
CREATE INDEX account_email_user_idx ON account_email (tenant_id, user_id, created_at DESC);

COMMENT ON TABLE account_email IS
  'An email about somebody''s account, queued for the worker (1000). Holds no '
  'link: the worker mints the token as it sends.';

-- Tenant-wide administrators read it, to see whether a message went; nobody
-- writes it except through the functions below.
SELECT helm.apply_tenant_rls('account_email', false, 100, NULL);
REVOKE ALL ON account_email FROM PUBLIC, helm_app, helm_auth, helm_worker;
GRANT SELECT ON account_email TO helm_app;

-- -----------------------------------------------------------------------------
-- helm.queue_account_email — ask the worker to send one.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.queue_account_email(p_user_id uuid, p_kind text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_actor   uuid := helm.current_actor_id();
  v_refusal text;
  v_id      uuid;
BEGIN
  IF NOT helm.has_permission('user:write') THEN
    RAISE EXCEPTION 'helm: sending account emails requires user:write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind NOT IN ('access_granted', 'password_setup', 'password_reset') THEN
    RAISE EXCEPTION 'helm: unknown account email %', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = v_actor) THEN
    RAISE EXCEPTION 'helm: account emails are sent on behalf of a person'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_kind = 'access_granted' THEN
    IF NOT EXISTS (
      SELECT 1 FROM membership m
      WHERE m.user_id = p_user_id AND m.tenant_id = v_tenant AND m.status = 'active' AND m.revoked_at IS NULL
    ) THEN
      PERFORM helm.raise_password_refusal('not_found');
    END IF;
  ELSE
    v_refusal := helm.authorise_password_authority(p_user_id);
    IF v_refusal IS NOT NULL THEN
      PERFORM helm.raise_password_refusal(v_refusal);
    END IF;
  END IF;

  -- One live message per person and kind: asking twice sends the newest.
  UPDATE account_email SET status = 'superseded'
  WHERE tenant_id = v_tenant AND user_id = p_user_id AND kind = p_kind AND status = 'pending';

  INSERT INTO account_email (tenant_id, user_id, kind, requested_by)
  VALUES (v_tenant, p_user_id, p_kind, v_actor)
  RETURNING id INTO v_id;

  PERFORM helm.audit('user.account_email_queued', 'app_user', p_user_id, 'success',
                     NULL, NULL, NULL, jsonb_build_object('kind', p_kind, 'email_id', v_id));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION helm.queue_account_email(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.queue_account_email(uuid, text) TO helm_app;

-- -----------------------------------------------------------------------------
-- The worker's side. helm_worker only: the backlog crosses tenants, and the
-- link function mints a working credential.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.account_email_backlog(p_limit integer DEFAULT 50)
  RETURNS TABLE (
    id uuid, tenant_id uuid, tenant_name text, worker_actor_id uuid,
    user_id uuid, email citext, name text, kind text, attempts smallint
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
  SELECT e.id, e.tenant_id, t.name, helm.worker_actor(e.tenant_id, 'system_alerts'),
         e.user_id, u.email, u.name, e.kind, e.attempts
  FROM account_email e
  JOIN tenant t ON t.id = e.tenant_id AND t.status = 'active'
  JOIN app_user u ON u.id = e.user_id AND u.disabled_at IS NULL
  WHERE e.status = 'pending' AND e.next_attempt_at <= now()
    AND helm.worker_actor(e.tenant_id, 'system_alerts') IS NOT NULL
  ORDER BY e.next_attempt_at
  LIMIT greatest(p_limit, 1);
$$;

/**
 * Mint the link for one pending password email, as it is about to be sent.
 *
 * The token is the worker's and only its digest arrives here, exactly as for
 * an administrator's out-of-band reset (0340). Authority was decided when the
 * message was queued; it is checked again here in case the person was
 * promoted past the requester, or joined another tenant, in between.
 */
CREATE OR REPLACE FUNCTION helm.issue_account_link(
  p_email_id     uuid,
  p_token_sha256 bytea,
  p_ttl_minutes  integer
) RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_row     account_email%ROWTYPE;
  v_rank    integer;
  v_target  integer;
  v_reset   uuid;
BEGIN
  SELECT * INTO v_row FROM account_email WHERE id = p_email_id AND status = 'pending';
  IF NOT FOUND OR v_row.kind NOT IN ('password_setup', 'password_reset') THEN
    RAISE EXCEPTION 'helm: no pending password email %', p_email_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT max(r.rank) INTO v_rank FROM membership m JOIN app_role r ON r.key = m.role_key
  WHERE m.user_id = v_row.requested_by AND m.tenant_id = v_row.tenant_id
    AND m.status = 'active' AND m.revoked_at IS NULL;
  SELECT max(r.rank) INTO v_target FROM membership m JOIN app_role r ON r.key = m.role_key
  WHERE m.user_id = v_row.user_id AND m.tenant_id = v_row.tenant_id
    AND m.status = 'active' AND m.revoked_at IS NULL;

  IF v_rank IS NULL OR v_target IS NULL OR v_target > v_rank
     OR EXISTS (SELECT 1 FROM membership m
                WHERE m.user_id = v_row.user_id AND m.tenant_id <> v_row.tenant_id
                  AND m.status = 'active' AND m.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'helm: the person who asked for this email may no longer act on this account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_reset := helm.issue_password_reset(v_row.user_id, p_token_sha256, 'admin',
                                       p_ttl_minutes, v_row.requested_by, NULL);
  RETURN (SELECT expires_at FROM password_reset WHERE id = v_reset);
END;
$$;

CREATE OR REPLACE FUNCTION helm.record_account_email(p_email_id uuid, p_ok boolean, p_error text, p_final boolean)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE account_email SET
    attempts = attempts + 1,
    status = CASE WHEN p_ok THEN 'sent'
                  WHEN p_final OR attempts + 1 >= 5 THEN 'failed'
                  ELSE 'pending' END,
    sent_at = CASE WHEN p_ok THEN now() ELSE sent_at END,
    last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
    -- 1, 2, 4, 8 minutes between tries: a relay that is down for a moment
    -- still delivers the invitation the same morning.
    next_attempt_at = now() + make_interval(mins => (2 ^ least(attempts, 4))::integer)
  WHERE id = p_email_id AND status = 'pending';
END;
$$;

REVOKE ALL ON FUNCTION helm.account_email_backlog(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.issue_account_link(uuid, bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_account_email(uuid, boolean, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.account_email_backlog(integer) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.issue_account_link(uuid, bytea, integer) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.record_account_email(uuid, boolean, text, boolean) TO helm_worker;

-- -----------------------------------------------------------------------------
-- What the People page shows about sign-in: whether there is a local
-- password, and how the last account email went. Never the password.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.member_sign_in_state()
  RETURNS TABLE (
    user_id uuid, has_local_password boolean, must_change boolean,
    email_kind text, email_status text, email_error text, email_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT m.user_id,
         c.user_id IS NOT NULL, coalesce(c.must_change, false),
         e.kind, e.status, e.last_error, coalesce(e.sent_at, e.created_at)
  FROM membership m
  LEFT JOIN local_credential c ON c.user_id = m.user_id
  LEFT JOIN LATERAL (
    SELECT * FROM account_email a
    WHERE a.user_id = m.user_id AND a.tenant_id = m.tenant_id AND a.status <> 'superseded'
    ORDER BY a.created_at DESC LIMIT 1
  ) e ON true
  WHERE m.tenant_id = helm.current_tenant_id()
    AND helm.has_permission('user:read');
$$;
REVOKE ALL ON FUNCTION helm.member_sign_in_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.member_sign_in_state() TO helm_app;

-- -----------------------------------------------------------------------------
-- Guards.
-- -----------------------------------------------------------------------------
DO $guard$
BEGIN
  IF has_function_privilege('helm_app', 'helm._write_local_password(uuid, text, boolean, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '1000: helm_app can write any password directly';
  END IF;
  IF has_function_privilege('helm_app', 'helm.issue_account_link(uuid, bytea, integer)', 'EXECUTE')
     OR has_function_privilege('helm_app', 'helm.account_email_backlog(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '1000: the account email worker functions are reachable from a request';
  END IF;
  IF has_table_privilege('helm_app', 'account_email', 'INSERT')
     OR has_table_privilege('helm_app', 'account_email', 'UPDATE') THEN
    RAISE EXCEPTION '1000: helm_app can write account_email directly';
  END IF;
END
$guard$;
