-- =============================================================================
-- 0340_local_authentication.sql — local passwords, alongside SSO
--
-- Helm's reason for having local accounts is narrow and worth stating, because
-- it shapes every decision below: an MSP whose identity provider is down must
-- still be able to reach its clients' credentials. That is usually the same
-- outage. If Entra is unreachable because Microsoft is having a bad morning,
-- so is the mailbox a password-reset email would land in.
--
-- So this is built for the outage case, not as a general-purpose login:
--
--   * Local and SSO sessions are INDISTINGUISHABLE once established. Both end
--     up as a row in auth_session, so "this technician left, cut their access
--     now" still takes effect immediately for both. Local login does not get a
--     JWT and a different revocation story.
--
--   * Reset does not depend on email. An administrator can issue a reset code
--     and read it down the phone, because during the outage this feature
--     exists for, the mail path is probably down too. Self-service email reset
--     is available on top, not underneath.
--
--   * Throttling lives in PostgreSQL, not Redis. Helm ships no cache tier at
--     all, precisely so that correctness never depends on one, and a rate
--     limit that silently stops limiting when a cache is unavailable is not a
--     rate limit.
--
-- WHAT IS DELIBERATELY NOT HERE: password hashing and verification. Both
-- happen in the application. PostgreSQL's comparison operators are not
-- constant-time, a hash passed as a SQL literal lands in pg_stat_activity and
-- the statement log, and pgcrypto's crypt() offers nothing stronger than
-- bcrypt. The database stores an opaque PHC string and never inspects it.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- local_credential — one optional password per user.
--
-- Separate from app_user rather than a nullable column on it, for three
-- reasons: most users will never have one (SSO is the primary path); the
-- table's grants can then be narrower than app_user's; and "has this account
-- got a local password" becomes a row's existence rather than a NULL check
-- that some query will eventually get backwards.
-- -----------------------------------------------------------------------------
CREATE TABLE local_credential (
  user_id            uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,

  -- The full PHC string: $argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>.
  -- Parameters travel WITH the hash so they can be raised later and existing
  -- hashes upgraded on the owner's next successful sign-in. A schema that
  -- stores the digest alone can never raise its cost without a mass reset.
  password_phc       text NOT NULL,

  -- Denormalised from the PHC string for reporting ("how many accounts are
  -- still on the old parameters"). Never used to decide how to verify — the
  -- PHC string is authoritative, and a disagreement between the two must not
  -- be resolvable in favour of the cheaper one.
  algorithm          text NOT NULL DEFAULT 'argon2id',

  password_changed_at timestamptz NOT NULL DEFAULT now(),
  -- Set when an administrator issued the password. The owner must replace it
  -- before the account is useful for anything else.
  must_change        boolean NOT NULL DEFAULT false,

  -- The previous PHC strings, newest first, so a forced change cannot be
  -- satisfied by re-entering the password being rotated away from. These are
  -- full Argon2id hashes, each with its own salt, so reuse is detected in the
  -- application by verifying the candidate against each in turn — no
  -- comparison here could do it, and none is attempted.
  previous_phc       text[] NOT NULL DEFAULT '{}',

  failed_attempts    integer NOT NULL DEFAULT 0,
  -- Set while the account is throttled. Never a permanent lock: a lockout an
  -- attacker can trigger on demand is a denial-of-service against the very
  -- account they are attacking, and for a break-glass account that is worse
  -- than the brute force.
  locked_until       timestamptz,
  last_success_at    timestamptz,
  last_failure_at    timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT local_credential_phc_shape CHECK (password_phc ~ '^\$argon2(id|i|d)\$'),
  CONSTRAINT local_credential_algorithm_known CHECK (algorithm IN ('argon2id')),
  CONSTRAINT local_credential_history_bounded CHECK (cardinality(previous_phc) <= 5),
  CONSTRAINT local_credential_attempts_non_negative CHECK (failed_attempts >= 0)
);

CREATE INDEX local_credential_locked_idx ON local_credential (locked_until)
  WHERE locked_until IS NOT NULL;

COMMENT ON TABLE local_credential IS
  'Optional local password, for reaching Helm when the identity provider is '
  'down. Hashing and verification happen in the application; this table stores '
  'an opaque PHC string and never inspects it.';

-- -----------------------------------------------------------------------------
-- auth_attempt — the throttling ledger.
--
-- Every local sign-in attempt, successful or not, keyed by BOTH the account and
-- the source address. Two limits, because they stop different attacks:
--
--   per account  a password-spray against one known administrator
--   per address  a spray across many accounts from one host, which per-account
--                counters never see
--
-- Rows are pruned by the worker. The table is deliberately not partitioned:
-- unlike the audit log this is operational state with a short useful life, and
-- a DELETE of a few thousand rows a day is cheaper than partition management.
--
-- NOT the audit log. Audit rows are immutable and hash-chained; these are
-- disposable counters. Conflating them would mean either an unprunable table
-- of noise or a mutable audit log, and both are worse.
-- -----------------------------------------------------------------------------
CREATE TABLE auth_attempt (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),

  -- The email as presented, lowercased. Stored rather than resolved to a
  -- user_id because the interesting attempts are against addresses that do not
  -- exist: an attacker enumerating names produces no user_id at all, and a
  -- counter that only counts real accounts cannot see them.
  email        citext,
  user_id      uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ip           inet,

  outcome      text NOT NULL,
  user_agent   text,

  CONSTRAINT auth_attempt_outcome_known CHECK (
    outcome IN ('success', 'bad_password', 'no_such_account', 'locked',
                'rate_limited', 'disabled', 'reset_redeemed', 'reset_refused')
  )
);

-- The two lookups the throttle makes, and nothing else.
--
-- Only GENUINE attempts are counted. A refusal Helm itself issued ('locked',
-- 'rate_limited') must not feed the counter that produced it, or the window
-- never drains: an attacker who keeps knocking after being locked out would
-- hold the limit open indefinitely, and behind an office NAT that means one
-- attacker locks out every technician sharing the address.
CREATE INDEX auth_attempt_email_idx ON auth_attempt (email, occurred_at DESC)
  WHERE outcome IN ('bad_password', 'no_such_account', 'disabled');
CREATE INDEX auth_attempt_ip_idx ON auth_attempt (ip, occurred_at DESC)
  WHERE outcome IN ('bad_password', 'no_such_account', 'disabled');
CREATE INDEX auth_attempt_pruning_idx ON auth_attempt (occurred_at);

-- -----------------------------------------------------------------------------
-- password_reset — single-use, hashed at rest.
--
-- The token is returned once and never stored in the clear, for the same
-- reason API tokens are not: a reset table readable in a database dump would
-- be a list of working account takeovers.
-- -----------------------------------------------------------------------------
CREATE TABLE password_reset (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,

  -- sha256 of the token. Not Argon2: the token is 32 bytes of CSPRNG output,
  -- so there is nothing to brute-force and a slow hash would only make the
  -- redeem path a denial-of-service lever.
  token_sha256  bytea NOT NULL UNIQUE,

  -- 'self' — the user asked, delivered by email.
  -- 'admin' — an administrator issued it, delivered out of band. This is the
  -- path that works during the outage local accounts exist for.
  origin        text NOT NULL,
  issued_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,

  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  -- Recorded when a token is superseded by a newer one rather than redeemed,
  -- so "somebody requested four resets in a minute" is visible.
  invalidated_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_ip    inet,

  CONSTRAINT password_reset_origin_known CHECK (origin IN ('self', 'admin')),
  CONSTRAINT password_reset_sha_len CHECK (octet_length(token_sha256) = 32),
  CONSTRAINT password_reset_window CHECK (expires_at > created_at),
  -- An admin-issued reset must say who issued it. A self-service one must not
  -- claim an issuer.
  CONSTRAINT password_reset_issuer_matches_origin CHECK (
    (origin = 'admin' AND issued_by IS NOT NULL)
    OR (origin = 'self' AND issued_by IS NULL)
  )
);

CREATE INDEX password_reset_user_idx ON password_reset (user_id, created_at DESC);
CREATE INDEX password_reset_live_idx ON password_reset (expires_at)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

CREATE TRIGGER local_credential_touch BEFORE UPDATE ON local_credential
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- =============================================================================
-- The pre-context authentication API.
--
-- Local sign-in happens BEFORE any tenant context exists — resolving "who is
-- this" is precisely the question a context depends on. These functions are
-- therefore SECURITY DEFINER and RLS-bypassing, exactly like the three in
-- 0270, and are held to the same rules: they return only what is needed to
-- establish an identity, they do no authorisation, and password comparison
-- happens in the application in constant time.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- helm.local_login_challenge — everything the application needs to decide.
--
-- Returns a row for an address that does not exist, with found = false and a
-- NULL hash. That is not an oversight: the caller must perform a dummy verify
-- against a fixed hash so an unknown address costs the same wall-clock time as
-- a wrong password. Returning zero rows would make the timing difference
-- trivially observable and hand an attacker a user-enumeration oracle on the
-- one login form that still works during an outage.
--
-- Throttle state is computed here, in the same call, so the caller cannot
-- check the password first and the rate limit afterwards.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.local_login_challenge(
  p_email text,
  p_ip    inet DEFAULT NULL
) RETURNS TABLE (
  found              boolean,
  user_id            uuid,
  password_phc       text,
  must_change        boolean,
  disabled           boolean,
  locked_until       timestamptz,
  -- True when EITHER limit is exceeded. The caller refuses without verifying,
  -- so a spray costs the attacker a round trip and costs Helm no Argon2 work.
  throttled          boolean,
  account_failures   integer,
  address_failures   integer
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_user       app_user%ROWTYPE;
  v_credential local_credential%ROWTYPE;
  v_email      citext := lower(btrim(p_email))::citext;
  v_account    integer := 0;
  v_address    integer := 0;
BEGIN
  -- Genuine failures within the window, matching the partial indexes. A
  -- successful sign-in does not count against the next one, and neither does a
  -- refusal Helm itself issued — see the note on the indexes.
  SELECT count(*) INTO v_account
  FROM auth_attempt
  WHERE email = v_email
    AND outcome IN ('bad_password', 'no_such_account', 'disabled')
    AND occurred_at > now() - interval '15 minutes';

  IF p_ip IS NOT NULL THEN
    SELECT count(*) INTO v_address
    FROM auth_attempt
    WHERE ip = p_ip
      AND outcome IN ('bad_password', 'no_such_account', 'disabled')
      AND occurred_at > now() - interval '15 minutes';
  END IF;

  SELECT * INTO v_user FROM app_user WHERE email = v_email;

  IF FOUND THEN
    SELECT * INTO v_credential FROM local_credential WHERE local_credential.user_id = v_user.id;
  END IF;

  RETURN QUERY SELECT
    v_credential.user_id IS NOT NULL,
    v_user.id,
    v_credential.password_phc,
    coalesce(v_credential.must_change, false),
    v_user.disabled_at IS NOT NULL,
    v_credential.locked_until,
    -- 10 per account, 30 per address, in 15 minutes. The account limit is the
    -- tighter one because a spray against one known administrator is the
    -- likely attack; the address limit catches the spray across many accounts
    -- that per-account counters never see.
    (v_account >= 10 OR v_address >= 30),
    v_account,
    v_address;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.record_login_attempt — the ledger write, and the lockout state machine.
--
-- Called on EVERY outcome, including the ones that never reached a password
-- check. An attempt that is not recorded is an attempt the throttle cannot
-- see, so this is the single write and the caller has no variant that skips it.
--
-- The backoff is exponential and capped: 5 failures → 1 minute, then doubling
-- to a 15-minute ceiling. It never becomes permanent, deliberately — see the
-- note on local_credential.locked_until.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_login_attempt(
  p_email      text,
  p_user_id    uuid,
  p_outcome    text,
  p_ip         inet DEFAULT NULL,
  p_user_agent text DEFAULT NULL
) RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_failures   integer;
  v_lock_until timestamptz := NULL;
BEGIN
  INSERT INTO auth_attempt (email, user_id, ip, outcome, user_agent)
  VALUES (lower(btrim(p_email))::citext, p_user_id, p_ip, p_outcome, left(p_user_agent, 500));

  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_outcome = 'success' THEN
    UPDATE local_credential
    SET failed_attempts = 0, locked_until = NULL, last_success_at = now()
    WHERE user_id = p_user_id;
    RETURN NULL;
  END IF;

  -- ONLY a wrong password advances the lockout. An attempt made while the
  -- account is already locked is recorded above but must not re-arm the lock:
  -- if it did, anyone who knows an address could hold that account out forever
  -- by knocking every few seconds, which is a denial of service against
  -- precisely the break-glass account this feature exists to protect.
  IF p_outcome <> 'bad_password' THEN
    RETURN NULL;
  END IF;

  UPDATE local_credential
  SET failed_attempts = failed_attempts + 1, last_failure_at = now()
  WHERE user_id = p_user_id
  RETURNING failed_attempts INTO v_failures;

  IF v_failures IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_failures >= 5 THEN
    -- 5 → 1 min, 6 → 2, 7 → 4, 8 → 8, 9+ → 15 (capped).
    v_lock_until := now() + least(
      make_interval(mins => (2 ^ least(v_failures - 5, 4))::integer),
      interval '15 minutes'
    );

    UPDATE local_credential SET locked_until = v_lock_until WHERE user_id = p_user_id;
  END IF;

  RETURN v_lock_until;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.set_local_password — the only way a password is written.
--
-- Takes an already-hashed PHC string; this function never sees a plaintext
-- password and has no way to produce one. It enforces the parts that belong in
-- the database: history retention, clearing the lockout, invalidating
-- outstanding reset tokens, and the audit row.
--
-- Reuse is checked in the APPLICATION, by verifying the candidate against each
-- stored PHC — the salts differ, so no comparison here could do it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.set_local_password(
  p_user_id      uuid,
  p_password_phc text,
  p_must_change  boolean DEFAULT false,
  p_set_by       uuid DEFAULT NULL,
  p_reason       text DEFAULT NULL
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_existing text;
  v_history  text[];
BEGIN
  IF p_password_phc !~ '^\$argon2(id|i|d)\$' THEN
    RAISE EXCEPTION 'helm: password must be an argon2 PHC string'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT password_phc, previous_phc INTO v_existing, v_history
  FROM local_credential WHERE user_id = p_user_id;

  IF v_existing IS NOT NULL THEN
    -- Newest first, capped at five. Enough that a forced rotation cannot be
    -- satisfied by cycling back within a session; not so many that the table
    -- becomes a corpus of that person's password habits.
    v_history := (ARRAY[v_existing] || coalesce(v_history, '{}'))[1:5];

    UPDATE local_credential
    SET password_phc = p_password_phc,
        algorithm = 'argon2id',
        previous_phc = v_history,
        password_changed_at = now(),
        must_change = p_must_change,
        failed_attempts = 0,
        locked_until = NULL
    WHERE user_id = p_user_id;
  ELSE
    INSERT INTO local_credential (user_id, password_phc, must_change, created_by)
    VALUES (p_user_id, p_password_phc, p_must_change, p_set_by);
  END IF;

  -- Any outstanding reset token is now moot. Leaving one live would mean a
  -- code read down the phone yesterday still works after today's change.
  UPDATE password_reset
  SET invalidated_at = now()
  WHERE user_id = p_user_id AND used_at IS NULL AND invalidated_at IS NULL;

  -- Audited into the tenant's chain when there is a context (a user changing
  -- their own password while signed in). A reset redemption has no context and
  -- is recorded in auth_attempt only — the chain is per tenant, and a password
  -- is a deployment-level fact about a person, not a tenant-level one.
  IF helm.current_tenant_id() IS NOT NULL THEN
    PERFORM helm.audit(
      'auth.password_changed', 'app_user', p_user_id, 'success'::audit_outcome,
      NULL, NULL, p_reason,
      jsonb_build_object(
        'must_change', p_must_change,
        'set_by_other', p_set_by IS DISTINCT FROM p_user_id));
  END IF;

  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.issue_password_reset — mint a single-use token.
--
-- Returns the reset row id and nothing else; the token itself is generated by
-- the application and only its digest arrives here. Any outstanding token for
-- the same user is invalidated, so "request a reset five times and use the
-- first one" does not work.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.issue_password_reset(
  p_user_id      uuid,
  p_token_sha256 bytea,
  p_origin       text,
  p_ttl_minutes  integer DEFAULT 60,
  p_issued_by    uuid DEFAULT NULL,
  p_ip           inet DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_id  uuid;
  v_ttl integer := least(greatest(coalesce(p_ttl_minutes, 60), 5), 1440);
BEGIN
  IF p_origin NOT IN ('self', 'admin') THEN
    RAISE EXCEPTION 'helm: unknown reset origin %', p_origin
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE password_reset
  SET invalidated_at = now()
  WHERE user_id = p_user_id AND used_at IS NULL AND invalidated_at IS NULL;

  INSERT INTO password_reset (user_id, token_sha256, origin, issued_by, expires_at, created_ip)
  VALUES (p_user_id, p_token_sha256, p_origin, p_issued_by,
          now() + make_interval(mins => v_ttl), p_ip)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.peek_password_reset — whose token is this, without spending it.
--
-- Exists so the application can validate the new password BEFORE the token is
-- consumed. Getting that order wrong is not a small bug: somebody who mistypes
-- their new password would burn the code AND lose every session they had, which
-- leaves them locked out holding a spent reset — during the outage this whole
-- feature exists for.
--
-- Reads nothing else and writes nothing. It does not weaken the single-use
-- guarantee, which is redeem_password_reset's atomic UPDATE, not anything here:
-- a token peeked and then redeemed by somebody else in between simply fails at
-- the redeem.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.peek_password_reset(p_token_sha256 bytea)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT user_id FROM password_reset
  WHERE token_sha256 = p_token_sha256
    AND used_at IS NULL
    AND invalidated_at IS NULL
    AND expires_at > now();
$$;

-- -----------------------------------------------------------------------------
-- helm.redeem_password_reset — consume a token, once.
--
-- The single-use guarantee is an UPDATE with `used_at IS NULL` in its
-- predicate, so two simultaneous redemptions of the same token result in one
-- winner and one refusal, decided by the database rather than by a
-- check-then-act in the application.
--
-- Returns the user id on success and NULL on any failure, without saying which
-- failure. A response that distinguished "expired" from "already used" from
-- "never existed" would tell the holder of a leaked token which of those it is.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.redeem_password_reset(p_token_sha256 bytea)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  UPDATE password_reset
  SET used_at = now()
  WHERE token_sha256 = p_token_sha256
    AND used_at IS NULL
    AND invalidated_at IS NULL
    AND expires_at > now()
  RETURNING user_id INTO v_user_id;

  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- A reset is a takeover of the account by whoever holds the token. Every
  -- existing session must die: otherwise a stolen laptop with a live session
  -- survives the password change that was meant to lock it out.
  DELETE FROM auth_session WHERE user_id = v_user_id;

  RETURN v_user_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.create_local_session — a database session, identical to an SSO one.
--
-- Auth.js cannot do this itself: its Credentials provider forces JWT sessions,
-- and a JWT cannot be revoked before it expires. "This technician left, cut
-- their access now" is a routine MSP event, so local sign-in writes the same
-- auth_session row the Entra adapter writes and both revoke the same way.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.create_local_session(
  p_user_id       uuid,
  p_session_token text,
  p_ttl_minutes   integer DEFAULT 480
) RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_expires timestamptz;
BEGIN
  IF length(coalesce(p_session_token, '')) < 32 THEN
    RAISE EXCEPTION 'helm: session token is too short to be a session token'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_expires := now() + make_interval(mins => least(greatest(p_ttl_minutes, 5), 1440));

  INSERT INTO auth_session (session_token, user_id, expires)
  VALUES (p_session_token, p_user_id, v_expires);

  UPDATE app_user SET last_login_at = now() WHERE id = p_user_id;

  RETURN v_expires;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.verify_step_up_password — satisfy a step-up with the local password.
--
-- Without this, an administrator signing in locally during an identity
-- provider outage cannot reveal any secret marked requires_step_up — which is
-- exactly the set of credentials an outage is most likely to need. The
-- password check itself happens in the application; this records the result.
--
-- Runs INSIDE a tenant context, unlike everything else in this file: a step-up
-- is scoped to the tenant the person is working in.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.record_step_up(
  p_method     text,
  p_ttl_minutes integer DEFAULT 15,
  p_ip         inet DEFAULT NULL
) RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_actor   uuid := helm.current_actor_id();
  v_expires timestamptz;
BEGIN
  IF helm.current_actor_type() <> 'user' THEN
    -- Machine identities cannot perform an interactive re-authentication, and
    -- a service account that could record one would make every step-up secret
    -- reachable by automation.
    RAISE EXCEPTION 'helm: only a person may complete a step-up verification'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_expires := now() + make_interval(mins => least(greatest(p_ttl_minutes, 1), 60));

  INSERT INTO step_up_verification (tenant_id, user_id, method, expires_at, ip)
  VALUES (v_tenant, v_actor, p_method, v_expires, p_ip);

  PERFORM helm.audit('auth.step_up_verified', 'app_user', v_actor,
                     'success'::audit_outcome,
                     NULL, NULL, NULL, jsonb_build_object('method', p_method));

  RETURN v_expires;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.prune_auth_attempts — called by the worker.
--
-- auth_attempt is operational state, not audit. Keeping it forever would turn
-- a throttling counter into a permanent record of every address every person
-- ever signed in from, which is both a privacy liability and a table nobody
-- vacuums.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.prune_auth_attempts(p_keep_days integer DEFAULT 30)
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM auth_attempt
  WHERE occurred_at < now() - make_interval(days => greatest(p_keep_days, 1));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  DELETE FROM password_reset
  WHERE expires_at < now() - interval '7 days';

  RETURN v_deleted;
END;
$$;

-- -----------------------------------------------------------------------------
-- helm.clear_local_lockout — an administrator unlocks a colleague.
--
-- The lockout above is bounded at fifteen minutes, but fifteen minutes is a
-- long time during the outage this feature exists for, and the alternative
-- ("issue a reset, read the code down the phone, have them choose a new
-- password") is several minutes more. So: an administrator who holds
-- user:write can clear the counter without touching the password.
--
-- Requires a tenant context and a shared membership, so this is not a way for
-- one MSP's administrator to unlock another's account.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.clear_local_lockout(p_user_id uuid, p_reason text DEFAULT NULL)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
BEGIN
  IF NOT helm.has_permission('user:write') THEN
    RAISE EXCEPTION 'helm: clearing a lockout requires user:write'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM membership m
    WHERE m.user_id = p_user_id AND m.tenant_id = v_tenant AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'helm: that person is not a member of this tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE local_credential
  SET failed_attempts = 0, locked_until = NULL
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM helm.audit('auth.lockout_cleared', 'app_user', p_user_id,
                     'success'::audit_outcome, NULL, NULL, p_reason, '{}'::jsonb);
  RETURN true;
END;
$$;

-- =============================================================================
-- Row-level security.
--
-- These tables have no tenant_id: whether a person has a local password is a
-- deployment-level fact about that person, not a tenant-level one.
--
-- The important part of this section is the REVOKE immediately below. 0220
-- sets ALTER DEFAULT PRIVILEGES so that a table created by a later migration
-- arrives with grants rather than silently unreachable — a good default that
-- is exactly wrong here, because it would hand helm_app and helm_auditor a
-- SELECT on a column holding password hashes. Every table in this file has to
-- opt out of that safety net explicitly and then take back only what it needs.
-- =============================================================================
ALTER TABLE local_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_credential FORCE ROW LEVEL SECURITY;

ALTER TABLE auth_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_attempt FORCE ROW LEVEL SECURITY;

ALTER TABLE password_reset ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset FORCE ROW LEVEL SECURITY;

-- Undo 0220's default privileges for these three tables, including the ones
-- helm_worker inherits through its membership in helm_app.
REVOKE ALL ON local_credential, auth_attempt, password_reset
  FROM PUBLIC, helm_app, helm_auth, helm_key_admin, helm_auditor, helm_worker;
REVOKE ALL ON SEQUENCE auth_attempt_id_seq FROM PUBLIC, helm_app, helm_worker;

-- -----------------------------------------------------------------------------
-- Policies.
--
-- helm_auth is unconditional, exactly as it is on app_user in 0200: a login
-- resolves who somebody is BEFORE any tenant context exists, so there is no
-- context to scope a policy by. It runs on its own connection and holds
-- nothing on tenant data.
--
-- helm_app sees local_credential through two views and never sees a hash: the
-- column grants below stop that, and these policies stop it seeing rows
-- belonging to people outside the tenant it is working in.
-- -----------------------------------------------------------------------------
CREATE POLICY local_credential_rls_auth ON local_credential
  TO helm_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_attempt_rls_auth ON auth_attempt
  TO helm_auth USING (true) WITH CHECK (true);
CREATE POLICY password_reset_rls_auth ON password_reset
  TO helm_auth USING (true) WITH CHECK (true);

CREATE POLICY local_credential_rls_select ON local_credential FOR SELECT
  TO helm_app
  USING (
    user_id = helm.current_actor_id()
    OR (
      helm.has_permission('user:read')
      AND EXISTS (
        SELECT 1 FROM membership m
        WHERE m.user_id = local_credential.user_id
          AND m.tenant_id = helm.current_tenant_id()
          AND m.status = 'active'
      )
    )
  );

-- No policy for auth_attempt or password_reset beyond helm_auth's. They are
-- operational state: a throttling counter and a token ledger. What a compliance
-- review needs from them — that a password changed, that a reset was issued,
-- that a step-up was completed — is in the audit chain, which is immutable and
-- these two are not.

-- -----------------------------------------------------------------------------
-- Views.
--
-- security_invoker, so the policies above are what scope them. A view here is
-- not a privilege boundary; it is a column list that cannot accidentally grow
-- a hash the way `SELECT *` in application code can.
-- -----------------------------------------------------------------------------
CREATE VIEW v_my_local_credential
  WITH (security_invoker = true, security_barrier = true) AS
SELECT
  c.user_id,
  c.algorithm,
  c.password_changed_at,
  c.must_change,
  c.locked_until,
  c.failed_attempts,
  c.last_success_at,
  c.last_failure_at
FROM local_credential c
WHERE c.user_id = helm.current_actor_id();

COMMENT ON VIEW v_my_local_credential IS
  'The signed-in person''s own local credential state. Carries no hash: '
  'helm_app holds column grants that exclude password_phc and previous_phc, so '
  'the hash is unreadable through this view and through any other query.';

-- What an administrator needs before issuing a reset: who has a local password
-- at all, whether it is a must-change one an administrator set, and who is
-- currently locked out. Scoped by the policy above to the current tenant's
-- members, and to callers holding user:read.
CREATE VIEW v_local_credential_status
  WITH (security_invoker = true, security_barrier = true) AS
SELECT
  c.user_id,
  u.email,
  u.name,
  u.disabled_at IS NOT NULL AS disabled,
  c.algorithm,
  c.password_changed_at,
  c.must_change,
  c.locked_until,
  c.locked_until > now() AS locked_now,
  c.failed_attempts,
  c.last_success_at,
  c.last_failure_at,
  c.created_at,
  c.created_by
FROM local_credential c
JOIN app_user u ON u.id = c.user_id;

COMMENT ON VIEW v_local_credential_status IS
  'Local password state for the current tenant''s members, for the account '
  'administration screen. Requires user:read; carries no hash.';

-- -----------------------------------------------------------------------------
-- Grants.
--
-- helm_auth owns login, exactly as it owns the Auth.js tables — a bug in the
-- request path must not be able to read a password hash or mint a reset token.
-- helm_app gets three things a signed-in person does: read their own state,
-- change their own password, and complete a step-up.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON local_credential TO helm_auth;
GRANT SELECT, INSERT ON auth_attempt TO helm_auth;
GRANT USAGE ON SEQUENCE auth_attempt_id_seq TO helm_auth;
GRANT SELECT, INSERT, UPDATE ON password_reset TO helm_auth;

-- Column-level, and the omissions are the point: password_phc and
-- previous_phc appear in no grant to any role but helm_auth. Without this
-- grant the two views above would parse, be granted, and then fail at runtime
-- with "permission denied" — a security_invoker view over a table the invoker
-- cannot read is a view nobody can use.
GRANT SELECT (user_id, algorithm, password_changed_at, must_change,
              locked_until, failed_attempts, last_success_at, last_failure_at,
              created_at, created_by)
  ON local_credential TO helm_app;

GRANT SELECT ON v_my_local_credential, v_local_credential_status TO helm_app;

REVOKE ALL ON FUNCTION helm.local_login_challenge(text, inet) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_login_attempt(text, uuid, text, inet, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.set_local_password(uuid, text, boolean, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.issue_password_reset(uuid, bytea, text, integer, uuid, inet) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.peek_password_reset(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.redeem_password_reset(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.create_local_session(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.record_step_up(text, integer, inet) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.clear_local_lockout(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.prune_auth_attempts(integer) FROM PUBLIC;

-- The login path. helm_auth only.
GRANT EXECUTE ON FUNCTION helm.local_login_challenge(text, inet) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.record_login_attempt(text, uuid, text, inet, text) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.issue_password_reset(uuid, bytea, text, integer, uuid, inet) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.peek_password_reset(bytea) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.redeem_password_reset(bytea) TO helm_auth;
GRANT EXECUTE ON FUNCTION helm.create_local_session(uuid, text, integer) TO helm_auth;

-- Setting a password happens on the auth connection during a reset, and on the
-- app connection when a signed-in person changes their own.
GRANT EXECUTE ON FUNCTION helm.set_local_password(uuid, text, boolean, uuid, text) TO helm_auth, helm_app;

-- Step-up and unlocking are request-path actions inside a tenant context.
GRANT EXECUTE ON FUNCTION helm.record_step_up(text, integer, inet) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.clear_local_lockout(uuid, text) TO helm_app;

-- Pruning is the worker's.
GRANT EXECUTE ON FUNCTION helm.prune_auth_attempts(integer) TO helm_worker;

-- =============================================================================
-- Guards.
--
-- Two failure modes, opposite in direction, both silent without these:
--
--   too much  a role that can read password_phc turns a database dump into an
--             offline cracking target.
--   too little a security_invoker view granted to a role that holds no column
--             grant behind it. It creates cleanly, grants cleanly, and fails
--             only when somebody opens the page. Helm has shipped that defect
--             once already (v_secret_metadata, 0320); this asserts against it.
-- =============================================================================
DO $guard$
DECLARE
  v_role   text;
  v_col    text;
  v_leak   text;
BEGIN
  -- Nothing but helm_auth may reach a password hash, by any path.
  FOREACH v_role IN ARRAY ARRAY['helm_app', 'helm_key_admin', 'helm_auditor', 'helm_worker'] LOOP
    FOREACH v_col IN ARRAY ARRAY['password_phc', 'previous_phc'] LOOP
      IF has_column_privilege(v_role, 'local_credential', v_col, 'SELECT') THEN
        v_leak := coalesce(v_leak || ', ', '') || v_role || '.' || v_col;
      END IF;
    END LOOP;

    -- The throttling ledger and the reset tokens are helm_auth's alone. A
    -- readable password_reset is a list of pending account takeovers.
    IF has_table_privilege(v_role, 'auth_attempt', 'SELECT')
       OR has_table_privilege(v_role, 'password_reset', 'SELECT') THEN
      v_leak := coalesce(v_leak || ', ', '') || v_role || ' (ledger)';
    END IF;
  END LOOP;

  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'helm: local authentication state is readable by: %', v_leak;
  END IF;

  -- ...and helm_app must hold the column grants its two views need, or they
  -- are decoration.
  FOREACH v_col IN ARRAY ARRAY['user_id', 'must_change', 'locked_until',
                               'failed_attempts', 'password_changed_at'] LOOP
    IF NOT has_column_privilege('helm_app', 'local_credential', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'helm: helm_app cannot read local_credential.% — '
                      'v_my_local_credential is a security_invoker view and '
                      'would fail at runtime', v_col;
    END IF;
  END LOOP;

  -- The login functions cross the authentication boundary and must not be
  -- reachable from the request role, which is what serves untrusted input.
  IF has_function_privilege('helm_app', 'helm.local_login_challenge(text, inet)', 'EXECUTE')
     OR has_function_privilege('helm_app', 'helm.redeem_password_reset(bytea)', 'EXECUTE')
     OR has_function_privilege('helm_app', 'helm.peek_password_reset(bytea)', 'EXECUTE')
     OR has_function_privilege('helm_app', 'helm.issue_password_reset(uuid, bytea, text, integer, uuid, inet)', 'EXECUTE')
     OR has_function_privilege('helm_app', 'helm.create_local_session(uuid, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'helm: helm_app can execute the pre-context login functions';
  END IF;
END
$guard$;
